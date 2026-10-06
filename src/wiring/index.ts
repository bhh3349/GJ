// 网关适配层的出口。`src/server.ts` 只认这里，不逐个 import 内部文件。
//
// 位置说明（AGENTS.md §8）：`src/wiring/` 是 `src/gateway`（内核）与 `src/db`（存储）
// 之间的接线层，本身不属于任何一侧 —— 内核不许 import db，db 也不该知道内核的端口长什么样。

export { createDbGatewayAuth } from './auth.js';
export { createGatewayStore } from './store.js';
export type { GatewayStore, GatewayStoreOptions } from './store.js';
export { createSecretResolver } from './secrets.js';
export type { DbSecretResolver, SecretRow, SecretResolverOptions } from './secrets.js';
export { createUsageLogSink } from './usage-sink.js';
export type { UsageSink, UsageSinkOptions } from './usage-sink.js';
export { createErrorEventSink, deriveCategory, deriveSeverity } from './error-event-sink.js';
export type {
  BufferedErrorEventSink,
  ErrorEventSinkOptions,
} from './error-event-sink.js';
export { createKeyRuntimeFlusher } from './key-runtime-flusher.js';
export type { KeyPoolView, KeyRuntimeFlusher, KeyRuntimeFlusherOptions } from './key-runtime-flusher.js';
export { createGatewayRuntime, mountGatewayRoutes } from './runtime.js';
export type { GatewayRuntime, GatewayRuntimeOptions } from './runtime.js';
export { createShutdownHandler } from './shutdown.js';
export type {
  AsyncClosable,
  ShutdownLog,
  ShutdownTarget,
  SyncClosable,
} from './shutdown.js';
export { createAssistantInvoker, createAssistantMetrics } from './assistant-invoker.js';
export type { AssistantInvokerOptions, AssistantMetrics } from './assistant-invoker.js';
