/**
 * 验收 §九.2 故障切换 —— 四类故障演练客户端无感 + 首字节前切换 P99<100ms
 * 依据：docs/需求文档-v1.1.md §九.2、docs/dev-constraints.md §六（`pnpm test:fault` 语义）
 *
 * 与 engine.spec.ts 的分工：engine.spec 盯「正确性」（换不换、记不记失败、冷却对不对）；
 * 本文件盯「验收判据」（客户端是否可见错误、切换耗时是否进预算）。同一套桩，两种读法。
 *
 * 四类故障 → 引擎行为（classify.ts）：
 *   401        → AUTH_INVALID（长冷却 30min，可自动禁用）
 *   429        → RATE_LIMITED（尊重上游 Retry-After）
 *   超时       → NETWORK（首字节超时 abort）
 *   进程 kill  → NETWORK（上游进程被 kill，连接重置 = fetch reject）
 * 四者都发生在「首字节前」，引擎应静默换下一把 key，客户端只看到最终 200 —— 即「无感」。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { createGatewayEngine } from './engine.js';
import type { FetchLike } from './engine.js';
import { createKeyPool } from './key-pool.js';
import type { KeyPoolInternal } from './key-pool.js';
import type { GroupContext, ModelCatalog, SecretResolver, UpstreamTarget } from './ports.js';
import type { KeyConfig, PoolSnapshot } from './types.js';

/* ------------------------------ 测试台 ------------------------------ */

const GROUP: GroupContext = { groupId: 'grp_fault', name: '故障演练', enabled: true, rpm: null, tpm: null, dailyQuota: null };

let clock = 1_700_000_000_000;
const now = (): number => clock;

function keyConfig(keyId: string, upstreamId = 'up1', over: Partial<KeyConfig> = {}): KeyConfig {
  return {
    keyId,
    upstreamId,
    category: 'balance',
    status: 'enabled',
    weight: 1,
    models: null,
    balanceCents: 10_000,
    tokenPlanRemainingTokens: null,
    tokenPlanExpiresAt: null,
    ...over,
  };
}

function snapshot(keys: KeyConfig[], upstreams: PoolSnapshot['upstreams'] = [{ upstreamId: 'up1', enabled: true, models: null }]): PoolSnapshot {
  return { revision: 1, upstreams, keys };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const OK = (): Response => jsonResponse({ id: 'cmpl_fault', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

/** 单步上游桩：可同步返回 Response，也可 reject（超时/进程 kill）或返回 Promise */
type Step = (url: string, init: RequestInit) => Response | Promise<Response>;

function makeHarness(keys: KeyConfig[], steps: Step | Step[], upstreams?: PoolSnapshot['upstreams']) {
  clock = 1_700_000_000_000;
  const pool: KeyPoolInternal = createKeyPool({ now });
  pool.applySnapshot(snapshot(keys, upstreams));
  const secrets: SecretResolver = {
    resolve: (keyId) => {
      const found = keys.find((k) => k.keyId === keyId);
      if (found === undefined) return null;
      const target: UpstreamTarget = { upstreamId: found.upstreamId, baseUrl: `https://${found.upstreamId}.example.com/v1`, apiKey: `sk-${keyId}` };
      return target;
    },
  };
  const models: ModelCatalog = { listEnabledModels: async () => [], resolveUpstreamModel: (m) => m };
  const fetchImpl: FetchLike = async (_u, _i) => {
    const step = Array.isArray(steps) ? steps.shift() : steps;
    if (step === undefined) throw new Error('unexpected extra fetch call');
    return step(_u, _i);
  };
  const engine = createGatewayEngine({ pool, secrets, models, fetchImpl, now });
  return { pool, engine };
}

function runtimeOf(pool: KeyPoolInternal, keyId: string) {
  const rt = pool.view().find((r) => r.keyId === keyId);
  assert.ok(rt !== undefined, `key ${keyId} 不在运行态里`);
  return rt;
}

const chat = (engine: ReturnType<typeof createGatewayEngine>) => engine.chatCompletions({ group: GROUP, model: 'gpt-4o', body: { messages: [] }, stream: false });

/** 百分位（linear interpolation） */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo] ?? 0;
  return (sorted[lo] ?? 0) + ((sorted[hi] ?? 0) - (sorted[lo] ?? 0)) * (idx - lo);
}

/* ------------------------------ 四类故障演练 ------------------------------ */

describe('验收 §九.2：四类故障演练客户端无感', () => {
  it('401 → 静默换下一把，客户端只看到 200（AUTH_INVALID 长冷却）', async () => {
    const h = makeHarness(
      [keyConfig('k1', 'up1', { weight: 2 }), keyConfig('k2', 'up2', { weight: 1 })],
      [
        () => jsonResponse({ error: { message: 'bad key', type: 'authentication_error' } }, 401),
        OK,
      ],
      [
        { upstreamId: 'up1', enabled: true, models: null },
        { upstreamId: 'up2', enabled: true, models: null },
      ],
    );

    const result = await chat(h.engine);
    assert.equal(result.kind, 'json', '客户端不可见错误（result.kind !== error）');
    if (result.kind !== 'json') return;
    assert.equal(result.status, 200);
    assert.equal(result.keyId, 'k2');
    assert.equal(result.attempts, 2);
    assert.equal(runtimeOf(h.pool, 'k1').lastFailureReason, 'AUTH_INVALID');
    assert.ok((runtimeOf(h.pool, 'k1').cooldownUntil ?? 0) > 0, '401 进长冷却');
  });

  it('429 → 尊重 Retry-After 并换下一把，客户端 200', async () => {
    const h = makeHarness(
      [keyConfig('k1', 'up1', { weight: 2 }), keyConfig('k2', 'up2', { weight: 1 })],
      [() => jsonResponse({ error: { message: 'slow down' } }, 429, { 'retry-after': '120' }), OK],
      [
        { upstreamId: 'up1', enabled: true, models: null },
        { upstreamId: 'up2', enabled: true, models: null },
      ],
    );

    const result = await chat(h.engine);
    assert.equal(result.kind, 'json');
    if (result.kind !== 'json') return;
    assert.equal(result.status, 200);
    assert.equal(result.keyId, 'k2');
    assert.equal(runtimeOf(h.pool, 'k1').lastFailureReason, 'RATE_LIMITED');
    assert.equal((runtimeOf(h.pool, 'k1').cooldownUntil ?? 0) - clock, 120_000, '429 冷却取 Retry-After 120s');
  });

  it('超时 → 按 NETWORK 换下一把，客户端 200', async () => {
    const h = makeHarness(
      [keyConfig('k1', 'up1', { weight: 2 }), keyConfig('k2', 'up2', { weight: 1 })],
      [() => Promise.reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), OK],
      [
        { upstreamId: 'up1', enabled: true, models: null },
        { upstreamId: 'up2', enabled: true, models: null },
      ],
    );

    const result = await chat(h.engine);
    assert.equal(result.kind, 'json');
    if (result.kind !== 'json') return;
    assert.equal(result.status, 200);
    assert.equal(result.keyId, 'k2');
    assert.equal(runtimeOf(h.pool, 'k1').lastFailureReason, 'NETWORK');
  });

  it('进程 kill（连接重置，fetch reject）→ 按 NETWORK 换下一把，客户端 200', async () => {
    // 上游进程被 kill：TCP 连接被重置，undici 表现为 fetch reject（TypeError: fetch failed / ECONNRESET）
    const h = makeHarness(
      [keyConfig('k1', 'up1', { weight: 2 }), keyConfig('k2', 'up2', { weight: 1 })],
      [
        () => Promise.reject(new TypeError('fetch failed', { cause: new Error('ECONNRESET') })),
        OK,
      ],
      [
        { upstreamId: 'up1', enabled: true, models: null },
        { upstreamId: 'up2', enabled: true, models: null },
      ],
    );

    const result = await chat(h.engine);
    assert.equal(result.kind, 'json');
    if (result.kind !== 'json') return;
    assert.equal(result.status, 200, '客户端无感：进程 kill 后仍拿到 200');
    assert.equal(result.keyId, 'k2');
    assert.equal(runtimeOf(h.pool, 'k1').lastFailureReason, 'NETWORK');
    assert.equal(runtimeOf(h.pool, 'k1').consecutiveFails, 1);
  });
});

describe('验收 §九.2：人为禁用 1 key，后续请求 0 客户端可见错误', () => {
  it('禁用 k1 后，流量透明转移到 k2，0 次错误', async () => {
    const h = makeHarness([keyConfig('k1', 'up1', { weight: 2 }), keyConfig('k2', 'up1', { weight: 1 })], OK);

    // 禁用前：k1（权重高）先服务
    const before = await chat(h.engine);
    assert.equal(before.kind, 'json');
    if (before.kind === 'json') assert.equal(before.keyId, 'k1');

    // 人为禁用 k1：新快照里 k1 置 disabled
    h.pool.applySnapshot(snapshot([keyConfig('k1', 'up1', { weight: 2, status: 'disabled' }), keyConfig('k2', 'up1', { weight: 1 })]));

    for (let i = 0; i < 10; i += 1) {
      const r = await chat(h.engine);
      assert.equal(r.kind, 'json', `第 ${i + 1} 次请求不得出现客户端可见错误`);
      if (r.kind !== 'json') continue;
      assert.equal(r.status, 200);
      assert.equal(r.keyId, 'k2', '禁用后所有流量都应落在健康 key k2 上');
    }
    assert.equal(runtimeOf(h.pool, 'k2').consecutiveFails, 0, 'k2 全程健康，无失败');
  });
});

describe('验收 §九.2：首字节前切换 P99 < 100ms', () => {
  it('首把 key 首字节前失败 → 切换耗时 P99 < 100ms（多次采样）', async () => {
    // 每次采样用全新池/引擎：k1（权重 2）先被选、必失败，k2 兜底成功。
    // 量的是引擎「检测失败 + 重新派发」这一段（上游错误响应本身不含在预算内 ——
    // 那是上游的耗时，不是网关的切换耗时）。
    const samples: number[] = [];
    const N = 300;

    for (let i = 0; i < N; i += 1) {
      const steps: Step[] = [() => jsonResponse({ error: { message: 'boom' } }, 500), OK];
      const h = makeHarness(
        [keyConfig('k1', 'up1', { weight: 2 }), keyConfig('k2', 'up1', { weight: 1 })],
        steps,
      );
      const t0 = performance.now();
      const r = await chat(h.engine);
      const elapsed = performance.now() - t0;
      assert.equal(r.kind, 'json', `采样 ${i} 不得出现错误`);
      if (r.kind === 'json') assert.equal(r.keyId, 'k2');
      samples.push(elapsed);
    }

    samples.sort((a, b) => a - b);
    const p50 = percentile(samples, 0.5);
    const p99 = percentile(samples, 0.99);
    // 实测见报告：即时桩下切换耗时为微秒级，P99 通常 < 2ms；100ms 是验收预算，不是实测目标。
    // eslint-disable-next-line no-console
    console.log(`[fault.spec] 首字节前切换 N=${N}  P50=${p50.toFixed(3)}ms  P99=${p99.toFixed(3)}ms  max=${samples[samples.length - 1]?.toFixed(3)}ms`);
    assert.ok(p99 < 100, `首字节前切换 P99 必须 < 100ms（实测 ${p99.toFixed(3)}ms）`);
  });
});
