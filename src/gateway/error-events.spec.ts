/**
 * 网关错误事件产出单测（契约 §10 / §12.1；ADR-0013 §7 端口签名、ADR-0014 关联键）
 *
 * 这一层盯的是**产出侧的事实**：谁在什么时候产了一条事件、那条事件里的每个字段是不是真的。
 * 「分型对不对」不在这里测 —— `category` / `severity` 由实现侧（`src/wiring/error-event-sink.ts`）
 * 从事实派生，网关根本不认识这两个概念（端口契约就是这么冻的）。这里只验网关报出来的事实：
 *   - 该产的产了：失败终态各一条，不多不少（成功路径零事件）
 *   - 不该产的不产：上游 4xx 透传、Fastify 自产的 413/415、非 `/v1/*` 的兜底 404
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

import { egressIdOfUrl } from '../egress/port.js';
import type { EgressGate } from '../egress/port.js';
import { keyFingerprint } from '../util/redact.js';
import { REQUEST_ID_HEADER, isValidRequestId } from '../util/request-id.js';
import { createEgressGate } from './egress.js';
import type { FetchLike } from './engine.js';
import type { ErrorEventEntry, ErrorEventSink, GroupContext, ModelCatalog, SecretResolver, UpstreamTarget } from './ports.js';
import { gatewayRoutes } from './routes.js';
import { createGatewayStack } from './stack.js';
import type { GatewayStack } from './stack.js';
import type { KeyConfig, PoolSnapshot } from './types.js';

/* ------------------------------ 测试台 ------------------------------ */

const GROUP: GroupContext = { groupId: 'grp_1', name: '测试组', enabled: true, rpm: null, tpm: null, dailyQuota: null, authorizedModels: null };
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
    depleted: false,
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
  /** 出口闸（v1.17.2：测 egress-429 与出口冷却跳过终态的两条 key 腿） */
  egress?: EgressGate;
  /** keyId → accountId；缺省 `null`（无主 key）。出口归因判据按账号去重，凑 N 个账号要用它 */
  accounts?: Record<string, string>;
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
        // 出口口径同 `secrets.ts`：桩里没有台账 ⇒ Tier 1 按 base URL 推导（见 engine.spec.ts 的 upstreamTarget）
        const baseUrl = `https://${found.upstreamId}.example.com/v1`;
        return {
          upstreamId: found.upstreamId,
          baseUrl,
          apiKey: `sk-${keyId}`,
          egressId: egressIdOfUrl(baseUrl),
          accountId: options.accounts?.[keyId] ?? null,
        };
      }),
  };

  const models: ModelCatalog = {
    listEnabledModels: async () => [
      { id: 'gpt-4o', type: 'chat', createdAt: '2026-10-06T00:00:00.000Z', ownedBy: 'up1', capabilities: [], contextLength: null, endpointTypes: null },
    ],
    resolveUpstreamModel: (m) => m,
    typeOf: (m) => (m === 'gpt-4o' ? 'chat' : null),
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
    ...(options.egress === undefined ? {} : { egress: options.egress }),
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
    // v1.17.2 / ADR-0042 语义修订：keyId = 「最后摸过的那把」，不再是空串。
    // 它**不代表 k2 坏了**（是轮换停在它身上），判罪要看 attemptTrail —— 这正是本用例同时钉的：
    // 顺序 = 尝试次序，两把各自的死法都在。
    assert.equal(entry.keyId, 'k2', '最后摸过的那把（§12.1 语义修订：不等于"它坏了"）');
    assert.ok(entry.attemptTrail, '502 全灭必须带尝试明细');
    const trail = entry.attemptTrail!;
    assert.ok(trail.length >= 2 && trail[0]!.keyId === 'k1' && trail[1]!.keyId === 'k2', `trail 按尝试次序：${JSON.stringify(trail)}`);
    assert.equal(trail[0]!.reason, 'AUTH_INVALID');
    assert.equal(trail[0]!.status, 401);
  });

  it('v1.17.2 变异锚点：删掉 502 终态的 keyId/trail 填数 → 本用例红', async () => {
    // 上一用例已把两腿都钉住；这里单独把"trail 与 keyId 同源（最后一把一致）"钉死，
    // 防止有人只补 keyId 不补 trail（或反之）—— 502 行"要配 attemptTrail 一起读"的承诺成立。
    const h = await setup({
      steps: [() => jsonResponse({ error: { message: 'boom' } }, 500), () => jsonResponse({ error: { message: 'boom' } }, 500)],
    });
    const res = await post(h, '/v1/chat/completions', chatPayload());
    assert.equal(res.statusCode, 502);
    const entry = only(h);
    const trail = entry.attemptTrail!;
    assert.equal(trail[trail.length - 1]!.keyId, entry.keyId, 'trail 最后一把必须就是 keyId 那把（同源，不得各挑各的）');
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

  it('用户组被禁用 → 403 GROUP_DISABLED，**产事件**且带 clientModel（403 已过鉴权）', async () => {
    const h = await setup({ group: { enabled: false } });
    const res = await post(h, '/v1/chat/completions', chatPayload({ stream: true }));

    assert.equal(res.statusCode, 403);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'GROUP_DISABLED');
    // 契约 v1.1.2 已把此码登记进 §10 并归入 `AUTH_FAILED`（ADR-0013 落地补遗）→ 开始产事件。
    const entry = only(h);
    assert.equal(entry.status, 403);
    assert.equal(entry.gatewayCode, 'GROUP_DISABLED');
    assert.equal(
      entry.clientModel,
      'gpt-4o',
      '403 在鉴权之后：key 有效、只是组被禁用 —— 「未过鉴权才不读 body」的收窄不该连带 403 一起变成 null',
    );
    assert.equal(entry.stream, true, '同上：body 可读，stream 必须如实填');
    assert.equal(entry.failureReason, null, '没碰过任何上游：没有"换 key 枚举"可言');
    assert.equal(entry.keyId, '', '组级拒绝不指向某把 key');
    assert.equal(entry.upstreamId, '');
    assert.equal(entry.upstreamStatus, null);
    assert.equal(entry.attempts, 0);
    assert.equal(entry.candidates, null, '没走到选路，与 503 的 candidates=0 不是一回事');
    assert.equal(entry.message, 'user group is disabled');
  });

  it('组未被授权这个模型 → 403 MODEL_NOT_AUTHORIZED，事件**同源**且 0 次真实尝试（v1.15.8 / ADR-0037）', async () => {
    const h = await setup({ group: { authorizedModels: ['gpt-4o'] } });
    const res = await post(h, '/v1/chat/completions', chatPayload({ model: 'deepseek-chat', stream: true }));

    assert.equal(res.statusCode, 403);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'MODEL_NOT_AUTHORIZED');
    const entry = only(h);
    // 事件与响应同源（同一个 message、同一个码）—— 这条是"§10 的 0-attempt 判据在授权门上原样成立"的证据
    assert.equal(entry.status, 403);
    assert.equal(entry.gatewayCode, 'MODEL_NOT_AUTHORIZED');
    assert.equal(entry.clientModel, 'deepseek-chat', '授权门在鉴权之后：body 可读，clientModel 必须如实填');
    assert.equal(entry.stream, true);
    assert.equal(entry.failureReason, null, '没碰过任何上游：没有"换 key 枚举"可言');
    assert.equal(entry.keyId, '', '组级拒绝不指向某把 key');
    assert.equal(entry.upstreamId, '');
    assert.equal(entry.upstreamStatus, null);
    assert.equal(entry.attempts, 0, '候选集根本没建');
    assert.equal(entry.candidates, null, '没走到选路，与 503 的 candidates=0 不是一回事');
    assert.equal(entry.message, 'model not authorized for this group: deepseek-chat');
    // 没有一条 fetch 打出去 —— 与断言 attempts=0 是两件事：这个是**真的**没发
    assert.equal(h.calls.length, 0, '0 次真实尝试：一次上游请求都不许敲');
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

/* ---------------- v1.17.2 / ADR-0042：key 标识三腿逐腿钉 ---------------- */

// 业主裁定「B：全带」之后的验收面。此前 115 条 `skippedEgress` 终态全落裸 `****`，
// 组级拒绝与 401 各缺一条腿 —— 本组用例按 ADR-0042 验证清单逐腿钉死，且按业主纪律
// 各留变异锚点（删掉实现侧填数 → 对应用例红）。
describe('key 标识三腿（v1.17.2 / ADR-0042）', () => {
  it('上游腿：egress-429 终态带 keyId（案发位置，≠ 记过）+ trail', async () => {
    // 出口归因判据按**账号**去重（N=3）：两把不同账号的 key 各撞一次 429 判 key 级，
    // 第三把再撞才判出口级 —— 恰好把「前两把走轮换、第三把收口」的形状摆出来。
    const gate = createEgressGate({ mode: 'active' });
    const h = await setup({
      keys: [keyConfig('k1', 'up1', { models: null }), keyConfig('k2', 'up1', { models: null }), keyConfig('k3', 'up1', { models: null })],
      accounts: { k1: 'acc-1', k2: 'acc-2', k3: 'acc-3' },
      egress: gate,
      steps: [
        () => jsonResponse({ error: { message: 'rate limited' } }, 429),
        () => jsonResponse({ error: { message: 'rate limited' } }, 429),
        () => jsonResponse({ error: { message: 'rate limited' } }, 429),
      ],
    });

    const res = await post(h, '/v1/chat/completions', chatPayload());
    assert.equal(res.statusCode, 429, '第三把 429 被判出口级：不换 key、合成 429 收口');
    const entry = only(h);
    assert.equal(entry.status, 429);
    assert.equal(entry.gatewayCode, 'RATE_LIMITED');
    // 三个账号 + 同一出口 ⇒ 出口级：出口进冷却、**不**记 key 失败（ADR-0021 原样）
    assert.ok(h.entries.every((e) => e.attemptTrail !== undefined));
    assert.equal(entry.keyId, 'k3', '「当时正在用哪把」—— 此前这里落的是空串（裸 **** 的根因）');
    assert.equal(entry.upstreamId, 'up1');
    assert.equal(entry.attempts, 3);
    const trail = entry.attemptTrail!;
    assert.equal(trail.length, 3, '三次真实尝试逐把在案');
    assert.equal(trail[2]!.keyId, 'k3', 'trail 最后一把 = 终态 keyId（同源）');
    assert.equal(trail[2]!.reason, 'RATE_LIMITED');
    assert.equal(trail[2]!.status, 429);
    // ADR-0021 边界：出口级 429 **不** reportFailure —— keyId 是位置不是过错，
    // 这条判据由 engine.spec 的冷却断言持有，这里只钉「事件侧照实带位置」。
  });

  it('上游腿：出口冷却跳过终态带「第一把被跳过的候选」（没被敲过、也没被记过）', async () => {
    // 让出口先冷下来（active 判据 3 个账号），再用同一个闸发起第二轮 ——
    // 两把候选全在冷却的出口后面：attempts=0、skippedEgress=2，终态 429。
    const gate = createEgressGate({ mode: 'active' });
    const warm = await setup({
      keys: [keyConfig('k1', 'up1', { models: null }), keyConfig('k2', 'up1', { models: null }), keyConfig('k3', 'up1', { models: null })],
      accounts: { k1: 'acc-1', k2: 'acc-2', k3: 'acc-3' },
      egress: gate,
      steps: [
        () => jsonResponse({ error: { message: 'rate limited' } }, 429),
        () => jsonResponse({ error: { message: 'rate limited' } }, 429),
        () => jsonResponse({ error: { message: 'rate limited' } }, 429),
      ],
    });
    await post(warm, '/v1/chat/completions', chatPayload());

    const h = await setup({
      keys: [keyConfig('k9', 'up1', { models: null }), keyConfig('k8', 'up1', { models: null })],
      accounts: { k9: 'acc-9', k8: 'acc-8' },
      egress: gate, // 同一个闸：up1.example.com 仍在冷却
    });

    const res = await post(h, '/v1/chat/completions', chatPayload());
    assert.equal(res.statusCode, 429, '两把候选都在冷却出口后面 ⇒ 429 + Retry-After，不是 502');
    assert.equal(h.calls.length, 0, '一次都没真敲上游');
    const entry = only(h);
    assert.equal(entry.gatewayCode, 'RATE_LIMITED');
    assert.equal(entry.attempts, 0);
    // v1.17.2 修订：此前这条终态 keyId 恒空串 —— 那正是 115 条裸 **** 事件的主力。
    // 现在带「第一把被跳过的候选」：诚实边界 = 它没被敲过也没被记过，掩码只回答
    // 「谁被困在这个出口后面」（案发位置的投影，非过错归因）。
    assert.equal(entry.keyId, 'k9', '第一把被跳过的候选（轮换起点）');
    assert.equal(entry.upstreamId, 'up1');
    assert.equal(entry.attemptTrail, undefined, '0 次真实尝试 ⇒ 无 trail（没有"怎么死的"可记）');
  });

  it('客户端腿：组级 429 带 clientKeyMasked，且上游腿保持空（0 次真实尝试）', async () => {
    const h = await setup({ group: { rpm: 1, gatewayKeyMasked: '****abcd' }, steps: [() => jsonResponse(COMPLETION)] });
    assert.equal((await post(h, '/v1/chat/completions', chatPayload())).statusCode, 200);
    const res = await post(h, '/v1/chat/completions', chatPayload());
    assert.equal(res.statusCode, 429);

    const entry = only(h);
    assert.equal(entry.gatewayCode, 'RATE_LIMITED');
    assert.equal(entry.clientKeyMasked, '****abcd', '「谁的调用被限了」——此前这条腿恒 null');
    assert.equal(entry.keyId, '', '组级拒绝不指向任何上游 key（两条腿不得互相顶替）');
    assert.equal(entry.attempts, 0);
    assert.equal(entry.attemptTrail, undefined);
    assert.equal(entry.clientModel, 'gpt-4o');
  });

  it('客户端腿：403 已过鉴权同样带掩码（GROUP_DISABLED / MODEL_NOT_AUTHORIZED）', async () => {
    const disabled = await setup({ group: { enabled: false, gatewayKeyMasked: '****disa' } });
    await post(disabled, '/v1/chat/completions', chatPayload());
    assert.equal(only(disabled).clientKeyMasked, '****disa');

    const unauthorized = await setup({ group: { authorizedModels: ['gpt-4o'], gatewayKeyMasked: '****unau' } });
    await post(unauthorized, '/v1/chat/completions', chatPayload({ model: 'deepseek-chat' }));
    const entry = only(unauthorized);
    assert.equal(entry.clientKeyMasked, '****unau');
    assert.equal(entry.invalidKeyFingerprint, null, '403 不是废 key：无指纹可言');
  });

  it('来源腿：401 废 key 带 sourceIp + 指纹；missing bearer 只有 sourceIp；指纹不可反推', async () => {
    // 401 invalid key（带了 Bearer）：指纹 = sha256 前 8 hex，与 keyFingerprint 同源
    const h = await setup();
    const bogus = 'gw-bogus-key-that-does-not-exist';
    const res = await post(h, '/v1/chat/completions', chatPayload(), { authorization: `Bearer ${bogus}` });
    assert.equal(res.statusCode, 401);
    const entry = only(h);
    assert.equal(entry.sourceIp, '127.0.0.1', 'socket 层 IP（inject 的本机回环），全事件都记');
    assert.equal(entry.invalidKeyFingerprint, keyFingerprint(bogus), '同一把废 key 的指纹恒同值（可归并）');
    assert.ok(/^[0-9a-f]{8}$/.test(entry.invalidKeyFingerprint!), '前 8 hex：保归并、砍掉与 key_hash 等值比对的能力');
    assert.equal(entry.clientKeyMasked, null, '401 恒无客户端腿：不给匿名请求"这把 key 存不存在"的反馈');
    assert.notEqual(entry.invalidKeyFingerprint, bogus, '指纹不是掩码也不是明文');

    // missing bearer：无值可指纹 —— sourceIp 照记（撞库探测照样可归并来源）
    const bare = await setup();
    const bareRes = await bare.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: chatPayload() });
    assert.equal(bareRes.statusCode, 401);
    const bareEntry = only(bare);
    assert.equal(bareEntry.sourceIp, '127.0.0.1');
    assert.equal(bareEntry.invalidKeyFingerprint, null, '没带 key 就没有指纹（null ≠ 空指纹串）');
    assert.equal(bareEntry.clientKeyMasked, null);
  });

  it('变异锚点：engine.ts egress-429 keyId 填数被删 → 本组第一条红（红即有效）', async () => {
    // 上一条已把 egress-429 的 keyId/trail 钉住；本条把「组级 429 与 egress-429 可区分」
    // 钉死 —— 两者 gatewayCode 同为 RATE_LIMITED，区分点只在腿上：
    // 组级 = clientKeyMasked 有 / keyId 空；egress 级 = keyId 有 / clientKeyMasked 空。
    // 若实现侧把 egress-429 的 keyId 填数删了，两者将不可区分（keyId 都为空）。
    const gate = createEgressGate({ mode: 'active' });
    const h = await setup({
      keys: [keyConfig('k1', 'up1', { models: null }), keyConfig('k2', 'up1', { models: null }), keyConfig('k3', 'up1', { models: null })],
      accounts: { k1: 'acc-1', k2: 'acc-2', k3: 'acc-3' },
      egress: gate,
      steps: [
        () => jsonResponse({ error: { message: 'rate limited' } }, 429),
        () => jsonResponse({ error: { message: 'rate limited' } }, 429),
        () => jsonResponse({ error: { message: 'rate limited' } }, 429),
      ],
    });
    await post(h, '/v1/chat/completions', chatPayload());
    const entry = only(h);
    assert.ok(entry.keyId !== '' && entry.clientKeyMasked == null, 'egress-429：上游腿有、客户端腿无（与组级 429 恰互补）');
  });
});
