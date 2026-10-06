/**
 * 网关内核 - TTFB 增量基准（§九.3 / §8 验收证据）
 * 冻结依据：docs/dev-constraints.md §六（`pnpm bench:ttfb` 语义）、docs/需求文档-v1.1.md §九.3
 *
 * 测量口径（性能类验收必须报「同机直连对比」，不接受只有绝对值）：
 *   - 直连：client ──fetch──▶ mock upstream，量「发出请求 → 收到响应头」这段 TTFB
 *   - 经网关：client ──fetch──▶ Fastify gateway（真实 engine + 真实 key pool）──▶ mock upstream
 *   - 增量：每一轮配对采样 delta = gateway TTFB − direct TTFB，对 delta 分布取 P50/P99
 *
 * mock upstream 故意注入 20ms 固定延迟，把 TTFB 抬到可测、可复现的量级：
 * 没有它，全链路 TTFB 是微秒级噪声，增量反而被事件循环抖动淹没，测不出「网关自身开销」。
 *
 * 判据（§8 冻结阈值，比 §九.3 的「P50 < 5ms」更严）：
 *   ΔP50 ≤ 1ms 且 ΔP99 ≤ 5ms → exit 0；任一不满足 → exit 1
 *
 * 运行：pnpm bench:ttfb
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import Fastify from 'fastify';

import { createGatewayStack, gatewayRoutes } from '../src/gateway/index.js';
import type {
  GatewayAuth,
  GroupContext,
  KeyConfig,
  ModelCatalog,
  PoolSnapshot,
  SecretResolver,
  UpstreamTarget,
} from '../src/gateway/index.js';

/* ------------------------------ 参数 ------------------------------ */

/** mock 上游固定延迟（ms）：把 TTFB 抬到可测量级，别改成 0 */
const UPSTREAM_DELAY_MS = 20;
/** 采样轮数：每轮一次直连 + 一次经网关（配对），400 轮足够把 P99 压稳 */
const ROUNDS = 400;
/** 正式采样前的热身请求数：吃满连接复用、逼 JIT 与 Fastify 路由缓存热起来 */
const WARMUP = 20;

/* ------------------------------ 桩 ------------------------------ */

const GROUP: GroupContext = {
  groupId: 'grp_bench',
  name: 'TTFB 基准',
  enabled: true,
  rpm: null,
  tpm: null,
  dailyQuota: null,
};

const auth: GatewayAuth = {
  async authenticate(): Promise<GroupContext> {
    return GROUP;
  },
};

/* ------------------------------ 小工具 ------------------------------ */

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve(port);
    });
  });
}

/** 百分位（linear interpolation） */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo] ?? 0;
  return (sorted[lo] ?? 0) + ((sorted[hi] ?? 0) - (sorted[lo] ?? 0)) * (idx - lo);
}

function fmt(v: number): string {
  return v.toFixed(3);
}

/* ------------------------------ mock 上游 ------------------------------ */

function mockUpstream(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const body: unknown = {
      id: 'cmpl_bench',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    };
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(JSON.stringify(body).length) });
      res.end(JSON.stringify(body));
    }, UPSTREAM_DELAY_MS);
  });
  return listen(server).then((port) => ({
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }));
}

/* ------------------------------ 网关 ------------------------------ */

function keyConfig(upstreamId: string): KeyConfig {
  return {
    keyId: 'k1',
    upstreamId,
    category: 'balance',
    status: 'enabled',
    weight: 1,
    models: null,
    balanceCents: null,
    tokenPlanRemainingTokens: null,
    tokenPlanExpiresAt: null,
  };
}

function snapshot(upstreamId: string): PoolSnapshot {
  return {
    revision: 1,
    upstreams: [{ upstreamId, enabled: true, models: null }],
    keys: [keyConfig(upstreamId)],
  };
}

async function buildGateway(upstreamBase: string): Promise<{ port: number; close: () => Promise<void> }> {
  const secrets: SecretResolver = {
    resolve(): UpstreamTarget {
      return { upstreamId: 'up1', baseUrl: upstreamBase, apiKey: 'sk-bench' };
    },
  };
  const models: ModelCatalog = {
    listEnabledModels: async () => [],
    resolveUpstreamModel: (m) => m,
  };

  const stack = createGatewayStack({ secrets, models, auth });
  stack.pool.applySnapshot(snapshot('up1'));

  const app = Fastify({ logger: false });
  await app.register(gatewayRoutes, stack.routes);
  // listen({ port: 0 }) 让 OS 挑空闲端口；Fastify 的 listen resolve 值是 URL 字符串，
  // 要拿到端口得读底层 http server 的 address()
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;

  return { port, close: () => app.close() };
}

/* ------------------------------ 测量 ------------------------------ */

const BODY = JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
const HEADERS = { 'content-type': 'application/json', authorization: 'Bearer gw-test' };

async function ttfb(url: string): Promise<number> {
  const t0 = performance.now();
  const res = await fetch(url, { method: 'POST', headers: HEADERS, body: BODY });
  // fetch 在「响应头到达」时 resolve —— 这正是 TTFB 口径，与引擎 `ttfbMs = now() - started` 同源
  const ttfbMs = performance.now() - t0;
  await res.text(); // 消费 body 释放连接，让 keep-alive 复用生效
  return ttfbMs;
}

async function main(): Promise<void> {
  const upstream = await mockUpstream();
  const upstreamBase = `http://127.0.0.1:${upstream.port}/v1`;
  const directUrl = `${upstreamBase}/chat/completions`;
  const gateway = await buildGateway(upstreamBase);
  const gatewayUrl = `http://127.0.0.1:${gateway.port}/v1/chat/completions`;

  try {
    // 热身
    for (let i = 0; i < WARMUP; i += 1) {
      await ttfb(directUrl);
      await ttfb(gatewayUrl);
    }

    const direct: number[] = [];
    const via: number[] = [];
    const delta: number[] = [];
    for (let i = 0; i < ROUNDS; i += 1) {
      const d = await ttfb(directUrl);
      const g = await ttfb(gatewayUrl);
      direct.push(d);
      via.push(g);
      delta.push(g - d);
    }

    direct.sort((a, b) => a - b);
    via.sort((a, b) => a - b);
    delta.sort((a, b) => a - b);

    const dP50 = percentile(direct, 0.5);
    const dP99 = percentile(direct, 0.99);
    const gP50 = percentile(via, 0.5);
    const gP99 = percentile(via, 0.99);
    const incP50 = percentile(delta, 0.5);
    const incP99 = percentile(delta, 0.99);

    // eslint-disable-next-line no-console
    console.log(
      [
        `[bench:ttfb] 同机直连 vs 经网关  ROUNDS=${ROUNDS}  upstream_delay=${UPSTREAM_DELAY_MS}ms`,
        `  直连   P50=${fmt(dP50)}ms  P99=${fmt(dP99)}ms`,
        `  经网关 P50=${fmt(gP50)}ms  P99=${fmt(gP99)}ms`,
        `  增量   P50=${fmt(incP50)}ms  P99=${fmt(incP99)}ms  (Δ = gateway − direct)`,
      ].join('\n'),
    );

    const passP50 = incP50 <= 1;
    const passP99 = incP99 <= 5;
    const pass = passP50 && passP99;

    // eslint-disable-next-line no-console
    console.log(`[bench:ttfb] 判据 ΔP50≤1ms / ΔP99≤5ms → ${pass ? 'PASS' : 'FAIL'}`);
    if (!pass) process.exitCode = 1;
  } finally {
    await gateway.close();
    await upstream.close();
  }
}

void main();
