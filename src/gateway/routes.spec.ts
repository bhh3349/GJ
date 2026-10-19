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
import type { GroupContext, GatewayAuth, ModelCatalog, ModelDescriptor } from './ports.js';
import { gatewayRoutes } from './routes.js';

/* ------------------------------ 测试台 ------------------------------ */

const GROUP: GroupContext = { groupId: 'grp_1', name: '测试组', enabled: true, rpm: null, tpm: null, dailyQuota: null, authorizedModels: null };

const MODELS: ModelDescriptor[] = [
  { id: 'gpt-4o', type: 'chat', createdAt: '2026-10-06T00:00:00.000Z', ownedBy: 'openai', capabilities: ['stream', 'vision'], contextLength: 128_000, endpointTypes: null },
  { id: 'deepseek-chat', type: 'chat', createdAt: '2026-10-01T00:00:00.000Z', ownedBy: 'up1', capabilities: [], contextLength: null, endpointTypes: null },
  { id: 'text-embedding-3-small', type: 'embedding', createdAt: '2026-10-02T00:00:00.000Z', ownedBy: 'openai', capabilities: [], contextLength: null, endpointTypes: null },
  { id: 'dall-e-3', type: 'image', createdAt: '2026-10-02T00:00:00.000Z', ownedBy: 'openai', capabilities: [], contextLength: null, endpointTypes: null },
];

/**
 * 路由层类别准入用的 catalog 桩（ADR-0039）：**从 MODELS 现推**，不另写一份名字到类别的表 ——
 * 另写一份就等于 `typeOf` 与 `/v1/models` 会有两套事实，"列表里写着 embedding、闸口按 chat 判"
 * 这种漂移在单测里根本看不出来。未登记 → null（本闸不表态，交给引擎的候选集）。
 */
function stubCatalog(models: ModelDescriptor[] = MODELS): ModelCatalog {
  const byName = new Map(models.map((m) => [m.id, m.type]));
  return {
    listEnabledModels: async () => models,
    resolveUpstreamModel: (m: string) => m,
    typeOf: (m: string) => byName.get(m) ?? null,
  };
}

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
  /** 类别准入的判据来源（ADR-0039）；不传 = 用 MODELS 现推的那个桩 */
  catalog?: ModelCatalog;
}

async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify();
  const auth: GatewayAuth = options.auth ?? { authenticate: async (key) => (key === 'gk-ok' ? GROUP : null) };
  const { engine } = stubEngine();
  await app.register(gatewayRoutes, {
    engine: options.engine ?? engine,
    models: options.catalog ?? stubCatalog(),
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
    const body = res.json() as {
      object: string;
      data: Array<{ id: string; object: string; created: number; owned_by: string; capabilities: string[]; contextLength: number | null; endpointTypes: string[] | null; type: string }>;
    };
    assert.equal(body.object, 'list');
    assert.equal(body.data.length, MODELS.length);
    assert.deepEqual(
      body.data.map((m) => m.id),
      ['gpt-4o', 'deepseek-chat', 'text-embedding-3-small', 'dall-e-3'],
    );
    for (const m of body.data) {
      assert.equal(m.object, 'model');
      assert.ok(Number.isInteger(m.created) && m.created > 0, 'created 必须是秒级整数（契约 §0.2 时间口径）');
      assert.equal(typeof m.owned_by, 'string');
    }
    assert.equal(body.data[0]?.created, Math.floor(Date.parse('2026-10-06T00:00:00.000Z') / 1000));
    await app.close();
  });

  it('v1.11.0 只加字段：既有四字段零变更，新字段与档案逐项一致（契约 §10 / 验收 4）', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer gk-ok' } });

    assert.equal(res.statusCode, 200);
    const body = res.json() as { data: Array<Record<string, unknown>> };
    const first = body.data[0] as Record<string, unknown>;
    // 既有四字段原样在（新增不许把它们改名或删掉）
    assert.equal(first.id, 'gpt-4o');
    assert.equal(first.object, 'model');
    assert.equal(typeof first.created, 'number');
    assert.equal(first.owned_by, 'openai');
    // 新增字段：值取自 ModelDescriptor（实现侧来自同一份档案行）
    assert.deepEqual(first.capabilities, ['stream', 'vision']);
    assert.equal(first.contextLength, 128_000);
    assert.equal(first.endpointTypes, null, '本期恒 null = 未采集（§10 登记，不写"先加字段后补生产者"）');
    // v1.15.10 新增 `type`（ADR-0039）：准入按类别把关，就必须把类别告诉调用方，
    // 否则调用方只能盲试端点。与档案卡的 `ModelDto.type` 同源。
    assert.equal(first.type, 'chat', '类别随列表带出，且与准入闸读的是同一份 `models.type`');
    // [] 是「未探测/上游未给」，不是 null —— 第二条保持 []，不另立第二套空值语义
    const second = body.data[1] as Record<string, unknown>;
    assert.deepEqual(second.capabilities, []);
    assert.equal(second.contextLength, null);
    // 列表里三种类别都出得来（准入是写面的门，读面不受影响）
    assert.deepEqual(
      body.data.map((m) => m.type),
      ['chat', 'chat', 'embedding', 'image'],
    );
    await app.close();
  });

  it('同样要鉴权：无 key 不给模型清单', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    assert.equal(res.statusCode, 401);
    await app.close();
  });
});

describe('模型授权（v1.15.8 / ADR-0037）', () => {
  /** 授权了 `gpt-4o` 一把的组。 */
  const restricted = (authorizedModels: string[] | null): GatewayAuth => ({
    authenticate: async (key) => (key === 'gk-ok' ? { ...GROUP, authorizedModels } : null),
  });

  it('授权列表内的模型 → 放行，引擎真的收到了请求', async () => {
    const { engine, seen } = stubEngine();
    const app = await buildApp({ engine, auth: restricted(['gpt-4o']) });
    const res = await app.inject({
      method: 'POST',
      url: CHAT,
      headers: { authorization: 'Bearer gk-ok' },
      payload: chatPayload({ model: 'gpt-4o' }),
    });

    assert.equal(res.statusCode, 200);
    assert.equal(seen.length, 1, '授权放行必须是**真的**放行，不是"看起来放行"');
    assert.equal(seen[0]?.model, 'gpt-4o');
    await app.close();
  });

  it('授权列表外的模型 → 403 MODEL_NOT_AUTHORIZED + authentication_error + param=model，且一次上游都不敲', async () => {
    const { engine, seen } = stubEngine();
    const app = await buildApp({ engine, auth: restricted(['gpt-4o']) });
    const res = await app.inject({
      method: 'POST',
      url: CHAT,
      headers: { authorization: 'Bearer gk-ok' },
      payload: chatPayload({ model: 'deepseek-chat' }),
    });

    assert.equal(res.statusCode, 403);
    const err = assertOpenAIShape(res.json());
    assert.equal(err.code, GATEWAY_ERROR_CODES.MODEL_NOT_AUTHORIZED);
    assert.equal(err.type, 'authentication_error', '与 GROUP_DISABLED 同族：凭据对了、人不对');
    assert.equal((res.json() as { error: { param?: string } }).error.param, 'model');
    assert.equal(seen.length, 0, '授权失败是 0 次真实尝试：候选集根本没建（§10 的 0-attempt 判据）');
    await app.close();
  });

  it('embeddings 同一个门：列表内放行、列表外 403（两个 handler 都要有，漏一个就是绕过）', async () => {
    const { engine, seen } = stubEngine();
    const app = await buildApp({ engine, auth: restricted(['text-embedding-3-small']) });

    const denied = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: 'Bearer gk-ok' },
      payload: { model: 'deepseek-chat', input: 'hi' },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal((denied.json() as { error: { code: string } }).error.code, 'MODEL_NOT_AUTHORIZED');
    assert.equal(seen.length, 0);

    const allowed = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: 'Bearer gk-ok' },
      payload: { model: 'text-embedding-3-small', input: 'hi' },
    });
    assert.equal(allowed.statusCode, 200);
    assert.equal(seen.length, 1);
    await app.close();
  });

  it('`null`（不限）的组打任意模型都放行 —— 升级零行为变更', async () => {
    const { engine, seen } = stubEngine();
    const app = await buildApp({ engine, auth: restricted(null) });
    for (const model of ['gpt-4o', 'deepseek-chat', 'whatever-not-listed']) {
      // 注意最后一个：**不在 MODELS 里也放行** —— 授权层不是"模型是否存在"的校验层，
      // 它只管"这一组许不许用这个名字"；存在性由引擎侧的候选集去回答（503/404）。
      const res = await app.inject({
        method: 'POST',
        url: CHAT,
        headers: { authorization: 'Bearer gk-ok' },
        payload: chatPayload({ model }),
      });
      assert.equal(res.statusCode, 200, `model=${model}`);
    }
    assert.equal(seen.length, 3);
    await app.close();
  });

  it('授权列表按**字面**匹配，不特判 `*`（通配符归 key 白名单那一层）', async () => {
    const { engine, seen } = stubEngine();
    const app = await buildApp({ engine, auth: restricted(['*']) });
    const res = await app.inject({
      method: 'POST',
      url: CHAT,
      headers: { authorization: 'Bearer gk-ok' },
      payload: chatPayload({ model: 'gpt-4o' }),
    });

    assert.equal(res.statusCode, 403, '`*` 在授权层不是通配：要"不限"就用 null，不是写一个星号');
    assert.equal(seen.length, 0);
    await app.close();
  });

  it('授权门排在 readModel 之后：缺 model 报 400 而不是 403（名字都读不出来，谈不上授权）', async () => {
    const app = await buildApp({ auth: restricted(['gpt-4o']) });
    const res = await app.inject({
      method: 'POST',
      url: CHAT,
      headers: { authorization: 'Bearer gk-ok' },
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });

    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { error: { code: string } }).error.code, GATEWAY_ERROR_CODES.INVALID_REQUEST);
    await app.close();
  });

  it('`/v1/models` 不强制授权门，但**按组收窄**（列表 = enabled 判据 ∩ 该组授权）', async () => {
    const restrictedApp = await buildApp({ auth: restricted(['gpt-4o']) });
    const restrictedRes = await restrictedApp.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer gk-ok' },
    });
    assert.equal(restrictedRes.statusCode, 200, '读面不 403：调用方需要它来发现自己能用什么');
    assert.deepEqual(
      (restrictedRes.json() as { data: Array<{ id: string }> }).data.map((m) => m.id),
      ['gpt-4o'],
    );
    await restrictedApp.close();

    // 未授权收缩的组：集合与改版前**逐项相同**（既有验收 4 对存量组原样成立）
    const openApp = await buildApp({ auth: restricted(null) });
    const openRes = await openApp.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer gk-ok' } });
    assert.deepEqual(
      (openRes.json() as { data: Array<{ id: string }> }).data.map((m) => m.id),
      ['gpt-4o', 'deepseek-chat', 'text-embedding-3-small', 'dall-e-3'],
    );
    await openApp.close();
  });

  it('授权在鉴权那一刻读入：同一把 key、改授权后**下一个请求**即按新的判（不重启、不缓存）', async () => {
    const { engine, seen } = stubEngine();
    let authorized: string[] | null = ['gpt-4o'];
    const app = await buildApp({
      engine,
      // 每次 authenticate 都现读 `authorized` —— 这就是 `wiring/auth.ts` 实时读库的形状
      auth: { authenticate: async (key) => (key === 'gk-ok' ? { ...GROUP, authorizedModels: authorized } : null) },
    });

    const before = await app.inject({
      method: 'POST',
      url: CHAT,
      headers: { authorization: 'Bearer gk-ok' },
      payload: chatPayload({ model: 'deepseek-chat' }),
    });
    assert.equal(before.statusCode, 403);

    authorized = ['deepseek-chat'];
    const after = await app.inject({
      method: 'POST',
      url: CHAT,
      headers: { authorization: 'Bearer gk-ok' },
      payload: chatPayload({ model: 'deepseek-chat' }),
    });
    assert.equal(after.statusCode, 200, '改授权后下一个请求就生效（实时读，ADR-0037 决策 1）');
    assert.equal(seen.length, 1);
    await app.close();
  });

  it('组被禁用优先于授权：禁用组打**已授权**的模型仍是 403 GROUP_DISABLED（门序不能换）', async () => {
    const app = await buildApp({
      auth: { authenticate: async (key) => (key === 'gk-ok' ? { ...GROUP, enabled: false, authorizedModels: ['gpt-4o'] } : null) },
    });
    const res = await app.inject({
      method: 'POST',
      url: CHAT,
      headers: { authorization: 'Bearer gk-ok' },
      payload: chatPayload({ model: 'gpt-4o' }),
    });

    assert.equal(res.statusCode, 403);
    assert.equal(
      (res.json() as { error: { code: string } }).error.code,
      GATEWAY_ERROR_CODES.GROUP_DISABLED,
      '组禁用是"这一组谁都不许调"，比"这个模型许不许"更外层 —— 报 GROUP_DISABLED 才是正确的排障方向',
    );
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
