/**
 * 网关错误事件产出单测（契约 §10 / §12.1；ADR-0013 §7 端口签名、ADR-0014 关联键）
 *
 * 这一层盯的是**产出侧的事实**：谁在什么时候产了一条事件、那条事件里的每个字段是不是真的。
 * 「分型对不对」不在这里测 —— `category` / `severity` 由实现侧（`src/wiring/error-event-sink.ts`）
 * 从事实派生，网关根本不认识这两个概念（端口契约就是这么冻的）。这里只验网关报出来的事实：
 *   - 该产的产了：失败终态各一条，不多不少（成功路径零事件）
 *   - 不该产的不产：上游 4xx 透传、`GROUP_DISABLED`、非 `/v1/*` 的兜底 404
 *   - 同一个 429 的两种码值如实分开：`RATE_LIMITED` 与 `QUOTA_EXCEEDED` 不许被状态码糊成一个
 *   - 三个"不可互相反推"的字段各就各位：`gatewayCode`（§10 码）/ `failureReason`（换 key 枚举）/ `status`
 *   - 关联键：入站校验 → 响应头回写 → 透传上游 → 进事件，四处同值（ADR-0014）
 *
 * 用 `createGatewayStack` 而不是手搓引擎 + 路由：装配件本身也是被测对象 ——
 * 它必须把同一个 `errors` 同时接到引擎与路由层，漏接一边的表现是"事件流里只有一半失败"，
 * 那种缺口不会有任何报错，只能靠这里断言"两边都产得出"来钉。
 */

import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { describe, it } from 'vitest';

import { REQUEST_ID_HEADER, isValidRequestId } from '../util/request-id.js';
import type { FetchLike } from './engine.js';
import type { ErrorEventEntry, ErrorEventSink, GroupContext, ModelCatalog, SecretResolver, UpstreamTarget } from './ports.js';
import { gatewayRoutes } from './routes.js';
import { createGatewayStack } from './stack.js';
import type { GatewayStack } from './stack.js';
import type { KeyConfig, PoolSnapshot } from './types.js';

/* ------------------------------ 测试台 ------------------------------ */

const GROUP: GroupContext = { groupId: 'grp_1', name: '测试组', enabled: true, rpm: null, tpm: null, dailyQuota: null };
const GATEWAY_KEY = 'gk-ok';

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const COMPLETION = { id: 'cmpl_1', object: 'chat.completion', choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };

type Script = (url: string, init: RequestInit) => Response | Promise<Response>;

interface Call {
  url: string;
  init: RequestInit;
}

/** 记录型 sink：把入队的 entry 原样收下来（**不**做任何派生/归一化，那属于实现侧） */
function recordingSink(): ErrorEventSink & { entries: ErrorEventEntry[] } {
  const entries: ErrorEventEntry[] = [];
  return {
    entries,
    record(entry) {
      entries.push(entry);
    },
  };
}

interface Options {
  keys?: KeyConfig[];
  upstreams?: PoolSnapshot['upstreams'];
  steps?: Script[];
  group?: Partial<GroupContext>;
  /** 覆盖密钥解析（测「密文缺失」这类配置侧故障） */
  resolveSecret?: (keyId: string) => UpstreamTarget | null;
  /** 覆盖 sink（测「实现不守约」） */
  errors?: ErrorEventSink & { entries: ErrorEventEntry[] };
  maxAttempts?: number;
  upstreamTimeoutMs?: number;
}

interface Harness {
  app: FastifyInstance;
  stack: GatewayStack;
  entries: ErrorEventEntry[];
  calls: Call[];
}

async function setup(options: Options = {}): Promise<Harness> {
  const keys = options.keys ?? [keyConfig('k1'), keyConfig('k2')];
  const stackKeys = keys;

  const secrets: SecretResolver = {
    resolve:
      options.resolveSecret ??
      ((keyId) => {
        const found = stackKeys.find((k) => k.keyId === keyId);
        if (found === undefined) return null;
        return { upstreamId: found.upstreamId, baseUrl: `https://${found.upstreamId}.example.com/v1`, apiKey: `sk-${keyId}` };
      }),
  };

  const models: ModelCatalog = {
    listEnabledModels: async () => [{ id: 'gpt-4o', createdAt: '2026-10-06T00:00:00.000Z', ownedBy: 'up1' }],
    resolveUpstreamModel: (m) => m,
  };

  const group: GroupContext = { ...GROUP, ...options.group };
  const calls: Call[] = [];
  const steps = options.steps ?? [];
  let index = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const step = steps[index];
    index += 1;
    if (step === undefined) throw new Error(`unexpected fetch call #${index} to ${url}`);
    return step(url, init);
  };

  const sink = options.errors ?? recordingSink();
  const stack = createGatewayStack({
    secrets,
    models,
    auth: { authenticate: async (key) => (key === GATEWAY_KEY ? group : null) },
    errors: sink,
    fetchImpl,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.upstreamTimeoutMs === undefined ? {} : { upstreamTimeoutMs: options.upstreamTimeoutMs }),
  });
  stack.pool.applySnapshot(snapshot(keys, options.upstreams));

  const app = Fastify();
  await app.register(gatewayRoutes, stack.routes);
  await app.ready();

  return { app, stack, entries: sink.entries, calls };
}

function chatPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], ...over };
}

function post(h: Harness, url: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  return h.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${GATEWAY_KEY}`, ...headers }, payload });
}

/** 所有用例都只关心"这一条事件"的字段，用这个把断言写短 */
function only(h: Harness): ErrorEventEntry {
  assert.equal(h.entries.length, 1, `期望恰好 1 条错误事件，实际 ${h.entries.length} 条`);
  const [entry] = h.entries;
  assert.ok(entry);
  return entry;
}

/* ------------------------------ 用例 ------------------------------ */

describe('成功路径：不产事件', () => {
  it('非流式 200 / 流式 200 / /v1/models 都不产事件', async () => {
    const h = await setup({
      steps: [
        () => jsonResponse(COMPLETION),
        () =>
          new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      ],
    });

    assert.equal((await post(h, '/v1/chat/completions', chatPayload())).statusCode, 200);
    assert.equal((await post(h, '/v1/chat/completions', chatPayload({ stream: true }))).statusCode, 200);
    assert.equal((await h.app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${GATEWAY_KEY}` } })).statusCode, 200);

    assert.equal(h.entries.length, 0, '成功请求不许进事件流 —— 它是稀疏的失败流，不是访问日志');
  });
});

describe('转发侧失败终态（引擎产）', () => {
  it('无候选 key → 503 NO_AVAILABLE_KEY，且 attempts=0 / candidates=0', async () => {
    const h = await setup({ keys: [], steps: [] });
    const res = await post(h, '/v1/chat/completions', chatPayload());

    assert.equal(res.statusCode, 503);
    const entry = only(h);
    assert.equal(entry.status, 503);
    assert.equal(entry.gatewayCode, 'NO_AVAILABLE_KEY');
    assert.equal(entry.attempts, 0, '一次都没发出去');
    assert.equal(entry.candidates, 0, '池里根本没有候选 —— 与下面那条同码不同因的 503 靠这个数分开');
    assert.equal(entry.failureReason, null, '没碰到任何 key，谈不上 key 故障原因');
    assert.equal(entry.keyId, '', '空串 = 没有"某把 key"可言（端口约定）');
    assert.equal(entry.upstreamId, '');
    assert.equal(entry.upstreamStatus, null);
    assert.equal(entry.endpoint, '/v1/chat/completions');
    assert.equal(entry.clientModel, 'gpt-4o');
    assert.equal(entry.stream, false);
    assert.equal(h.calls.length, 0, '候选为空时一个出站请求都不该发');
  });

  it('候选存在但密文解不出 → 503，且 attempts=0 / candidates>0（配置侧异常，与上一条同码不同因）', async () => {
    const h = await setup({ keys: [keyConfig('k1')], resolveSecret: () => null, steps: [] });
    const res = await post(h, '/v1/chat/completions', chatPayload());

    assert.equal(res.statusCode, 503);
    const entry = only(h);
    assert.equal(entry.gatewayCode, 'NO_AVAILABLE_KEY');
    assert.equal(entry.attempts, 0);
    assert.equal(entry.candidates, 1, '候选是有的，只是解不出密文 —— 值班靠 candidates>0 + attempts=0 指到配置侧');
    assert.equal(h.calls.length, 0);
  });

  it('上游全失败 → 502 UPSTREAM_ERROR，保留最后一次失败原因与上游状态', async () => {
    const h = await setup({
      steps: [() => jsonResponse({ error: { message: 'bad key' } }, 401), () => jsonResponse({ error: { message: 'bad key' } }, 401)],
    });
    const res = await post(h, '/v1/chat/completions', chatPayload());

    assert.equal(res.statusCode, 502);
    const entry = only(h);
    assert.equal(entry.status, 502);
    assert.equal(entry.gatewayCode, 'UPSTREAM_ERROR');
    assert.equal(entry.failureReason, 'AUTH_INVALID', '「502 里藏着 401」完全是另一种处置，这个枚举必须留下来');
    assert.equal(entry.upstreamStatus, 401, '与 failureReason 同一层的原始状态，两者不可互相反推');
    assert.equal(entry.attempts, 2);
    assert.equal(entry.candidates, 2);
    assert.equal(entry.keyId, '', '全试完了：没有"那把 key"可言（与 usage_logs 的 key_id=NULL 同约定）');
    assert.equal(entry.upstreamId, '');
  });

  it('上游首字节超时 → 504 UPSTREAM_TIMEOUT', async () => {
    const h = await setup({
      upstreamTimeoutMs: 5,
      steps: [
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')));
          }),
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ],
    });
    const res = await post(h, '/v1/chat/completions', chatPayload());

    assert.equal(res.statusCode, 504);
    const entry = only(h);
    assert.equal(entry.gatewayCode, 'UPSTREAM_TIMEOUT');
    assert.equal(entry.failureReason, 'NETWORK');
    assert.equal(entry.upstreamStatus, null, '连响应头都没拿到，没有上游状态可言（null ≠ 0）');
  });

  it('客户端中途断开 → 499，gatewayCode=null（§10 里没有这个码），且 keyId 是"在飞的那把"不是"坏了的那把"', async () => {
    const client = new AbortController();
    const h = await setup({
      keys: [keyConfig('k1')],
      steps: [
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')));
            client.abort(); // 建连过程中客户端跑了
          }),
      ],
    });

    const result = await h.stack.engine.chatCompletions({
      group: GROUP,
      model: 'gpt-4o',
      body: chatPayload(),
      stream: false,
      requestId: 'req-abort-0001',
      signal: client.signal,
    });

    assert.equal(result.kind, 'error');
    assert.equal(result.kind === 'error' ? result.error.httpStatus : 0, 499);
    const entry = only(h);
    assert.equal(entry.status, 499);
    assert.equal(entry.gatewayCode, null, '编一个 §10 里不存在的码会让调用方去表里找它');
    assert.equal(entry.failureReason, null, '用户按 ESC 不能被读成一次 key 故障');
    assert.equal(entry.keyId, 'k1', '记的是"当时正在打哪把"，不是"哪把坏了"');
    assert.equal(entry.requestId, 'req-abort-0001');
  });

  it('流中途上游断 → 502，stream=true 且以上游给过的状态为准', async () => {
    const firstChunk = 'data: {"choices":[{"delta":{"content":"你"}}]}\n\n';
    let reads = 0;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        if (reads === 1) {
          controller.enqueue(new TextEncoder().encode(firstChunk));
          return;
        }
        controller.error(new Error('upstream connection reset'));
      },
    });

    const h = await setup({
      keys: [keyConfig('k1')],
      steps: [() => new Response(broken, { status: 200, headers: { 'content-type': 'text/event-stream' } })],
    });

    const result = await h.stack.engine.chatCompletions({
      group: GROUP,
      model: 'gpt-4o',
      body: chatPayload({ stream: true }),
      stream: true,
      requestId: 'req-stream-0001',
    });
    assert.equal(result.kind, 'stream');
    if (result.kind !== 'stream') return;
    // 必须把流读完，结算发生在流生命周期里（没读完就没有终态，也就没有事件）
    const reader = result.body.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done === true) break;
    }

    const entry = only(h);
    assert.equal(entry.status, 502);
    assert.equal(entry.gatewayCode, 'UPSTREAM_ERROR');
    assert.equal(entry.failureReason, 'NETWORK');
    assert.equal(entry.stream, true, '同一次故障在流式与非流式下必须能分开');
    assert.equal(entry.upstreamStatus, 200, '「说好了 200 然后掉线」这件事本身是线索');
    assert.equal(entry.keyId, 'k1');
  });

  it('上游 4xx 透传 → 不产事件（网关这边没有失败，诊断信息在上游给的那份响应里）', async () => {
    const h = await setup({ steps: [() => jsonResponse({ error: { message: 'messages must not be empty' } }, 422)] });
    const res = await post(h, '/v1/chat/completions', chatPayload());

    assert.equal(res.statusCode, 422, '原样透传，不包成 502');
    assert.equal(h.entries.length, 0, '为此要编一个 §10 表里不存在的码，编出来的码会污染「码值→分型」的映射');
  });
});

describe('被拒的请求（路由层产）', () => {
  it('缺凭证 → 401 AUTH_FAILED，且不带 clientModel（未鉴权不读 body）', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: chatPayload() });

    assert.equal(res.statusCode, 401);
    const entry = only(h);
    assert.equal(entry.status, 401);
    assert.equal(entry.gatewayCode, 'INVALID_API_KEY');
    assert.equal(entry.clientModel, null, '未通过鉴权的请求不该有往事件表里写字段的能力（哪怕只是个模型名）');
    assert.equal(entry.stream, false);
    assert.equal(entry.keyId, '');
    assert.equal(entry.attempts, 0);
    assert.equal(entry.candidates, null, '没走到选路，"候选数"不适用（与 503 的 candidates=0 不是一回事）');
    assert.equal(entry.message, 'missing bearer gateway key');
  });

  it('用户组被禁用 → 403，**不产事件**（该分型尚未登记进契约，见回报）', async () => {
    const h = await setup({ group: { enabled: false } });
    const res = await post(h, '/v1/chat/completions', chatPayload());

    assert.equal(res.statusCode, 403);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'GROUP_DISABLED');
    assert.equal(h.entries.length, 0, '§10 无此码、§12.1 无对应分型：往主诊断库里写一条已知错误的分型比留下缺口更糟');
  });

  it('同一个 429 的两种码值如实分开：RPM 限流 vs 日配额用尽', async () => {
    const limited = await setup({ group: { rpm: 1 }, steps: [() => jsonResponse(COMPLETION)] });
    assert.equal((await post(limited, '/v1/chat/completions', chatPayload())).statusCode, 200);
    const limitedRes = await post(limited, '/v1/chat/completions', chatPayload());

    assert.equal(limitedRes.statusCode, 429);
    assert.equal(limitedRes.headers['retry-after'], '1');
    const rateEntry = only(limited);
    assert.equal(rateEntry.status, 429);
    assert.equal(rateEntry.gatewayCode, 'RATE_LIMITED');
    assert.equal(rateEntry.clientModel, 'gpt-4o', '这条在鉴权之后，模型名可以记');

    // 日配额：第一次成功请求回填 120 token > quota 100 → 第二次被配额挡住
    const quota = await setup({ group: { dailyQuota: 100 }, steps: [() => jsonResponse(COMPLETION)] });
    assert.equal((await post(quota, '/v1/chat/completions', chatPayload())).statusCode, 200);
    const quotaRes = await post(quota, '/v1/chat/completions', chatPayload());

    assert.equal(quotaRes.statusCode, 429);
    const quotaEntry = only(quota);
    assert.equal(quotaEntry.status, 429, '与上一条**状态码相同**');
    assert.equal(quotaEntry.gatewayCode, 'QUOTA_EXCEEDED', '码值不同 → 分出来的 category 不同：一个退避重试，一个今天别来了');
  });

  it('参数校验 400 → INVALID_REQUEST，事件与响应共用同一份文案', async () => {
    const h = await setup();
    const res = await post(h, '/v1/chat/completions', chatPayload({ model: '' }));

    assert.equal(res.statusCode, 400);
    const body = res.json() as { error: { code: string; message: string; param?: string } };
    assert.equal(body.error.code, 'INVALID_REQUEST');
    assert.equal(body.error.param, 'model', 'param 只进响应体：排障侧靠 message 定位字段');

    const entry = only(h);
    assert.equal(entry.gatewayCode, 'INVALID_REQUEST');
    assert.equal(entry.message, body.error.message, '事件与响应必须逐字一致，否则两边对不上账');
    assert.equal(entry.endpoint, '/v1/chat/completions');
  });

  it('未知端点 404 / 未实现端点 501，各产一条且码值不同', async () => {
    const h = await setup();
    const missing = await post(h, '/v1/nope', chatPayload());
    const unsupported = await post(h, '/v1/images/generations', chatPayload());

    assert.equal(missing.statusCode, 404);
    assert.equal(unsupported.statusCode, 501);
    assert.equal(h.entries.length, 2);
    assert.deepEqual(
      h.entries.map((e) => [e.status, e.gatewayCode]).sort((a, b) => Number(a[0]) - Number(b[0])),
      [
        [404, 'NOT_FOUND'],
        [501, 'UNSUPPORTED_ENDPOINT'],
      ],
    );
    assert.ok(h.entries.every((e) => e.attempts === 0 && e.keyId === ''));
  });

  it('非 /v1/* 的兜底 404 不产事件（扫描器的噪声不许把真实故障挤出队列）', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/wp-admin.php' });

    assert.equal(res.statusCode, 404);
    assert.equal(h.entries.length, 0, '队列满时丢的是最旧的一批 —— 也就是真实故障');
  });

  it('事件里只记路径，不带查询串', async () => {
    const h = await setup();
    await post(h, '/v1/chat/completions?trace=1&nonce=abc', chatPayload({ model: '' }));

    assert.equal(only(h).endpoint, '/v1/chat/completions', '?x=1 是每次调用都不同的噪声，只会把同一个端点拆成无数条');
  });

  it('sink 实现不守约（record 抛异常）时，转发结果不受影响', async () => {
    const h = await setup({
      steps: [() => jsonResponse(COMPLETION)],
      errors: {
        entries: [],
        record() {
          throw new Error('sink 坏了');
        },
      },
    });

    assert.equal((await post(h, '/v1/chat/completions', chatPayload())).statusCode, 200, '观测出口坏了不能连累转发');
    const rejected = await h.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: chatPayload() });
    assert.equal(rejected.statusCode, 401, '被拒的响应本来就该照常回给客户端');
  });
});

describe('关联键 x-request-id（ADR-0014）', () => {
  it('入站合法值 → 响应头沿用，且事件里是同一个值', async () => {
    const inbound = 'req-abc12345';
    const h = await setup({ steps: [() => jsonResponse({ error: { message: 'bad key' } }, 401), () => jsonResponse({ error: { message: 'bad key' } }, 401)] });
    const res = await post(h, '/v1/chat/completions', chatPayload(), { [REQUEST_ID_HEADER]: inbound });

    assert.equal(res.headers[REQUEST_ID_HEADER], inbound);
    assert.equal(only(h).requestId, inbound, '同一次调用在事件表里必须能和调用方手上的回执对上');
  });

  it('入站非法值 → 重新生成（头不合法不是请求错误，请求照常处理）', async () => {
    // 不带凭证：这样"请求照常处理"的结果是一个确定的状态（401），事件也就必然产得出来
    // （如果能上到 400，说明坏头被当成了参数错误 —— 那正是本用例要钉住的反面）。
    const h = await setup();
    const res = await h.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { [REQUEST_ID_HEADER]: 'x' }, payload: chatPayload() });

    assert.equal(res.statusCode, 401, '坏头不得把请求打成 400');
    const echoed = res.headers[REQUEST_ID_HEADER];
    assert.equal(typeof echoed, 'string');
    assert.notEqual(echoed, 'x', '短到 8 位以下的占位符收下来只会让两列看着有值、实际对不上');
    assert.ok(isValidRequestId(echoed));
    assert.equal(only(h).requestId, echoed);
  });

  it('入站完全没有这个头 → 也一定回写（调用方按回执排障，不靠猜）', async () => {
    // 这一条盯的是"**一定**回写"里的那个"一定"：连鉴权都没过、连 body 都不读的响应，
    // 也必须带上关联键 —— 调用方手上唯一的回执就是它。
    const h = await setup();
    const res = await h.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: chatPayload() });

    assert.equal(res.statusCode, 401);
    const echoed = res.headers[REQUEST_ID_HEADER];
    assert.ok(isValidRequestId(echoed), `回写的必须是合法关联键，实际 ${String(echoed)}`);
    assert.equal(only(h).requestId, echoed);
  });

  it('原样透传上游：出站请求头里是同一个值', async () => {
    const inbound = 'req-upstream-01';
    const h = await setup({ keys: [keyConfig('k1')], steps: [() => jsonResponse(COMPLETION)] });
    await post(h, '/v1/chat/completions', chatPayload(), { [REQUEST_ID_HEADER]: inbound });

    const [call] = h.calls;
    assert.ok(call);
    assert.equal((call.init.headers as Record<string, string>)[REQUEST_ID_HEADER], inbound);
  });
});
