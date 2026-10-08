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

import type { FailureReason } from './types.js';

/** 上游调用所需的全部材料（明文仅供本次出站请求使用） */
export interface UpstreamTarget {
  upstreamId: string;
  /** 上游 Base URL，形如 https://api.example.com（末尾斜杠可有可无） */
  baseUrl: string;
  /** ⚠️ 明文。只准写入 Authorization 头 */
  apiKey: string;
  /**
   * 本次出站走的**出口 id**（ADR-0021 决策 5 的 E 接缝）。
   *
   * 取值 = `supplier_accounts.egress_id`（Tier 2 的**稳定 id**，`egress_proxies.id`，
   *        **原样透传、不过 `egressIdOfUrl`** —— 拿它去解析一个 id 会恒得 `null`，
   *        出口被整个丢掉 = 「一个出口零个桶 ⇒ 无上限」）
   *        ?? `egressIdOfUrl(baseUrl)`（Tier 1，没指定出口的直连流量仍占同一个桶）。
   *        `null` = 连 base URL 都解析不出 host ⇒ **fail-open**（不裁决、不加桶）。
   *
   * **在快照重建时算一次**，热路径只读：改成在 `resolve()` 里现算就是每次出站多一次
   * `new URL` + 一次台账查库，TTFB 直接崩（验收 6）。
   *
   * 必填**且可空**是刻意的 —— 与 `UsageLogEntry.requestId` 同一条理由：漏传在编译期报错。
   * 漏传若退化成 `undefined`，语义上与 `null`（放行、无上限）同形，而这正是 ADR-0021 点名的事故。
   */
  egressId: string | null;
  /** 这把 key 的供应商账号归属（`supplier_account_keys.account_id`）；通用上游 / 未入池 → `null` */
  accountId: string | null;
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
  /**
   * 关联键（契约 §6「关联键 `x-request-id`」/ ADR-0014）。**必填**。
   *
   * 值来自同一次请求：入站头合法则沿用，否则在入站处重新生成（`src/util/request-id.ts`）。
   * 必填是刻意的 —— 漏传在编译期就报错，而不是上线后静默写一列 NULL。
   */
  requestId: string;
  at: string; // ISO8601 UTC
}

/**
 * 网关错误事件出口（契约 §12.1 / ADR-0013 §7）。签名由 ADR-0013 冻结。
 *
 * 与 `UsageLogSink` 的差别：用量是**每请求一条**，错误事件只在这条请求**失败**时产生，
 * 所以它是稀疏的 —— 但热路径纪律一模一样：`record()` 只入队，不落库、不 await。
 *
 * `category`（分型）与 `severity` **刻意不由网关传**：它们由实现侧按契约 §12.1 的映射表
 * 从 `gatewayCode` + `status` 派生。映射只有一个实现处，网关不需要理解分型概念，
 * 也就不会与契约漂移 —— 这是本端口最省事也最不容易出错的一点。
 */
export interface ErrorEventSink {
  record(entry: ErrorEventEntry): void;
}

export interface ErrorEventEntry {
  /** ISO8601 UTC，**网关侧时刻**；落库不重打时间 */
  at: string;
  /** 回给客户端的 HTTP 状态；客户端中途断开写 499（只存在于事件流，契约 §12.1） */
  status: number;
  /** 契约 §10 的码；网关自身未预期异常传 null → 实现侧归入 INTERNAL */
  gatewayCode: string | null;
  /** 与 key_runtime.last_failure_reason 同一套枚举；未触达上游传 null */
  failureReason: FailureReason | null;
  endpoint: string;
  /** 客户端请求的模型名；无模型概念（如 /v1/models）传 null */
  clientModel: string | null;
  /** 空串 = 「没有某把具体 key」可言（与 UsageLogEntry 同约定），实现侧转 null */
  keyId: string;
  /** 空串 = 同上 */
  upstreamId: string;
  stream: boolean;
  /** 上游返回的原始状态码；一次都没打到上游传 null */
  upstreamStatus: number | null;
  /** **真实**上游尝试次数；0 = 一次都没发出去（配置/密文侧问题的判据） */
  attempts: number;
  /** 本次候选 key 数；不适用传 null */
  candidates: number | null;
  latencyMs: number | null;
  /**
   * 关联键（契约 §6 / ADR-0014）。**必填**，与同一请求的 `usage_logs.request_id` 同值。
   *
   * 0 次真实尝试的两条终态（`429` 池饱和 / `503` 密文不可解，ADR-0011）**同样要传** ——
   * 那两条上游侧没有任何痕迹，这个键是唯一能把它们和产生它的那次调用对上的东西。
   */
  requestId: string;
  /**
   * 人类可读归因，可含上游原文。**实现侧负责脱敏与截断**（契约 §12.1），
   * 网关侧不要先自己抹 —— 两处都抹并不更安全，但两处规则不一致就会漏。
   */
  message: string | null;
}
