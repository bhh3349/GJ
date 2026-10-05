/**
 * 网关内核 - 模块出口
 * 对外只暴露冻结面（KeyPool 三函数）与只读类型；内部面按需从具体文件引入。
 */

export { createKeyPool } from './key-pool.js';
export type { KeyPool, KeyPoolInternal, PoolAlert } from './key-pool.js';
export {
  MAX_COOLDOWN_MS,
  NETWORK_BASE_MS,
  RATE_LIMITED_DEFAULT_MS,
  UPSTREAM_ERROR_BASE_MS,
  LONG_COOLDOWN_MS,
  reasonBaseCooldownMs,
  ladderCooldownMs,
  nextCooldownMs,
} from './cooldown.js';
export type {
  FailureReason,
  KeyCandidate,
  KeyCategory,
  KeyConfig,
  KeyRuntimeState,
  KeyStatus,
  PoolOptions,
  PoolSnapshot,
  ReportFailureOptions,
  TokenUsage,
  UpstreamConfig,
} from './types.js';
