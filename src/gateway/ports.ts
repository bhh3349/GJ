/**
 * 网关内核 - 对外依赖的「端口」
 * 冻结依据：AGENTS.md §8 架构边界（src/gateway 不得 import src/db / src/api）
 *
 * 为什么是接口而不是直接调 DB：
 *   1. 架构边界：跨边界实现由管家侧提供，网关只声明「我需要什么」
 *   2. 热路径零同步 DB 写：实现必须是**内存读**（解密后的 key 走进程内缓存，
 *      由 change_log / 1s 轮询刷新），端口签名刻意设计成同步，把异步挡在实现侧
 *   3. 可测：单测注入桩实现，不碰真库
 *
 * key 明文纪律：`UpstreamTarget.apiKey` 是本进程内唯一的明文出口，
 * 只允许进 Authorization 头；禁止进日志、错误体、异常 message、任何落盘路径。
 */

/** 上游调用所需的全部材料（明文仅供本次出站请求使用） */
export interface UpstreamTarget {
  upstreamId: string;
  /** 上游 Base URL，形如 https://api.example.com（末尾斜杠可有可无） */
  baseUrl: string;
  /** ⚠️ 明文。只准写入 Authorization 头 */
  apiKey: string;
}

/** keyId → 出站材料；命中不到（密文缺失/已删）返回 null，由引擎跳过该 key */
export interface SecretResolver {
  resolve(keyId: string): UpstreamTarget | null;
}

/** 模型档案只读视图：`GET /v1/models` 必须与「已启用」集合逐项 0 差异（验收 4） */
export interface ModelCatalog {
  /** 已启用模型档案的客户端可见名（含别名映射的目标名由上游侧解析） */
  listEnabledModels(): Promise<ModelDescriptor[]>;
  /** 客户端模型名 → 上游真实模型名；未登记则原样透传 */
  resolveUpstreamModel(clientModel: string): string;
}

export interface ModelDescriptor {
  id: string;
  /** 建档时间 ISO8601 UTC */
  createdAt: string;
  /** 归属，默认取上游名；仅用于 /v1/models 的 owned_by 字段 */
  ownedBy: string;
}

/** 用户组配额（契约 §4 Group 对象；null = 不限） */
export interface GroupContext {
  groupId: string;
  name: string;
  enabled: boolean;
  rpm: number | null;
  tpm: number | null;
  dailyQuota: number | null;
}

/** 网关 key 明文 → 用户组上下文；未命中返回 null（实现侧用 sha256 摘要比对） */
export interface GatewayAuth {
  authenticate(gatewayKey: string): Promise<GroupContext | null>;
}

/**
 * 用量/调用日志出口。
 * 硬要求：`record()` 只做入队，**不得 await 落库**，否则 TTFB 被日志抖动（验收 8）。
 * 返回 Promise 是为了让实现能表达「队列满反压」，引擎不会 await 它。
 */
export interface UsageLogSink {
  record(entry: UsageLogEntry): void;
}

export interface UsageLogEntry {
  groupId: string;
  keyId: string;
  upstreamId: string;
  model: string;
  /** 客户端请求的模型名（可能与上游真实名不同） */
  clientModel: string;
  endpoint: string;
  stream: boolean;
  statusCode: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  isEstimated: boolean;
  /** 首字节耗时（ms） */
  ttfbMs: number;
  latencyMs: number;
  attempts: number;
  /** 失败原因（成功为 null） */
  failureReason: string | null;
  at: string; // ISO8601 UTC
}
