/**
 * 网关内核 - 模块出口
 * 对外只暴露冻结面（KeyPool 三函数）、`/v1/*` 装配件与只读类型；
 * 内部面（engine/routes/limiter）按需从具体文件引入。
 *
 * 装配方式（管家在 src/server.ts 里合流管理面时用）：
 *   const pool = createKeyPool({ ... });
 *   const engine = createGatewayEngine({ pool, secrets, models, logs });
 *   const limiter = createRateLimiter();
 *   await app.register(gatewayRoutes, { engine, auth, limiter });
 */

export { createKeyPool } from './key-pool.js';
export type { KeyPool, KeyPoolInternal, PoolAlert } from './key-pool.js';
export { createGatewayStack } from './stack.js';
export type { GatewayStack, GatewayStackOptions } from './stack.js';
export { createGatewayEngine } from './engine.js';
export type { AttemptEvent, EngineOptions, FetchLike, ForwardRequest, ForwardResult, GatewayEngine, InternalSnapshot } from './engine.js';
export { createRateLimiter } from './limiter.js';
export type { LimitCheckResult, LimitRejection, RateLimiter, RateLimiterOptions } from './limiter.js';
export { gatewayRoutes } from './routes.js';
export type { GatewayRoutesOptions } from './routes.js';
export {
  GATEWAY_ERROR_CODES,
  GatewayError,
  noAvailableKeyError,
  openAIError,
  unauthorizedError,
  unsupportedEndpointError,
  upstreamError,
  poolMisconfiguredError,
  poolSaturatedError,
  POOL_SATURATED_RETRY_AFTER_SEC,
} from './errors.js';
export type { GatewayErrorCode, GatewayErrorType, OpenAIErrorBody, OpenAIErrorPayload } from './errors.js';
export { classifyUpstreamStatus, parseRetryAfter } from './classify.js';
export { createStreamUsageTracker, estimatePromptTokens, estimateTokens, extractUsage, resolveUsage } from './usage.js';
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
export type {
  GatewayAuth,
  GroupContext,
  ModelCatalog,
  ModelDescriptor,
  SecretResolver,
  UpstreamTarget,
  UsageLogEntry,
  UsageLogSink,
} from './ports.js';
