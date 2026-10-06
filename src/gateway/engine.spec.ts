/**
 * 转发引擎单测（M3 核心链路）
 * 依据：docs/api-contract.md §9 §10；验收 2（故障切换客户端无感知）、验收 7（四类故障演练）
 *
 * 本文件盯死四件事，每件事都对应一条会被写错的铁律：
 *   1. 首字节前才换 key —— 流一旦开始，上游再断也只能发 SSE 错误帧，绝不重放
 *   2. 只有五类失败换 key —— 400/404/422 原样透传，key 不进冷却
 *   3. 并发位零泄漏 —— 成功/失败/客户端断开三条路径都必须 endAttempt
 *   4. 客户端断开不计 key 失败 —— 用户按 ESC 不能把 key 打进冷却
 */

import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';

import { createGatewayEngine } from './engine.js';
import type { FetchLike, ForwardResult } from './engine.js';
import { createKeyPool } from './key-pool.js';
import type { KeyPoolInternal } from './key-pool.js';
import type { GroupContext, ModelCatalog, SecretResolver, UsageLogEntry, UpstreamTarget } from './ports.js';
import type { KeyConfig, PoolSnapshot } from './types.js';

/* ------------------------------ 测试台 ------------------------------ */

let clock = 1_700_000_000_000;
const now = (): number => clock;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const GROUP: GroupContext = { groupId: 'grp_1', name: '测试组', enabled: true, rpm: null, tpm: null, dailyQuota: null };

/**
 * 关联键（契约 §6 / ADR-0014）。引擎对它是**纯透传**：不生成、不校验、只往上游请求头
 * 和两条出口上带。这里没有 HTTP 层，所以给个合法常量就够了 ——
 * 真正的"入站取值 → 回写响应头 → 下传引擎"四处同值，在 `error-events.spec.ts` 里断言。
 */
const REQUEST_ID = 'req-engine-spec-0001';

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
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function textResponse(raw: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(raw, { status, headers });
}

interface Call {
  url: string;
  init: RequestInit;
}

type Script = (url: string, init: RequestInit) => Response | Promise<Response>;

function scriptedFetch(steps: Script[]): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const step = steps[index];
    index += 1;
    if (step === undefined) throw new Error(`unexpected fetch call #${index} to ${url}`);
    return step(url, init);
  };
  return { fetchImpl, calls };
}

/** 手动可控的 SSE 流：测试里决定何时推数据、何时报错 */
function controlledSse(): { response: Response; push: (text: string) => void; fail: (err: unknown) => void; close: () => void } {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    push: (text) => controller?.enqueue(encoder.encode(text)),
    fail: (err) => controller?.error(err),
    close: () => controller?.close(),
  };
}

/** 先给一块数据、下一次 read 时报错的流（模拟流中途上游断） */
function breakingSse(firstChunk: string): Response {
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads += 1;
      if (reads === 1) {
        controller.enqueue(encoder.encode(firstChunk));
        return;
      }
      controller.error(new Error('upstream connection reset'));
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let out = '';
  for (;;) {
    const result = await reader.read();
    if (result.done === true) break;
    out += decoder.decode(result.value, { stream: true });
  }
  return out;
}

function makeHarness(options: {
  keys: KeyConfig[];
  upstreams?: PoolSnapshot['upstreams'];
  steps: Script[];
  maxAttempts?: number;
  crossUpstreamRetry?: boolean;
  aliases?: Record<string, string>;
  /** 覆盖密钥解析（测「密文缺失」这类配置侧故障） */
  resolveSecret?: (keyId: string) => UpstreamTarget | null;
  /** 首字节超时（默认 120s）；测「长流不能被它掐断」时压到很小 */
  upstreamTimeoutMs?: number;
}) {
  clock = 1_700_000_000_000;
  const pool: KeyPoolInternal = createKeyPool({ now });
  pool.applySnapshot(snapshot(options.keys, options.upstreams));

  const secrets: SecretResolver = {
    resolve:
      options.resolveSecret ??
      ((keyId) => {
        const found = options.keys.find((k) => k.keyId === keyId);
        if (found === undefined) return null;
        const target: UpstreamTarget = { upstreamId: found.upstreamId, baseUrl: `https://${found.upstreamId}.example.com/v1`, apiKey: `sk-${keyId}` };
        return target;
      }),
  };

  const aliases = options.aliases ?? {};
  const models: ModelCatalog = {
    listEnabledModels: async () => [],
    resolveUpstreamModel: (m) => aliases[m] ?? m,
  };

  const logs: UsageLogEntry[] = [];
  const usages: Array<{ groupId: string; keyId: string; total: number }> = [];
  const { fetchImpl, calls } = scriptedFetch(options.steps);

  const engine = createGatewayEngine({
    pool,
    secrets,
    models,
    logs: { record: (e) => logs.push(e) },
    fetchImpl,
    now,
    onUsage: (e) => usages.push({ groupId: e.groupId, keyId: e.keyId, total: e.usage.total }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.crossUpstreamRetry === undefined ? {} : { crossUpstreamRetry: options.crossUpstreamRetry }),
    ...(options.upstreamTimeoutMs === undefined ? {} : { upstreamTimeoutMs: options.upstreamTimeoutMs }),
  });

  return { pool, engine, calls, logs, usages };
}

function chatBody(model = 'gpt-4o-mini', stream = false): Record<string, unknown> {
  return { model, messages: [{ role: 'user', content: 'hi' }], ...(stream ? { stream: true } : {}) };
}

function runtimeOf(pool: KeyPoolInternal, keyId: string) {
  const rt = pool.view().find((r) => r.keyId === keyId);
  assert.ok(rt !== undefined, `key ${keyId} 不在运行态里`);
  return rt;
}

/* ------------------------------ 用例 ------------------------------ */

describe('无可用 key', () => {
  it('返回 503 NO_AVAILABLE_KEY（OpenAI 错误体），且不发出任何上游请求', async () => {
    const h = makeHarness({ keys: [], steps: [] });
    const result = (await h.engine.chatCompletions({ group: GROUP, model: 'gpt-4o', body: chatBody('gpt-4o'), stream: false, requestId: REQUEST_ID })) as Extract<
      ForwardResult,
      { kind: 'error' }
    >;

    assert.equal(result.kind, 'error');
    assert.equal(result.error.httpStatus, 503);
    assert.equal(result.error.body.error.code, 'NO_AVAILABLE_KEY');
    assert.equal(result.error.body.error.type, 'server_error');
    assert.equal(h.calls.length, 0, '没有 key 就不该碰上游');
  });
});

describe('0 真实尝试的分型（ADR-0011：不再合流成 502 UPSTREAM_ERROR）', () => {
  /**
   * 为什么用桩池：真实池的 `isUsable` 会把满并发的 key 直接挡在候选外（→ 候选空 → 503），
   * 「候选非空但 beginAttempt 拒绝」只在并发竞态里出现 —— 引擎 getAvailableKeys 的 await
   * 让出微任务、另一路请求先把槽位占满。单测里用桩池把这一形状确定性地喂给引擎，
   * 验的是引擎收尾分型本身，与池内过滤无关。
   */
  function stubPool(candidates: Awaited<ReturnType<KeyPoolInternal['getAvailableKeys']>>, accept: (keyId: string) => boolean): KeyPoolInternal {
    const view = candidates.map((c) => ({
      keyId: c.keyId,
      failCount: 0,
      consecutiveFails: 0,
      cooldownUntil: null,
      lastFailureAt: null,
      lastFailureReason: null,
      lastLatencyMs: null,
      inflight: 0,
    }));
    return {
      getAvailableKeys: async () => candidates,
      reportFailure: () => undefined,
      reportSuccess: () => undefined,
      applySnapshot: () => undefined,
      beginAttempt: accept,
      endAttempt: () => undefined,
      view: () => view,
    };
  }

  function engineOver(pool: KeyPoolInternal, resolveSecret: (keyId: string) => UpstreamTarget | null, steps: Script[]) {
    const models: ModelCatalog = { listEnabledModels: async () => [], resolveUpstreamModel: (m) => m };
    const logs: UsageLogEntry[] = [];
    const { fetchImpl, calls } = scriptedFetch(steps);
    return {
      engine: createGatewayEngine({
        pool,
        secrets: { resolve: resolveSecret },
        models,
        logs: { record: (e) => logs.push(e) },
        fetchImpl,
        now,
      }),
      calls,
      logs,
    };
  }

  const target = (keyId: string): UpstreamTarget => ({ upstreamId: 'up1', baseUrl: 'https://up1.example.com/v1', apiKey: `sk-${keyId}` });

  it('池饱和（候选非空但并发槽位全满）→ 429 RATE_LIMITED + retry-after，而不是 502', async () => {
    const pool = stubPool([{ keyId: 'k1', upstreamId: 'up1', category: 'balance', weight: 1 }, { keyId: 'k2', upstreamId: 'up1', category: 'balance', weight: 1 }], () => false);
    const h = engineOver(pool, target, []);

    const result = await h.engine.chatCompletions({ group: GROUP, model: 'gpt-4o', body: chatBody('gpt-4o'), stream: false, requestId: REQUEST_ID });
    assert.equal(result.kind, 'error');
    if (result.kind !== 'error') return;

    assert.equal(result.error.httpStatus, 429, '本地饱和不是上游故障，绝不许 502');
    assert.equal(result.error.body.error.code, 'RATE_LIMITED');
    assert.equal(result.error.body.error.type, 'rate_limit_error');
    assert.equal(result.error.retryAfterSec, 1, '短退避：客户端 1s 后重试');
    assert.equal(h.calls.length, 0, '一个上游请求都没发过');
    assert.equal(result.attempts, 0, '错误文案里那句 all 0 attempt(s) 从此只属于真失败');
    assert.equal(h.logs[0]?.statusCode, 429, '调用日志必须记 429，按饱和归因而不是上游故障');
    assert.ok(h.logs[0]?.failureReason === null, '饱和没碰上游，不存在失败原因');
  });

  it('密文缺失（0 真实尝试、无饱和）→ 503 NO_AVAILABLE_KEY，不带 retry-after', async () => {
    const pool = stubPool([{ keyId: 'k1', upstreamId: 'up1', category: 'balance', weight: 1 }], () => true);
    const h = engineOver(pool, () => null, []);

    const result = await h.engine.chatCompletions({ group: GROUP, model: 'gpt-4o', body: chatBody('gpt-4o'), stream: false, requestId: REQUEST_ID });
    assert.equal(result.kind, 'error');
    if (result.kind !== 'error') return;

    assert.equal(result.error.httpStatus, 503);
    assert.equal(result.error.body.error.code, 'NO_AVAILABLE_KEY', '配置侧异常不新增码值，复用 NO_AVAILABLE_KEY');
    assert.ok(result.error.body.error.message.includes('1 key(s) unresolvable'));
    assert.equal(result.error.retryAfterSec, undefined, '不给客户端退避信号：重试解决不了密文缺失');
    assert.equal(h.calls.length, 0);
  });

  it('密文缺失叠加饱和 → 归配置侧 503（配置异常优先于退避语义）', async () => {
    const pool = stubPool(
      [{ keyId: 'k1', upstreamId: 'up1', category: 'balance', weight: 2 }, { keyId: 'k2', upstreamId: 'up1', category: 'balance', weight: 1 }],
      (keyId) => keyId !== 'k2', // k1 拿到槽位但解析不了；k2 满并发被拒
    );
    const h = engineOver(pool, (keyId) => (keyId === 'k1' ? null : target(keyId)), []);

    const result = await h.engine.chatCompletions({ group: GROUP, model: 'gpt-4o', body: chatBody('gpt-4o'), stream: false, requestId: REQUEST_ID });
    assert.equal(result.kind, 'error');
    if (result.kind !== 'error') return;
    assert.equal(result.error.httpStatus, 503);
    assert.equal(result.error.body.error.code, 'NO_AVAILABLE_KEY');
    assert.ok(result.error.body.error.message.includes('1 key(s) unresolvable'), '归因 message 要能指出有几把解析不了');
    assert.ok(result.error.body.error.message.includes('1 saturated'), '同时如实报有几把被并发拒了');
    assert.equal(h.calls.length, 0);
  });

  it('中间真实失败 + 尾部饱和：仍是 502（attempts>0 走既有冻结口径，不被新分支吞掉）', async () => {
    const h = makeHarness({
      keys: [keyConfig('k1'), keyConfig('k2')],
      steps: [() => textResponse('boom', 500), () => jsonResponse({ should: 'not be reached' })],
    });
    for (let i = 0; i < 4; i += 1) assert.equal(h.pool.beginAttempt('k2'), true); // k1 失败后 k2 饱和

    const result = await h.engine.chatCompletions({ group: GROUP, model: 'gpt-4o', body: chatBody('gpt-4o'), stream: false, requestId: REQUEST_ID });
    assert.equal(result.kind, 'error');
    if (result.kind !== 'error') return;
    assert.equal(h.calls.length, 1);
    assert.equal(result.error.httpStatus, 502, '真敲过上游就按五类失败口径走 502');
    assert.equal(result.error.body.error.code, 'UPSTREAM_ERROR');
    assert.equal(runtimeOf(h.pool, 'k1').lastFailureReason, 'UPSTREAM_ERROR');
  });
});

describe('首字节前换 key（验收 2 / 7）', () => {
  it('首把 401 → 静默换第二把，客户端只看到 200', async () => {
    const h = makeHarness({
      keys: [keyConfig('k1', 'up1', { weight: 2 }), keyConfig('k2', 'up2', { weight: 1 })],
      upstreams: [
        { upstreamId: 'up1', enabled: true, models: null },
        { upstreamId: 'up2', enabled: true, models: null },
      ],
      steps: [
        () => jsonResponse({ error: { message: 'bad key', type: 'authentication_error', code: 'invalid_api_key' } }, 401),
        () => jsonResponse({ id: 'cmpl_1', choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }),
      ],
    });

    const result = await h.engine.chatCompletions({ group: GROUP, model: 'gpt-4o', body: chatBody('gpt-4o'), stream: false, requestId: REQUEST_ID });
    assert.equal(result.kind, 'json');
    if (result.kind !== 'json') return;

    assert.equal(result.status, 200);
    assert.equal(result.keyId, 'k2', '客户端看不到切换发生');
    assert.equal(result.attempts, 2);
    assert.equal(result.usage.total, 7);

    const k1 = runtimeOf(h.pool, 'k1');
    assert.equal(k1.consecutiveFails, 1);
    assert.ok((k1.cooldownUntil ?? 0) > clock, '401 必须进长冷却');
    assert.equal(runtimeOf(h.pool, 'k2').consecutiveFails, 0);
  });

  it('连 500 换到第三把成功；每把都计入失败计数', async () => {
    const h = makeHarness({
      keys: [keyConfig('k1', 'up1', { weight: 3 }), keyConfig('k2', 'up1', { weight: 2 }), keyConfig('k3', 'up1', { weight: 1 })],
      steps: [
        () => textResponse('upstream boom', 500),
        () => textResponse('upstream boom', 502),
        () => jsonResponse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      ],
    });

    const result = await h.engine.chatCompletions({ group: GROUP, model: 'gpt-4o', body: chatBody('gpt-4o'), stream: false, requestId: REQUEST_ID });
    assert.equal(result.kind, 'json');
    if (result.kind !== 'json') return;

    assert.equal(result.keyId, 'k3');
    assert.equal(result.attempts, 3);
    assert.equal(runtimeOf(h.pool, 'k1').lastFailureReason, 'UPSTREAM_ERROR');
    assert.equal(runtimeOf(h.pool, 'k2').lastFailureReason, 'UPSTREAM_ERROR');
  });

  it('maxAttempts 封顶：3 把全 500、上限 2 → 只敲 2 次上游，返回 502', async () => {
    const h = makeHarness({
      keys: [keyConfig('k1', 'up1', { weight: 3 }), keyConfig('k2', 'up1', { weight: 2 }), keyConfig('k3', 'up1', { weight: 1 })],
      steps: [() => textResponse('boom', 500), () => textResponse('boom', 500), () => jsonResponse({})],
      maxAttempts: 2,
    });

    const result = await h.engine.chatCompletions({ group: GROUP, model: 'gpt-4o', body: chatBody('gpt-4o'), stream: false, requestId: REQUEST_ID });
    assert.equal(result.kind, 'error');
    assert.equal(h.calls.length, 2);
    if (result.kind !== 'error') return;
    assert.equal(result.error.httpStatus, 502);
    assert.equal(result.error.body.error.code, 'UPSTREAM_ERROR');
  });

  it('crossUpstreamRetry=false 时同上游耗尽即停，不跨上游', async () => {
    const h = makeHarness({
      keys: [keyConfig('k1', 'up1', { weight: 2 }), keyConfig('k2', 'up2', { weight: 1 })],
      upstreams: [
        { upstreamId: 'up1', enabled: true, models: null },
        { upstreamId: 'up2', enabled: true, models: null },
      ],
      steps: [() => textResponse('boom', 500), () => jsonResponse({})],
      crossUpstreamRetry: false,
    });

    const result = await h.engine.chatCompletions({ group: GROUP, model: 'gpt-4o', body: chatBody('gpt-4o'), stream: false, requestId: REQUEST_ID });
    assert.equal(result.kind, 'error');
    assert.equal(h.calls.length, 1, '不许跨上游重试');
  });

  it('首字节超时按 NETWORK 换 key；全超时返回 504 UPSTREAM_TIMEOUT', async () => {
    const h = makeHarness({
      keys: [keyConfig('k1')],
      steps: [
        () =>
          new Promise<Response>((_resolve, reject) => {
            setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), 5);
          }),
      ],
    });

    // 把首字节超时压到 1ms 触发真实超时路径
    const engine = createGatewayEngine({
      pool: h.pool,
      secrets: { resolve: () => ({ upstreamId: 'up1', baseUrl: 'https://up1.example.com/v1', apiKey: 'sk-x' }) },
      models: { listEnabledModels: async () => [], resolveUpstreamModel: (m) => m },
      fetchImpl: () =>
        new Promise<Response>((_resolve, reject) => {
          setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), 20);
        }),
      now,
      upstreamTimeoutMs: 1,
    });

    const result = await engine.chatCompletions({ group: GROUP, model: 'gpt-4o', body: chatBody('gpt-4o'), stream: false, requestId: REQUEST_ID });
    assert.equal(result.kind, 'error');
    if (result.kind !== 'error') return;
    assert.equal(result.error.httpStatus, 504);
    assert.equal(result.error.body.error.code, 'UPSTREAM_TIMEOUT');
    assert.equal(runtimeOf(h.pool, 'k1').lastFailureReason, 'NETWORK');
  });
});

describe('只有五类失败换 key', () => {
  it('上游 400 原样透传：不换 key、不计失败、不进冷却、只敲一次上游', async () => {
    const upstreamBody = { error: { message: 'messages must not be empty', type: 'invalid_request_error', code: 'invalid_messages' } };
    const h = makeHarness({
      keys: [keyConfig('k1'), keyConfig('k2')],
      steps: [() => jsonResponse(upstreamBody, 400), () => jsonResponse({ should: 'not be reached' })],
    });

    const result = await h.engine.chatCompletions({ group: GROUP, model: 'gpt-4o', body: chatBody('gpt-4o'), stream: false, requestId: REQUEST_ID });
    assert.equal(h.calls.length, 1, '客户端错不换 key');
    assert.equal(result.kind, 'json');
    if (result.kind !== 'json') return;

    assert.equal(result.status, 400);
    assert.deepEqual(result.payload, upstreamBody, '上游错误体原样透传');
    assert.equal(result.keyId, 'k1');

    const k1 = runtimeOf(h.pool, 'k1');
    assert.equal(k1.consecutiveFails, 0, '400 不能算 key 的错');
    assert.equal(k1.cooldownUntil, null);
    assert.equal(k1.failCount, 0);
  });

  it('404（模型不存在）同样不计失败', async () => {
    const h = makeHarness({
      keys: [keyConfig('k1')],
      steps: [() => jsonResponse({ error: { message: 'model not found' } }, 404)],
    });
    const result = await h.engine.chatCompletions({ group: GROUP, model: 'nope', body: chatBody('nope'), stream: false, requestId: REQUEST_ID });
    assert.equal(result.kind, 'json');
    assert.equal(runtimeOf(h.pool, 'k1').consecutiveFails, 0);
  });

  it('429 尊重上游 Retry-After（秒 → 冷却毫秒）', async () => {
    const h = makeHarness({
      keys: [keyConfig('k1')],
      steps: [() => textResponse('slow down', 429, { 'retry-after': '120' })],
    });

    const result = await h.engine.chatCompletions({ group: GROUP, model: 'gpt-4o', body: chatBody('gpt-4o'), stream: false, requestId: REQUEST_ID });
    assert.equal(result.kind, 'error');
    const k1 = runtimeOf(h.pool, 'k1');
    assert.equal(k1.lastFailureReason, 'RATE_LIMITED');
    assert.equal((k1.cooldownUntil ?? 0) - clock, 120_000);
  });

  it('402 归类 INSUFFICIENT_BALANCE（长冷却）', async () => {
    const h = makeHarness({ keys: [keyConfig('k1')], steps: [() => textResponse('no balance', 402)] });
    await h.engine.chatCompletions({ group: GROUP, model: 'gpt-4o', body: chatBody('gpt-4o'), stream: false, requestId: REQUEST_ID });
    assert.equal(runtimeOf(h.pool, 'k1').lastFailureReason, 'INSUFFICIENT_BALANCE');
    assert.equal((runtimeOf(h.pool, 'k1').cooldownUntil ?? 0) - clock, 30 * 60_000);
  });
});

describe('非流式结算', () => {
  it('采信上游 usage、清冷却、回填 onUsage 与调用日志', async () => {
    const h = makeHarness({
      keys: [keyConfig('k1')],
      steps: [() => jsonResponse({ id: 'x', choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 } })],
    });

    const result = await h.engine.chatCompletions({ group: GROUP, model: 'gpt-4o', body: chatBody('gpt-4o'), stream: false, requestId: REQUEST_ID });
    assert.equal(result.kind, 'json');
    if (result.kind !== 'json') return;

    assert.deepEqual(result.usage, { prompt: 11, completion: 22, total: 33, isEstimated: false });
    assert.deepEqual(h.usages, [{ groupId: 'grp_1', keyId: 'k1', total: 33 }]);

    assert.equal(h.logs.length, 1);
    const entry = h.logs[0];
    assert.ok(entry !== undefined);
    assert.equal(entry.totalTokens, 33);
    assert.equal(entry.statusCode, 200);
    assert.equal(entry.failureReason, null);
    assert.equal(entry.endpoint, '/v1/chat/completions');
    assert.equal(entry.attempts, 1);
    assert.equal(entry.stream, false);
  });

  it('上游不给 usage 时按字符估算并标 isEstimated（仍要记账）', async () => {
    const h = makeHarness({
      keys: [keyConfig('k1')],
      steps: [() => jsonResponse({ choices: [{ message: { role: 'assistant', content: '一段中文回复' } }] })],
    });

    const result = await h.engine.chatCompletions({ group: GROUP, model: 'gpt-4o', body: chatBody('gpt-4o'), stream: false, requestId: REQUEST_ID });
    assert.equal(result.kind, 'json');
    if (result.kind !== 'json') return;
    assert.equal(result.usage.isEstimated, true);
    assert.ok(result.usage.completion > 0);
    assert.equal(h.usages[0]?.total, result.usage.total);
  });

  it('模型别名映射进上游请求体，但日志里同时留下客户端原始名', async () => {
    const h = makeHarness({
      keys: [keyConfig('k1')],
      steps: [() => jsonResponse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })],
      aliases: { 'gpt-4o-mini': 'deepseek-chat' },
    });

    await h.engine.chatCompletions({ group: GROUP, model: 'gpt-4o-mini', body: chatBody('gpt-4o-mini'), stream: false, requestId: REQUEST_ID });

    const init = h.calls[0]?.init;
    assert.ok(init !== undefined);
    const sent = JSON.parse(String(init.body)) as { model: string };
    assert.equal(sent.model, 'deepseek-chat', '上游收到的是真实模型名');
    assert.equal(h.logs[0]?.clientModel, 'gpt-4o-mini');
    assert.equal(h.logs[0]?.model, 'deepseek-chat');
  });

  it('上游 Base URL 末尾斜杠不会拼出双斜杠；Authorization 用 key 明文', async () => {
    const h = makeHarness({
      keys: [keyConfig('k1')],
      steps: [() => jsonResponse({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })],
    });
    await h.engine.chatCompletions({ group: GROUP, model: 'gpt-4o', body: chatBody('gpt-4o'), stream: false, requestId: REQUEST_ID });

    assert.equal(h.calls[0]?.url, 'https://up1.example.com/v1/chat/completions');
    const headers = h.calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer sk-k1');
  });
});

describe('流式透传', () => {
  it('拿到响应头即返回流，不等 body 结束；流走完才结算', async () => {
    const sse = controlledSse();
    const h = makeHarness({ keys: [keyConfig('k1')], steps: [() => sse.response] });

    const result = await h.engine.chatCompletions({ group: GROUP, model: 'gpt-4o', body: chatBody('gpt-4o', true), stream: true, requestId: REQUEST_ID });
    assert.equal(result.kind, 'stream');
    if (result.kind !== 'stream') return;

    // 关键：此刻上游一个字节都还没发，客户端已经拿到响应头（验收 6 的 TTFB 前提）
    assert.equal(h.logs.length, 0, '流没结束不该有日志');
    assert.equal(runtimeOf(h.pool, 'k1').inflight, 1, '流式期间并发位必须被占住');

    sse.push('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
    sse.push('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
    sse.push('data: {"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n');
    sse.push('data: [DONE]\n\n');
    sse.close();

    const text = await drain(result.body);
    assert.ok(text.includes('你') && text.includes('好'), '字节必须原样透传（不缓冲、不改写）');
    assert.ok(text.includes('[DONE]'));

    assert.equal(runtimeOf(h.pool, 'k1').inflight, 0, '流结束必须归还并发位');
    assert.equal(h.usages[0]?.total, 7, '上游末帧 usage 被采信');
    assert.equal(h.logs.length, 1);
    assert.equal(h.logs[0]?.stream, true);
  });

  it('流中途上游断：发 SSE 错误帧 + [DONE]，且不再重放（不敲第二次上游）', async () => {
    const h = makeHarness({
      keys: [keyConfig('k1'), keyConfig('k2')],
      steps: [() => breakingSse('data: {"choices":[{"delta":{"content":"半句"}}]}\n\n'), () => jsonResponse({ should: 'not be reached' })],
    });

    const result = await h.engine.chatCompletions({ group: GROUP, model: 'gpt-4o', body: chatBody('gpt-4o', true), stream: true, requestId: REQUEST_ID });
    assert.equal(result.kind, 'stream');
    if (result.kind !== 'stream') return;

    const text = await drain(result.body);
    assert.ok(text.includes('半句'), '断之前的内容必须已经到客户端');
    assert.ok(text.includes('"code":"UPSTREAM_ERROR"'), '必须发 OpenAI 形状的错误帧');
    assert.ok(text.endsWith('data: [DONE]\n\n'), '错误帧后必须补 [DONE] 收尾');

    assert.equal(h.calls.length, 1, '首字节已出，绝不允许换 key 重放');
    assert.equal(runtimeOf(h.pool, 'k1').lastFailureReason, 'NETWORK');
    assert.equal(runtimeOf(h.pool, 'k1').inflight, 0);
  });

  it('长流不会被首字节超时掐断：拿到响应头即撤计时器（假定时器，零真实竞态）', async () => {
    // 这条用例以前睡**真实** 80ms 去对撞引擎里**真实**的 20ms 首字节计时器：
    // 只要事件循环被卡住超过 20ms（CI 上很常见），计时器就抢在 `disarmTimeout()` 之前烧掉，
    // 用例随机变红 —— 竞态在测试侧，不在被测代码侧。
    //
    // 改法：时间只由本用例推（假定时器 + 拍屏障）。下面推进 80ms 假时钟那一行就是判据本身：
    // 撤过计时器 ⇒ 这 80ms 里一个回调都不会跑；没撤（反向对照）⇒ abort 当场触发 `killed`，立刻变红。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const sse = controlledSse();
      let killed = false; // 上游被 abort 掉之后就别再往里推数据了，让断言说人话
      const h = makeHarness({
        keys: [keyConfig('k1')],
        upstreamTimeoutMs: 20, // 首字节超时 20ms，而这条流要活 80ms
        // 手搓的 Response 不会自己理会 signal，得复刻真实 undici 的语义：
        // signal 一 abort，body 立即以 AbortError 终结。不接这一步这条用例就是空转。
        steps: [
          (_url, init) => {
            init.signal?.addEventListener(
              'abort',
              () => {
                killed = true;
                sse.fail(new Error('aborted'));
              },
              { once: true },
            );
            return sse.response;
          },
        ],
      });

      const result = await h.engine.chatCompletions({ group: GROUP, model: 'gpt-4o', body: chatBody('gpt-4o', true), stream: true, requestId: REQUEST_ID });
      assert.equal(result.kind, 'stream');
      if (result.kind !== 'stream') return;

      // 拍屏障：把假时钟推过首字节超时 4 倍。撤了计时器这里就是真空档；没撤就是当场打红。
      await vi.advanceTimersByTimeAsync(80);
      assert.equal(killed, false, '拿到响应头后必须撤掉 TTFB 计时器：长流不能被它掐断，无辜的 key 也不该吃 NETWORK');

      sse.push('data: {"choices":[{"delta":{"content":"慢"}}]}\n\n');
      sse.push('data: [DONE]\n\n');
      sse.close();

      const text = await drain(result.body);
      assert.ok(text.includes('慢'), `长流必须完整透传，不能被 TTFB 超时掐断；实收 ${JSON.stringify(text)}`);
      assert.equal(runtimeOf(h.pool, 'k1').lastFailureReason, null, '无辜的 key 不该吃 NETWORK 冷却');
      assert.equal(runtimeOf(h.pool, 'k1').inflight, 0);
      assert.equal(h.logs[0]?.statusCode, 200);
    } finally {
      // 本文件其余用例（含那两处刻意的 5ms/20ms 上游超时模拟）依赖真实时钟，必须还原
      vi.useRealTimers();
    }
  });

  it('客户端主动断开：不计 key 失败、不进冷却、并发位归还', async () => {
    const sse = controlledSse();
    const h = makeHarness({ keys: [keyConfig('k1')], steps: [() => sse.response] });

    const result = await h.engine.chatCompletions({ group: GROUP, model: 'gpt-4o', body: chatBody('gpt-4o', true), stream: true, requestId: REQUEST_ID });
    assert.equal(result.kind, 'stream');
    if (result.kind !== 'stream') return;

    sse.push('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
    const reader = result.body.getReader();
    await reader.read(); // 拿一块
    await reader.cancel(); // 客户端跑了

    const k1 = runtimeOf(h.pool, 'k1');
    assert.equal(k1.consecutiveFails, 0, '用户按 ESC 不能把 key 打进冷却');
    assert.equal(k1.cooldownUntil, null);
    assert.equal(k1.inflight, 0, '断开也必须归还并发位');
  });

  it('首把 401 时流式请求同样在「首字节前」换 key', async () => {
    const sse = controlledSse();
    const h = makeHarness({
      keys: [keyConfig('k1', 'up1', { weight: 2 }), keyConfig('k2', 'up2', { weight: 1 })],
      upstreams: [
        { upstreamId: 'up1', enabled: true, models: null },
        { upstreamId: 'up2', enabled: true, models: null },
      ],
      steps: [() => textResponse('bad key', 401), () => sse.response],
    });

    const result = await h.engine.chatCompletions({ group: GROUP, model: 'gpt-4o', body: chatBody('gpt-4o', true), stream: true, requestId: REQUEST_ID });
    assert.equal(result.kind, 'stream');
    if (result.kind !== 'stream') return;

    assert.equal(result.keyId, 'k2');
    assert.equal(result.attempts, 2);
    assert.equal(h.calls.length, 2);

    sse.push('data: [DONE]\n\n');
    sse.close();
    await drain(result.body);
  });
});

describe('并发与运行态', () => {
  it('满并发的 key 被跳过：不算失败、不改冷却，直接用下一把', async () => {
    const h = makeHarness({
      keys: [keyConfig('k1', 'up1', { weight: 2 }), keyConfig('k2', 'up1', { weight: 1 })],
      steps: [() => jsonResponse({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })],
    });

    for (let i = 0; i < 4; i += 1) assert.equal(h.pool.beginAttempt('k1'), true);

    const result = await h.engine.chatCompletions({ group: GROUP, model: 'gpt-4o', body: chatBody('gpt-4o'), stream: false, requestId: REQUEST_ID });
    assert.equal(result.kind, 'json');
    if (result.kind !== 'json') return;

    assert.equal(result.keyId, 'k2');
    const k1 = runtimeOf(h.pool, 'k1');
    assert.equal(k1.consecutiveFails, 0, '满并发不是失败');
    assert.equal(k1.cooldownUntil, null);
    assert.equal(k1.inflight, 4, '旁路占用的并发位不该被引擎动');
  });

  it('密钥解析不到（密文缺失）的 key 被跳过，且不计失败', async () => {
    const h = makeHarness({
      keys: [keyConfig('k1', 'up1', { weight: 2 }), keyConfig('k2', 'up1', { weight: 1 })],
      resolveSecret: (keyId) => (keyId === 'k1' ? null : { upstreamId: 'up1', baseUrl: 'https://up1.example.com/v1', apiKey: 'sk-k2' }),
      steps: [() => jsonResponse({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })],
    });

    const result = await h.engine.chatCompletions({ group: GROUP, model: 'gpt-4o', body: chatBody('gpt-4o'), stream: false, requestId: REQUEST_ID });
    assert.equal(result.kind, 'json');
    if (result.kind !== 'json') return;

    assert.equal(result.keyId, 'k2');
    assert.equal(h.calls.length, 1, '解析不到密钥就不该敲上游');
    const k1 = runtimeOf(h.pool, 'k1');
    assert.equal(k1.consecutiveFails, 0, '配置侧问题不是 key 的错');
    assert.equal(k1.inflight, 0, '跳过前占的并发位也要还');
  });

  it('客户端在等上游响应头时断开 → 499，不计 key 失败', async () => {
    const controller = new AbortController();
    const pool = createKeyPool({ now });
    pool.applySnapshot(snapshot([keyConfig('k1')]));

    const engine = createGatewayEngine({
      pool,
      secrets: { resolve: () => ({ upstreamId: 'up1', baseUrl: 'https://up1.example.com/v1', apiKey: 'sk-k1' }) },
      models: { listEnabledModels: async () => [], resolveUpstreamModel: (m) => m },
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const abort = (): void => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          // 信号可能在 fetch 被调用前就已经 abort（客户端提前跑了），此时不会再触发事件
          if (init.signal?.aborted === true) {
            abort();
            return;
          }
          init.signal?.addEventListener('abort', abort, { once: true });
        }),
      now,
    });

    const pending = engine.chatCompletions({ group: GROUP, model: 'gpt-4o', body: chatBody('gpt-4o'), stream: false, requestId: REQUEST_ID, signal: controller.signal });
    controller.abort();
    const result = await pending;

    assert.equal(result.kind, 'error');
    if (result.kind !== 'error') return;
    assert.equal(result.error.httpStatus, 499);
    assert.equal(runtimeOf(pool, 'k1').consecutiveFails, 0, '客户端断开不计失败');
    assert.equal(runtimeOf(pool, 'k1').inflight, 0);
  });

  it('snapshot() 暴露池的运行态（供 GET /internal/snapshot）', () => {
    const h = makeHarness({ keys: [keyConfig('k1')], steps: [] });
    const snap = h.engine.snapshot();
    assert.equal(snap.keys.length, 1);
    assert.equal(snap.keys[0]?.keyId, 'k1');
    assert.ok(Number.isFinite(Date.parse(snap.at)), 'at 必须是可解析的 ISO8601');
  });
});
