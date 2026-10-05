/**
 * 网关内核 - 公共类型
 * 冻结依据：docs/dev-constraints.md §三 / §四（M0 冻结件）
 * 纪律：本文件为纯类型，运行时不产出任何代码（Node --experimental-strip-types 下必须配 import type 使用）。
 */

/** 计入 key 失败的 5 类原因；其余情况一律不调用 reportFailure（§四） */
export type FailureReason =
  | 'AUTH_INVALID' // 401/403       → 长冷却 30min + 告警
  | 'RATE_LIMITED' // 429           → 按 Retry-After，默认 60s，指数退避
  | 'INSUFFICIENT_BALANCE' // 402   → 长冷却 + 余额告警
  | 'UPSTREAM_ERROR' // 5xx         → 短冷却 10–30s
  | 'NETWORK'; // 连接/读取超时、ECONNRESET → 短冷却 15s

/** 一次调用的 token 用量；缺失上游 usage 时按字符估算并置 isEstimated=true，仍计入 TPM/日配额 */
export interface TokenUsage {
  prompt: number; // int
  completion: number; // int
  total: number; // int
  isEstimated: boolean;
}

/** key 计费类目 */
export type KeyCategory = 'token-plan' | 'balance';

/** key 静态状态（管理端唯一可写字段，网关只读） */
export type KeyStatus = 'enabled' | 'disabled';

/** 路由候选：只含选路所需最小信息，不含 key 明文、不含密文 */
export interface KeyCandidate {
  keyId: string; // DB 主键，不用「后4位」
  upstreamId: string;
  category: KeyCategory;
  weight: number;
}

/** 上游静态配置（来自共享 SQLite 快照，只读） */
export interface UpstreamConfig {
  upstreamId: string;
  enabled: boolean;
  /** null / 空数组 = 不限制（全部模型） */
  models: readonly string[] | null;
}

/** key 静态配置（来自共享 SQLite 快照，只读；健康态不在这里，见 KeyRuntimeState） */
export interface KeyConfig {
  keyId: string;
  upstreamId: string;
  category: KeyCategory;
  status: KeyStatus;
  weight: number;
  /** 显式关联模型；null / 空数组 = 按 upstream 继承（v1.1 口径） */
  models: readonly string[] | null;
  /** 余额类 key：剩余额度（分）；null = 未知（未知 ≠ 0，仍参与选路） */
  balanceCents: number | null;
  /** token-plan 类 key：剩余 tokens；null = 未知 */
  tokenPlanRemainingTokens: number | null;
  /** token-plan 类 key：到期时间 ISO8601 UTC；null = 不过期 */
  tokenPlanExpiresAt: string | null;
  /** 每 key 并发上限，默认取 PoolOptions.defaultMaxConcurrency */
  maxConcurrency?: number;
}

/** key 运行态：唯一写入方是 KeyPool（单写者），管理端只读 */
export interface KeyRuntimeState {
  keyId: string;
  failCount: number;
  consecutiveFails: number;
  cooldownUntil: number | null; // epoch ms
  lastFailureAt: number | null; // epoch ms
  lastFailureReason: FailureReason | null;
  lastLatencyMs: number | null;
  inflight: number;
}

/** 上报失败的可选项：429 的 Retry-After 由此进入，签名向后兼容 */
export interface ReportFailureOptions {
  /** 上游 Retry-After（ms）；仅 RATE_LIMITED 时有意义 */
  retryAfterMs?: number;
}

export interface PoolOptions {
  /** 每 key 并发上限，默认 4 */
  defaultMaxConcurrency?: number;
  /** 冷却封顶，默认 30min */
  maxCooldownMs?: number;
  /** 注入时钟，便于单测；默认 Date.now */
  now?: () => number;
  /** 连续失败达到该值上报自动禁用告警（v1.1 §四.2「连续 N 次自动禁用」），默认 5 */
  autoDisableAfterConsecutiveFails?: number;
  /**
   * 用量出口：reportSuccess 内同步调用，只做入队/累加，落库由引擎异步刷写。
   * 存在的意义是让 KeyPool 保持零 DB、零 await —— 热路径不因日志而抖动。
   */
  usageSink?: (keyId: string, tokens: TokenUsage, latencyMs: number) => void;
}

/** 配置快照：由 1s 轮询 / change_log 事件刷新，getAvailableKeys 只读内存，热路径零 DB */
export interface PoolSnapshot {
  revision: number;
  upstreams: readonly UpstreamConfig[];
  keys: readonly KeyConfig[];
  /** 客户端模型名 → 上游真实模型名 别名表（契约字段别名在 M3 接入） */
  modelAliases?: Readonly<Record<string, string>>;
}
