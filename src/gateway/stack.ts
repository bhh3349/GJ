/**
 * 网关内核 - 装配件
 * 冻结依据：docs/api-contract.md §10；AGENTS.md §8（src/gateway 不 import src/db / src/api）
 *
 * 为什么需要这一层：`.ts` 里 engine 与 limiter 之间有一根隐线 —— 引擎产生用量、
 * 限流器记账。这根线如果让调用方自己接，接漏了不会报错，只会「TPM 永远为 0」
 * 这种没人发现的问题。所以在这里一次接好，调用方只拿 `routes` 去 register。
 *
 * 用法（管理面合流时）：
 *   const stack = createGatewayStack({ secrets, models, auth, logs });
 *   await app.register(gatewayRoutes, stack.routes);
 */

import { createGatewayEngine } from './engine.js';
import type { EngineOptions, FetchLike, GatewayEngine } from './engine.js';
import type { EgressGate } from '../egress/port.js';
import { createKeyPool } from './key-pool.js';
import type { KeyPoolInternal } from './key-pool.js';
import { createRateLimiter } from './limiter.js';
import type { RateLimiter } from './limiter.js';
import type { ErrorEventSink, GatewayAuth, ModelCatalog, SecretResolver, UsageLogSink } from './ports.js';
import type { GatewayRoutesOptions } from './routes.js';
import type { PoolOptions } from './types.js';

export interface GatewayStackOptions {
  secrets: SecretResolver;
  models: ModelCatalog;
  auth: GatewayAuth;
  logs?: UsageLogSink;
  /**
   * 错误事件出口（契约 §12.1）。同一个 sink 同时交给引擎与路由层：
   * 引擎报**转发失败**（它才知道尝试数/哪把 key/上游状态），路由层报**被拒的请求**。
   * 在这里一次接好，调用方接漏了不会报错，只会「事件流里只有一半失败」这种没人发现的问题。
   */
  errors?: ErrorEventSink;
  /** 现成的池子（测试/外部注入）；不传则内部建一个 */
  pool?: KeyPoolInternal;
  poolOptions?: PoolOptions;
  limiter?: RateLimiter;
  fetchImpl?: FetchLike;
  now?: () => number;
  maxAttempts?: number;
  crossUpstreamRetry?: boolean;
  upstreamTimeoutMs?: number;
  internalToken?: string;
  bodyLimitBytes?: number;
  /**
   * 出口预算闸 / 冷却态（契约 §16.7，ADR-0021）。**一个进程一份** —— 出口被限流是全体请求共同的事实，
   * 在这里注入正是为了让「所有发往同一出口的请求」共用同一道冷却与同一张预算。
   * 不传 = 引擎用缺省闸（恒放行、恒判 key 级，决策 7），行为与改动前逐字节相同。
   */
  egress?: EgressGate;
}

export interface GatewayStack {
  pool: KeyPoolInternal;
  engine: GatewayEngine;
  limiter: RateLimiter;
  /** 直接交给 `app.register(gatewayRoutes, stack.routes)` */
  routes: GatewayRoutesOptions;
}

export function createGatewayStack(options: GatewayStackOptions): GatewayStack {
  const pool = options.pool ?? createKeyPool(options.poolOptions ?? {});
  const limiter = options.limiter ?? createRateLimiter(options.now === undefined ? {} : { now: options.now });

  // 显式逐项赋值：EngineOptions 的可选项在 strict 下不适合用展开语法批量塞 undefined
  const built: EngineOptions = {
    pool,
    secrets: options.secrets,
    models: options.models,
    // 引擎每次成功结算都把用量交给限流器记账（RPM 在 check 时已计，这里只补 token）
    onUsage: (event) => limiter.commitTokens(event.groupId, event.usage.total),
  };
  if (options.logs !== undefined) built.logs = options.logs;
  if (options.errors !== undefined) built.errors = options.errors;
  if (options.fetchImpl !== undefined) built.fetchImpl = options.fetchImpl;
  if (options.now !== undefined) built.now = options.now;
  if (options.maxAttempts !== undefined) built.maxAttempts = options.maxAttempts;
  if (options.crossUpstreamRetry !== undefined) built.crossUpstreamRetry = options.crossUpstreamRetry;
  if (options.upstreamTimeoutMs !== undefined) built.upstreamTimeoutMs = options.upstreamTimeoutMs;
  if (options.egress !== undefined) built.egress = options.egress;

  const engine = createGatewayEngine(built);

  const routes: GatewayRoutesOptions = { engine, auth: options.auth, limiter };
  if (options.errors !== undefined) routes.errors = options.errors;
  if (options.internalToken !== undefined) routes.internalToken = options.internalToken;
  if (options.bodyLimitBytes !== undefined) routes.bodyLimitBytes = options.bodyLimitBytes;

  return { pool, engine, limiter, routes };
}
