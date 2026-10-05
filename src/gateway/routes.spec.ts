/**
 * `/v1/*` 路由层单测
 * 依据：docs/api-contract.md §0.1（两套错误体不许混）/ §9（边界）/ §10（网关面口径）
 *
 * 重点守两条容易破的线：
 *   1. `/v1/*` 只出 OpenAI 形状 `{error:{...}}`，任何时候都不许漏出 `{code,message}`
 *   2. 建了档案但不实现的端点（images/audio/rerank…）必须 501，不是 404
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { describe, it } from 'vitest';

import type { ForwardResult, GatewayEngine } from './engine.js';
import { GATEWAY_ERROR_CODES, GatewayError } from './errors.js';
import type { RateLimiter, LimitCheckResult } from './limiter.js';
import type { GroupContext, GatewayAuth, ModelDescriptor } from './ports.js';
import { gatewayRoutes } from './routes.js';

/* ------------------------------ 测试台 ------------------------------ */

const GROUP: GroupContext = { groupId: 'grp_1', name: '测试组', enabled: true, rpm: null, tpm: null, dailyQuota: null };

const MODELS: ModelDescriptor[] = [
  { id: 'gpt-4o', createdAt: '2026-10-06T00:00:00.000Z', ownedBy: 'openai' },
  { id: 'deepseek-chat', createdAt: '2026-10-01T00:00:00.000Z', ownedBy: 'up1' },
];

function stubEngine(over: Partial<GatewayEngine> = {}): { engine: GatewayEngine; seen: Array<Record<string, unknown>> } {
  const seen: Array<Record<string, unknown>> = [];
  const ok: ForwardResult = {
    kind: 'json',
    status: 200,
    payload: { id: 'cmpl_1', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    keyId: 'k1',
    upstreamId: 'up1',
    usage: { prompt: 1, completion: 1, total: 2, isEstimated: false },
    ttfbMs: 12.6,
    attempts: 1,
  };

  const engine: GatewayEngine = {
    async chatCompletions(req) {
      seen.push({ endpoint: '/v1/chat/completions', ...req });
      return ok;
    },
    async embeddings(req) {
      seen.push({ endpoint: '/v1/embeddings', ...req });
      return ok;
    },
    async listModels() {
      return MODELS;
    },
    snapshot() {
      return { at: '2026-10-06T12:00:00.000Z', keys: [] };
    },
    ...over,
  };
  return { engine, seen };
}

interface BuildOptions {
  auth?: GatewayAuth;
  limiter?: RateLimiter;
  internalToken?: string;
  engine?: GatewayEngine;
}

async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify();
  const auth: GatewayAuth = options.auth ?? { authenticate: async (key) => (key === 'gk-ok' ? GROUP : null) };
  const { engine } = stubEngine();
  await app.register(gatewayRoutes, {
    engine: options.engine ?? engine,
    auth,
    ...(options.limiter === undefined ? {} : { limiter: options.limiter }),
    ...(options.internalToken === undefined ? {} : { internalToken: options.internalToken }),
  });
  await app.ready();
  return app;
}

/** 断言响应体是 OpenAI 形状，且没有混进管理面的 `{code,message}` */
function assertOpenAIShape(body: unknown): { message: string; type: string; code: string } {
  const parsed = body as { error?: { message?: string; type?: string; code?: string }; code?: unknown; message?: unknown };
  assert.ok(parsed.error !== undefined, `必须是 OpenAI 错误体，实际 ${JSON.stringify(body)}`);
  assert.equal(typeof parsed.error.message, 'string');
  assert.equal(typeof parsed.error.type, 'string');
  assert.equal(typeof parsed.error.code, 'string');
  assert.equal(parsed.code, undefined, '/v1/* 不许出现管理面的顶层 code');
  assert.equal(parsed.message, undefined, '/v1/* 不许出现管理面的顶层 message');
  return parsed.error as { message: string; type: string; code: string };
}

const CHAT = '/v1/chat/completions';

function chatPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], ...over };
}

/* ------------------------------ 用例 ------------------------------ */

describe('鉴权', () => {
  it('缺 Authorization → 401，且不区分「不存在」与「已禁用」', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: CHAT, payload: chatPayload() });

    assert.equal(res.statusCode, 401);
    const err = assertOpenAIShape(res.json());
    assert.equal(err.code, GATEWAY_ERROR_CODES.INVALID_API_KEY);
    assert.equal(err.type, 'authentication_error');
    await app.close();
  });

  it('非 Bearer 形态（Basic / 裸 token）一律当无凭证', async () => {
    const app = await buildApp();
    for (const authorization of ['Basic gk-ok', 'gk-ok', 'Bearer', 'Bearer   ']) {
      const res = await app.inject({ method: 'POST', url: CHAT, headers: { authorization }, payload: chatPayload() });
      assert.equal(res.statusCode, 401, `${authorization} 不该被当作凭证`);
    }
    await app.close();
  });

  it('未知 key → 401，错误文案不泄漏「key 是否存在」', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: CHAT, headers: { authorization: 'Bearer nope' }, payload: chatPayload() });

    assert.equal(res.statusCode, 401);
    const err = assertOpenAIShape(res.json());
    assert.ok(!err.message.includes('nope'), '错误体里不许回显客户端给的 key');
    await app.close();
  });

  it('用户组被禁用 → 403 GROUP_DISABLED', async () => {
    const app = await buildApp({ auth: { authenticate: async () => ({ ...GROUP, enabled: false }) } });
    const res = await app.inject({ method: 'POST', url: CHAT, headers: { authorization: 'Bearer gk-ok' }, payload: chatPayload() });

    assert.equal(res.statusCode, 403);
    assert.equal(assertOpenAIShape(res.json()).code, 'GROUP_DISABLED');
    await app.close();
  });
});

describe('请求校验', () => {
  it('body 不是 JSON 对象 → 400 INVALID_REQUEST', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: CHAT,
      headers: { authorization: 'Bearer gk-ok', 'content-type': 'application/json' },
      payload: '"just a string"',
    });

    assert.equal(res.statusCode, 400);
    assert.equal(assertOpenAIShape(res.json()).code, GATEWAY_ERROR_CODES.INVALID_REQUEST);
    await app.close();
  });

  it('缺 model / model 为空 / 类型不对 → 400 且 param=model', async () => {
    const app = await buildApp();
    const bads: Array<Record<string, unknown>> = [
      { messages: [{ role: 'user', content: 'hi' }] }, // 缺
      { model: '', messages: [] }, // 空串
      { model: 42, messages: [] }, // 类型错
    ];
    for (const payload of bads) {
      const res = await app.inject({ method: 'POST', url: CHAT, headers: { authorization: 'Bearer gk-ok' }, payload });
      assert.equal(res.statusCode, 400, `${JSON.stringify(payload)} 应回 400`);
      const err = res.json().error as { code: string; param?: string };
      assert.equal(err.code, GATEWAY_ERROR_CODES.INVALID_REQUEST);
      assert.equal(err.param, 'model');
    }
    await app.close();
  });

  it('缺 messages → 400 且 param=messages', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: CHAT, headers: { authorization: 'Bearer gk-ok' }, payload: { model: 'gpt-4o' } });

    assert.equal(res.statusCode, 400);
    assert.equal((res.json().error as { param?: string }).param, 'messages');
    await app.close();
  });

  it('缺 input 的 embeddings → 400 且 param=input', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/embeddings', headers: { authorization: 'Bearer gk-ok' }, payload: { model: 'text-embedding-3-small' } });

    assert.equal(res.statusCode, 400);
    assert.equal((res.json().error as { param?: string }).param, 'input');
    await app.close();
  });

  it('坏 JSON 由 Fastify 抛错，仍要翻成 OpenAI 形状而不是 500 泄漏栈', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: CHAT,
      headers: { authorization: 'Bearer gk-ok', 'content-type': 'application/json' },
      payload: '{"model": "gpt-4o",',
    });

    assert.equal(res.statusCode, 400);
    assert.equal(assertOpenAIShape(res.json()).type, 'invalid_request_error');
    assert.ok(!res.body.includes('at Object.'), '不许把栈吐给客户端');
    await app.close();
  });
});

describe('非流式转发', () => {
  it('透传上游 JSON，并带上 x-gateway-* 观测头', async () => {
    const { engine, seen } = stubEngine();
    const app = await buildApp({ engine });

    const res = await app.inject({ method: 'POST', url: CHAT, headers: { authorization: 'Bearer gk-ok' }, payload: chatPayload() });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-gateway-key-id'], 'k1');
    assert.equal(res.headers['x-gateway-attempts'], '1');
    assert.equal(res.headers['x-gateway-ttfb-ms'], '13', 'TTFB 取整上报');
    assert.equal((res.json() as { id: string }).id, 'cmpl_1');

    assert.equal(seen.length, 1);
    const call = seen[0];
    assert.ok(call !== undefined);
    assert.equal(call.endpoint, '/v1/chat/completions');
    assert.equal(call.model, 'gpt-4o');
    assert.equal(call.stream, false, 'body.stream 缺省即非流式');
    assert.equal((call.group as GroupContext).groupId, 'grp_1', '引擎拿到的是鉴权后的用户组，不是原始 key');
    await app.close();
  });

  it('body.stream=true 精确传导成 stream=true', async () => {
    const { engine, seen } = stubEngine();
    const app = await buildApp({ engine });
    await app.inject({ method: 'POST', url: CHAT, headers: { authorization: 'Bearer gk-ok' }, payload: chatPayload({ stream: true }) });
    assert.equal(seen[0]?.stream, true);
    await app.close();
  });

  it('上游 4xx 原样透传（连状态码一起），不包成 502', async () => {
    const engine = stubEngine({
      chatCompletions: async () =>
        ({
          kind: 'json',
          status: 400,
          payload: { error: { message: 'messages must not be empty', type: 'invalid_request_error', code: 'invalid_messages' } },
          keyId: 'k1',
          upstreamId: 'up1',
          usage: { prompt: 0, completion: 0, total: 0, isEstimated: false },
          ttfbMs: 8,
          attempts: 1,
        }) satisfies ForwardResult,
    }).engine;
    const app = await buildApp({ engine });

    const res = await app.inject({ method: 'POST', url: CHAT, headers: { authorization: 'Bearer gk-ok' }, payload: chatPayload() });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json().error as { code: string }).code, 'invalid_messages');
    await app.close();
  });
});

describe('流式转发', () => {
  it('SSE 原样透传：content-type / 禁缓冲头齐备，且不设 content-length', async () => {
    const chunks = ['data: {"choices":[{"delta":{"content":"你"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"好"}}]}\n\n', 'data: [DONE]\n\n'];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    });
    const engine = stubEngine({
      chatCompletions: async () =>
        ({ kind: 'stream', status: 200, body, keyId: 'k1', upstreamId: 'up1', ttfbMs: 30.2, attempts: 1 }) satisfies ForwardResult,
    }).engine;
    const app = await buildApp({ engine });

    const res = await app.inject({ method: 'POST', url: CHAT, headers: { authorization: 'Bearer gk-ok' }, payload: chatPayload({ stream: true }) });

    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /text\/event-stream/);
    assert.equal(res.headers['x-accel-buffering'], 'no', '反代不许缓冲，否则 TTFB 白优化');
    assert.match(String(res.headers['cache-control']), /no-transform/);
    // 注：inject 不走真实 socket，light-my-request 会补一个假的 content-length: 0，
    // 所以「不许有 content-length」这条只能在真实 HTTP 下断言（见下一个用例）。
    assert.equal(res.headers['x-gateway-ttfb-ms'], '30');
    assert.equal(res.body, chunks.join(''), '字节必须逐一原样透传');
    await app.close();
  });

  it('真实 HTTP：chunked 传输、无 content-length，且首块数据在流结束前就到达客户端', async () => {
    // 手动可控的上游 SSE：客户端读到第一块之前，上游一个字节都还没发
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const engine = stubEngine({
      chatCompletions: async () => ({ kind: 'stream', status: 200, body: upstream, keyId: 'k1', upstreamId: 'up1', ttfbMs: 5.5, attempts: 1 }) satisfies ForwardResult,
    }).engine;
    const app = await buildApp({ engine });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;

    try {
      // 注意：不能先 await fetch —— Fastify 对 stream payload 只在首块数据写出时才 flush 响应头
      // （sendStream 用 res.setHeader + pipe，没数据就没有响应头），上游不吐字节时 fetch 会一直挂着。
      // 这本身也是「不缓冲」的正向证据：响应头和首块数据是一起到的。
      const resPromise = fetch(`http://127.0.0.1:${address.port}${CHAT}`, {
        method: 'POST',
        headers: { authorization: 'Bearer gk-ok', 'content-type': 'application/json' },
        body: JSON.stringify(chatPayload({ stream: true })),
      });

      assert.ok(controller !== null);
      const first = 'data: {"choices":[{"delta":{"content":"你"}}]}\n\n';
      (controller as ReadableStreamDefaultController<Uint8Array>).enqueue(new TextEncoder().encode(first));

      const res = await resPromise;
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-accel-buffering'), 'no');
      assert.match(String(res.headers.get('content-type')), /text\/event-stream/);
      assert.equal(res.headers.get('content-length'), null, '流式响应不许有 content-length');
      assert.equal(res.headers.get('x-gateway-ttfb-ms'), '6', '5.5ms 四舍五入到整数毫秒');
      assert.equal(res.headers.get('x-gateway-key-id'), 'k1');
      assert.equal(res.headers.get('x-gateway-attempts'), '1');

      const reader = res.body?.getReader();
      assert.ok(reader !== undefined);

      // 上游此刻一个字节都还没发完（流没 close），却已经能读到那一块 —— 这就是「不缓冲」的可观测证据
      const got = await reader.read();
      assert.equal(got.done, false);
      assert.equal(new TextDecoder().decode(got.value), first, '首个字节必须原样、不攒批送出去');

      const second = 'data: [DONE]\n\n';
      (controller as ReadableStreamDefaultController<Uint8Array>).enqueue(new TextEncoder().encode(second));
      (controller as ReadableStreamDefaultController<Uint8Array>).close();
      const rest = await reader.read();
      assert.equal(new TextDecoder().decode(rest.value), second);
      assert.equal((await reader.read()).done, true);
    } finally {
      await app.close();
    }
  });

  it('引擎给的 499（客户端已断）走 hijack，不往空气里写响应体', async () => {
    const engine = stubEngine({
      chatCompletions: async () => ({ kind: 'error', error: new GatewayError(499, GATEWAY_ERROR_CODES.UPSTREAM_ERROR, 'client closed request'), attempts: 1 }),
    }).engine;
    const app = await buildApp({ engine });

    const res = await app.inject({ method: 'POST', url: CHAT, headers: { authorization: 'Bearer gk-ok' }, payload: chatPayload({ stream: true }) });
    assert.equal(res.body, '');
    await app.close();
  });
});

describe('错误映射', () => {
  it('NO_AVAILABLE_KEY 走 503 + server_error', async () => {
    const engine = stubEngine({
      chatCompletions: async () => ({ kind: 'error', error: new GatewayError(503, GATEWAY_ERROR_CODES.NO_AVAILABLE_KEY, 'no available key for model: gpt-4o', 'server_error'), attempts: 0 }),
    }).engine;
    const app = await buildApp({ engine });

    const res = await app.inject({ method: 'POST', url: CHAT, headers: { authorization: 'Bearer gk-ok' }, payload: chatPayload() });
    assert.equal(res.statusCode, 503);
    const err = assertOpenAIShape(res.json());
    assert.equal(err.code, GATEWAY_ERROR_CODES.NO_AVAILABLE_KEY);
    assert.equal(err.type, 'server_error');
    await app.close();
  });

  it('引擎抛异常 → 500，且不把内部 message 回显给调用方', async () => {
    const engine = stubEngine({
      chatCompletions: async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.9:5432 (key sk-live-abcdef)');
      },
    }).engine;
    const app = await buildApp({ engine });

    const res = await app.inject({ method: 'POST', url: CHAT, headers: { authorization: 'Bearer gk-ok' }, payload: chatPayload() });
    assert.equal(res.statusCode, 500);
    assertOpenAIShape(res.json());
    assert.ok(!res.body.includes('sk-live'), '5xx 不许回显可能带 key/host 的内部报错');
    assert.ok(!res.body.includes('ECONNREFUSED'), '5xx 不许回显内部报错原文');
    await app.close();
  });
});

describe('未实现的端点', () => {
  it('建过档案但不实现的路径 → 501 UNSUPPORTED_ENDPOINT（不是 404）', async () => {
    const app = await buildApp();
    for (const url of ['/v1/images/generations', '/v1/audio/speech', '/v1/rerank', '/v1/moderations', '/v1/files', '/v1/fine_tuning/jobs']) {
      const res = await app.inject({ method: 'POST', url, headers: { authorization: 'Bearer gk-ok' }, payload: {} });
      assert.equal(res.statusCode, 501, `${url} 应回 501`);
      assert.equal(assertOpenAIShape(res.json()).code, GATEWAY_ERROR_CODES.UNSUPPORTED_ENDPOINT);
    }
    await app.close();
  });

  it('真不存在的路径 → 404 NOT_FOUND', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/nonsense', headers: { authorization: 'Bearer gk-ok' } });

    assert.equal(res.statusCode, 404);
    assert.equal(assertOpenAIShape(res.json()).code, GATEWAY_ERROR_CODES.NOT_FOUND);
    await app.close();
  });
});

describe('GET /v1/models', () => {
  it('返回 OpenAI list 形状，created 是秒级整数', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer gk-ok' } });

    assert.equal(res.statusCode, 200);
    const body = res.json() as { object: string; data: Array<{ id: string; object: string; created: number; owned_by: string }> };
    assert.equal(body.object, 'list');
    assert.equal(body.data.length, MODELS.length);
    assert.deepEqual(
      body.data.map((m) => m.id),
      ['gpt-4o', 'deepseek-chat'],
    );
    for (const m of body.data) {
      assert.equal(m.object, 'model');
      assert.ok(Number.isInteger(m.created) && m.created > 0, 'created 必须是秒级整数（契约 §0.2 时间口径）');
      assert.equal(typeof m.owned_by, 'string');
    }
    assert.equal(body.data[0]?.created, Math.floor(Date.parse('2026-10-06T00:00:00.000Z') / 1000));
    await app.close();
  });

  it('同样要鉴权：无 key 不给模型清单', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    assert.equal(res.statusCode, 401);
    await app.close();
  });
});

describe('限流', () => {
  const rejecting = (result: LimitCheckResult): RateLimiter => ({
    check: () => result,
    commitTokens: () => undefined,
    dayTokensOf: () => 0,
    reset: () => undefined,
  });

  it('RPM/TPM 超限 → 429 RATE_LIMITED + rate_limit_error + retry-after', async () => {
    const app = await buildApp({ limiter: rejecting({ ok: false, reason: 'RATE_LIMITED', retryAfterSec: 1, detail: 'rpm 60/60' }) });
    const res = await app.inject({ method: 'POST', url: CHAT, headers: { authorization: 'Bearer gk-ok' }, payload: chatPayload() });

    assert.equal(res.statusCode, 429);
    const err = assertOpenAIShape(res.json());
    assert.equal(err.code, GATEWAY_ERROR_CODES.RATE_LIMITED);
    assert.equal(err.type, 'rate_limit_error');
    assert.equal(res.headers['retry-after'], '1');
    await app.close();
  });

  it('日配额超限 → 429 QUOTA_EXCEEDED + insufficient_quota，且不打上游', async () => {
    const { engine, seen } = stubEngine();
    const app = await buildApp({ engine, limiter: rejecting({ ok: false, reason: 'QUOTA_EXCEEDED', retryAfterSec: 43200, detail: 'dailyQuota 1000/1000' }) });

    const res = await app.inject({ method: 'POST', url: CHAT, headers: { authorization: 'Bearer gk-ok' }, payload: chatPayload() });

    assert.equal(res.statusCode, 429);
    const err = assertOpenAIShape(res.json());
    assert.equal(err.code, GATEWAY_ERROR_CODES.QUOTA_EXCEEDED);
    assert.equal(err.type, 'insufficient_quota');
    assert.equal(res.headers['retry-after'], '43200');
    assert.equal(seen.length, 0, '超配额时一次上游都不许敲');
    await app.close();
  });

  it('放行时引擎正常收到请求', async () => {
    const { engine, seen } = stubEngine();
    const app = await buildApp({
      engine,
      limiter: { check: () => ({ ok: true }), commitTokens: () => undefined, dayTokensOf: () => 0, reset: () => undefined },
    });
    const res = await app.inject({ method: 'POST', url: CHAT, headers: { authorization: 'Bearer gk-ok' }, payload: chatPayload() });
    assert.equal(res.statusCode, 200);
    assert.equal(seen.length, 1);
    await app.close();
  });
});

describe('GET /internal/snapshot', () => {
  it('未配 internalToken 时只允许回环地址', async () => {
    const app = await buildApp();
    const local = await app.inject({ method: 'GET', url: '/internal/snapshot' });
    assert.equal(local.statusCode, 200);
    assert.equal((local.json() as { keys: unknown[] }).keys.length, 0);

    const remote = await app.inject({ method: 'GET', url: '/internal/snapshot', remoteAddress: '10.0.0.7' });
    assert.equal(remote.statusCode, 403);
    await app.close();
  });

  it('配了 internalToken 则要求 Bearer 匹配', async () => {
    const app = await buildApp({ internalToken: 'snap-token' });

    const bad = await app.inject({ method: 'GET', url: '/internal/snapshot', headers: { authorization: 'Bearer wrong' } });
    assert.equal(bad.statusCode, 401);

    const ok = await app.inject({ method: 'GET', url: '/internal/snapshot', headers: { authorization: 'Bearer snap-token' } });
    assert.equal(ok.statusCode, 200);
    await app.close();
  });
});
