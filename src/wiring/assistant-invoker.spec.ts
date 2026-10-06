/**
 * 内置 AI 助手 —— 网关侧实现单测（契约 v1.2.0 §13.4 / ADR-0015 §4 §7）。
 *
 * 本文件盯死四条"破了不会报错、只会静默出错"的不变式：
 *   1. **不污染业务流量口径** —— 助手调用跑完，业务 usage sink 仍是 0 条；
 *      同时 **key 健康同源** —— 同一把池子的 `reportSuccess`/`reportFailure` 照常走。
 *      这两条是 §13.4 那句话的双向含义，只测一边等于没测。
 *   2. **终止必为 done 或 error，恰好一个** —— 前端不许等到超时。
 *   3. **断流不产帧、不计 key 失败、并发位归还** —— 用户按取消不能把好 key 打进冷却。
 *   4. **错误帧只说人话** —— 气泡里出现引擎原文（术语/上游回显）就是回归。
 */

import { describe, expect, it, vi } from 'vitest';

import { createGatewayStack } from '../gateway/stack.js';
import { createKeyPool } from '../gateway/key-pool.js';
import type { KeyPoolInternal } from '../gateway/key-pool.js';
import type { FetchLike } from '../gateway/engine.js';
import type { ModelCatalog, SecretResolver, UpstreamTarget, UsageLogEntry, ErrorEventEntry } from '../gateway/ports.js';
import type { KeyConfig, PoolSnapshot } from '../gateway/types.js';
import type { AssistantMessage, AssistantStreamEvent } from '../api/assistant-port.js';
import { createAssistantInvoker, createAssistantMetrics } from './assistant-invoker.js';

const MODEL = 'gpt-assistant-probe';
const encoder = new TextEncoder();

/* ------------------------------ 测试台 ------------------------------ */

let clock = 1_700_000_000_000;
const now = (): number => clock;

function keyConfig(keyId: string, over: Partial<KeyConfig> = {}): KeyConfig {
  return {
    keyId,
    upstreamId: 'up1',
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

function snapshot(keys: KeyConfig[]): PoolSnapshot {
  return { revision: 1, upstreams: [{ upstreamId: 'up1', enabled: true, models: null }], keys };
}

function sseResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function deltaFrame(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

const USAGE_FRAME = `data: ${JSON.stringify({ usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\n\n`;
const DONE_FRAME = 'data: [DONE]\n\n';

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

/**
 * 会**跟着 `AbortSignal` 一起炸**的 SSE 流。
 * 必须自己实现：真 fetch 在 signal abort 时会断掉响应流，而这个测试台里的 fetch 是桩，
 * 不接 signal 的桩会让"断流"用例永远挂在那里（引擎的 reader.read() 一直 pending）。
 */
function abortableSse(signal: AbortSignal | null | undefined, firstChunk?: string): Response {
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (firstChunk !== undefined) {
        controller.enqueue(encoder.encode(firstChunk));
        sent = true;
      }
      const onAbort = (): void => {
        try {
          controller.error(new Error('aborted'));
        } catch {
          /* 已经关了 */
        }
      };
      if (signal?.aborted === true) onAbort();
      else signal?.addEventListener('abort', onAbort);
    },
    pull(controller) {
      if (sent) return;
      sent = true;
      // 永不结束：等 signal 来断
      void controller;
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function stubSecrets(keys: KeyConfig[]): SecretResolver {
  return {
    resolve: (keyId) => {
      const found = keys.find((k) => k.keyId === keyId);
      if (found === undefined) return null;
      const target: UpstreamTarget = {
        upstreamId: found.upstreamId,
        baseUrl: `https://${found.upstreamId}.example.com/v1`,
        apiKey: `sk-${keyId}`,
      };
      return target;
    },
  };
}

const models: ModelCatalog = { listEnabledModels: async () => [], resolveUpstreamModel: (m) => m };

function messages(text = '刚才 5 分钟的错误多吗？'): AssistantMessage[] {
  return [{ role: 'user', content: text }];
}

async function collect(iterable: AsyncIterable<AssistantStreamEvent>): Promise<AssistantStreamEvent[]> {
  const out: AssistantStreamEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

function textOf(events: AssistantStreamEvent[]): string {
  return events.filter((e) => e.kind === 'delta').map((e) => (e.kind === 'delta' ? e.text : '')).join('');
}

/**
 * 业务侧装配：**同一个 pool**、真实的 usage sink 与 error sink。
 * 助手共用这把池子，但它的调用不该在这两个 sink 上留下任何一条。
 */
function makeHarness(options: { keys: KeyConfig[]; fetchImpl: FetchLike; maxConcurrencyPerKey?: number }) {
  clock = 1_700_000_000_000;
  const pool: KeyPoolInternal = createKeyPool({
    now,
    ...(options.maxConcurrencyPerKey === undefined ? {} : { defaultMaxConcurrency: options.maxConcurrencyPerKey }),
  });
  pool.applySnapshot(snapshot(options.keys));
  const secrets = stubSecrets(options.keys);

  const businessLogs: UsageLogEntry[] = [];
  const businessEvents: ErrorEventEntry[] = [];
  createGatewayStack({
    pool,
    secrets,
    models,
    auth: { authenticate: async () => null },
    logs: { record: (e) => businessLogs.push(e) },
    errors: { record: (e) => businessEvents.push(e) },
    fetchImpl: options.fetchImpl,
    now,
  });

  const metrics = createAssistantMetrics();
  const invoker = createAssistantInvoker({
    pool,
    secrets,
    models,
    model: MODEL,
    metrics,
    fetchImpl: options.fetchImpl,
    maxAttempts: 2,
  });

  return { pool, metrics, invoker, businessLogs, businessEvents };
}

const oneKey = [keyConfig('k1')];

/* ------------------------------ 用例 ------------------------------ */

describe('助手内部调用：计量口径（§13.4）', () => {
  it('成功流式：delta 拼接 + done，业务 usage/error sink 零写入，key 健康同源', async () => {
    const fetchImpl: FetchLike = async () =>
      sseResponse(deltaFrame('最近 5 分钟') + deltaFrame('有 3 条 503。') + USAGE_FRAME + DONE_FRAME);
    const h = makeHarness({ keys: oneKey, fetchImpl });
    const success = vi.spyOn(h.pool, 'reportSuccess');
    const failure = vi.spyOn(h.pool, 'reportFailure');

    const events = await collect(h.invoker.stream(messages(), new AbortController().signal));

    expect(textOf(events)).toBe('最近 5 分钟有 3 条 503。');
    expect(events.at(-1)).toEqual({ kind: 'done' });

    // ① 不写业务流量口径：助手跑完了，两条业务出口都还是空的
    expect(h.businessLogs).toHaveLength(0);
    expect(h.businessEvents).toHaveLength(0);

    // ② 但 key 健康照常结算（同一个 pool 实例）：这两条同时成立才是 §13.4 的含义
    expect(success).toHaveBeenCalledTimes(1);
    expect(success.mock.calls[0]?.[0]).toBe('k1');
    expect(failure).not.toHaveBeenCalled();

    // ③ 独立计量：上游 usage 帧被采信
    expect(h.metrics).toEqual({
      requests: 1,
      errors: 0,
      tokens: { prompt: 7, completion: 3, total: 10 },
    });
  });

  it('上游不给 usage 帧时回落估算，token 仍然记账（宁少记不可不记）', async () => {
    const fetchImpl: FetchLike = async () => sseResponse(deltaFrame('答复') + DONE_FRAME);
    const h = makeHarness({ keys: oneKey, fetchImpl });

    const events = await collect(h.invoker.stream(messages(), new AbortController().signal));

    expect(events.at(-1)).toEqual({ kind: 'done' });
    expect(h.metrics.tokens.total).toBeGreaterThan(0);
  });
});

describe('助手内部调用：终止帧（§13.2）', () => {
  it('池里没有候选 → NO_AVAILABLE_KEY / 503，一个 delta 都不发', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('不该打到上游');
    };
    const h = makeHarness({ keys: [], fetchImpl });

    const events = await collect(h.invoker.stream(messages(), new AbortController().signal));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'error', code: 'NO_AVAILABLE_KEY', status: 503 });
    expect(h.metrics.errors).toBe(1);
    expect(h.metrics.requests).toBe(1);
  });

  it('池饱和（候选在、槽位全满）→ 429 RATE_LIMITED + retryAfterSec，不新造码值', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('不该打到上游');
    };
    const h = makeHarness({ keys: oneKey, fetchImpl, maxConcurrencyPerKey: 1 });

    // 真实池的 `getAvailableKeys` 会把已达并发的 key **过滤掉**（key-pool.ts:118 isUsable），
    // 所以「候选非空但 beginAttempt 拿不到槽位」只存在于**选出 → 占位**这一段竞态窗口里
    // （engine.ts:477 那个分支就是为它写的）。这里把窗口撑开：在选路返回之后、引擎占位之前
    // 抢走唯一槽位 —— 复现的是真实并发下的 TOCTOU 竞态，不是给池子打桩喂假候选。
    const available = h.pool.getAvailableKeys.bind(h.pool);
    vi.spyOn(h.pool, 'getAvailableKeys').mockImplementation(async (model: string) => {
      const list = await available(model);
      expect(list).toHaveLength(1);
      expect(h.pool.beginAttempt('k1')).toBe(true); // 另一个请求在此刻抢走了槽位
      return list;
    });

    const events = await collect(h.invoker.stream(messages(), new AbortController().signal));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'error',
      code: 'RATE_LIMITED',
      status: 429,
      retryAfterSec: 1,
    });
  });

  it('上游全失败 → UPSTREAM_ERROR / 502，且文案是说人话、不是引擎原文', async () => {
    const fetchImpl: FetchLike = async () => new Response('boom', { status: 500 });
    const h = makeHarness({ keys: oneKey, fetchImpl });

    const events = await collect(h.invoker.stream(messages(), new AbortController().signal));

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event).toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR', status: 502 });
    if (event?.kind !== 'error') throw new Error('应当以 error 终止');
    // 引擎原文是 "all N attempt(s) failed: last failure UPSTREAM_ERROR (HTTP 500)"，
    // 那种句子不该出现在值班的气泡里
    expect(event.message).not.toContain('attempt(s)');
    expect(event.message).not.toContain('HTTP');
  });

  it('流中途上游断 → UPSTREAM_ERROR 终止帧，已收到的文本不丢', async () => {
    const fetchImpl: FetchLike = async () => breakingSse(deltaFrame('半句'));
    const h = makeHarness({ keys: oneKey, fetchImpl });

    const events = await collect(h.invoker.stream(messages(), new AbortController().signal));

    expect(textOf(events)).toBe('半句');
    expect(events.at(-1)).toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR', status: 502 });
    expect(h.businessLogs).toHaveLength(0);
  });
});

describe('助手内部调用：断流（§13.4）', () => {
  it('客户端 abort → 不发任何终止帧、不计 key 失败、并发位归还', async () => {
    const fetchImpl: FetchLike = async (_url, init) => abortableSse(init.signal, deltaFrame('开头'));
    const h = makeHarness({ keys: oneKey, fetchImpl });
    const failure = vi.spyOn(h.pool, 'reportFailure');
    const controller = new AbortController();

    const events: AssistantStreamEvent[] = [];
    for await (const event of h.invoker.stream(messages(), controller.signal)) {
      events.push(event);
      controller.abort(); // 用户点了「取消」
    }

    // 客户端已经走了，帧没人收：连 error 都不要发（发了也只会在死连接上打转）
    expect(events.some((e) => e.kind === 'done' || e.kind === 'error')).toBe(false);
    expect(failure).not.toHaveBeenCalled();
    expect(h.metrics.errors).toBe(0);
    // 并发位必须归还（engine.ts 的 settle 契约），否则这把 key 会永远卡在满并发
    expect(h.pool.beginAttempt('k1')).toBe(true);
  });
});

describe('助手内部调用：帧解析边界', () => {
  it('半行跨 chunk 不丢字，[DONE] 是唯一的成功终止信号', async () => {
    const full = deltaFrame('跨块') + DONE_FRAME;
    const cut = Math.floor(full.length / 2);
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        if (reads === 1) controller.enqueue(encoder.encode(full.slice(0, cut)));
        else if (reads === 2) controller.enqueue(encoder.encode(full.slice(cut)));
        else controller.close();
      },
    });
    const fetchImpl: FetchLike = async () =>
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const h = makeHarness({ keys: oneKey, fetchImpl });

    const events = await collect(h.invoker.stream(messages(), new AbortController().signal));

    expect(textOf(events)).toBe('跨块');
    expect(events.filter((e) => e.kind === 'done')).toHaveLength(1);
  });
});
