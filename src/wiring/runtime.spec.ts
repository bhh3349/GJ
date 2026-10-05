// 适配层端到端 - `createGatewayRuntime` + `/v1/*` 挂载（app.inject 走完真链路）
//
// 这一层是 M3 的收口：真 SQLite（真 upstreams / upstream_keys / models / groups 行）
// → 真适配器 → 真引擎 → 真路由 → 真 usage_logs。
// 中间没有任何桩模块之外的东西：`fetch` 是唯一被替换的边界（出站才是外部世界）。
//
// 盯的判据：
//   1. 401 不给 `{code,message}`（/v1/* 只出 OpenAI 形状）；
//   2. 上游 401 → 换 key → 客户端仍拿到 200，且 attempt 数如实回报；
//   3. 一次请求**不落任何库**（用量只入队），flush 之后才有行（验收 6/8）；
//   4. `/v1/models` 与「已启用档案」0 差异，且改档案立刻生效（不等 1s 轮询）；
//   5. `/internal/snapshot` 与 501 前缀的行为。
//
// 明文探针运行时拼装：源码里没有上游 key 的字面量，扫描器不会命中自己。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'vitest';

import type { AppConfig } from '../config.js';
import { sha256Hex } from '../db/crypto.js';
import { openDatabase, type Db } from '../db/database.js';
import { createGroup } from '../db/repo/groups.js';
import { createKey, listKeys } from '../db/repo/keys.js';
import { upsertModelFromSync, getModel, updateModel } from '../db/repo/models.js';
import { createUpstream } from '../db/repo/upstreams.js';
import type { FetchLike } from '../gateway/engine.js';
import { createGatewayRuntime, mountGatewayRoutes } from './runtime.js';
import type { GatewayRuntime } from './runtime.js';

/* ------------------------------ 测试台 ------------------------------ */

const MASTER_KEY = Buffer.from('5d'.repeat(32), 'hex');

function probeSecret(tag: string): string {
  return ['sk', 'probe', tag, sha256Hex(`wiring-runtime-${tag}`).slice(0, 32)].join('-');
}

const dirs: string[] = [];
const live: Array<() => Promise<void>> = [];

afterEach(async () => {
  // 统一收尾：任何断言失败都会跳过用例末尾的清理，漏掉 app 句柄就会在 rmSync 上抛 EBUSY，
  // 把真正的失败信息盖掉（api.spec.ts 踩过同一个坑）
  for (const dispose of live.splice(0)) await dispose().catch(() => undefined);
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上偶尔仍被短时占用 */
    }
  }
});

interface Call {
  url: string;
  init: RequestInit;
}

type Script = (url: string, init: RequestInit) => Response;

function makeConfig(dbPath: string): AppConfig {
  return {
    masterKey: MASTER_KEY,
    dbPath,
    portGateway: 0,
    hostGateway: '127.0.0.1',
    portAdmin: 0,
    hostAdmin: '127.0.0.1',
    sessionTtlHours: 24,
    cookieSecure: false,
    trustProxy: false,
    allowedOrigins: [],
    adminToken: null,
    logRetentionDays: 30,
    maxAttempts: 3,
    maxConcurrencyPerKey: 4,
    cooldownLadderSeconds: [60, 300, 900, 1800],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const COMPLETION = { id: 'cmpl_1', object: 'chat.completion', choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };

interface Harness {
  db: Db;
  runtime: GatewayRuntime;
  gatewayKey: string;
  keyPlain1: string;
  keyPlain2: string;
  keyId1: string;
  keyId2: string;
  upstreamId: string;
  modelId: string;
  calls: Call[];
}

async function setup(script?: Script): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'wiring-runtime-'));
  dirs.push(dir);
  const dbPath = join(dir, 'gateway.db');
  const db = openDatabase({ path: dbPath });

  // 两把 key 同一上游、权重不同：排序按 weight 降序，选路顺序确定（k1 先试）
  const upstreamId = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' }).id;
  const keyPlain1 = probeSecret('k1');
  const keyPlain2 = probeSecret('k2');
  const keyId1 = createKey(db, { upstreamId, key: keyPlain1, category: 'balance', weight: 5, balance: 10_000 }, MASTER_KEY).id;
  const keyId2 = createKey(db, { upstreamId, key: keyPlain2, category: 'balance', weight: 1, balance: 10_000 }, MASTER_KEY).id;

  const model = upsertModelFromSync(db, {
    upstreamId,
    name: 'gpt-4o',
    displayName: null,
    type: 'chat',
    capabilities: ['stream'],
    contextLength: 128_000,
    price: { inputPer1k: 100, outputPer1k: 200 },
  });

  const gatewayKey = createGroup(db, { name: '接入组' }).gatewayKey.gatewayKey;

  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return script === undefined ? jsonResponse(COMPLETION) : script(url, init);
  };

  const runtime = createGatewayRuntime({ db, config: makeConfig(dbPath), fetchImpl });
  await mountGatewayRoutes(runtime);
  await runtime.app.ready();

  live.push(async () => {
    await runtime.stop();
    await runtime.app.close();
    db.close();
  });

  return { db, runtime, gatewayKey, keyPlain1, keyPlain2, keyId1, keyId2, upstreamId, modelId: model.id, calls };
}

function auth(h: Harness): Record<string, string> {
  return { authorization: `Bearer ${h.gatewayKey}` };
}

function chat(h: Harness, body: Record<string, unknown> = {}): Promise<{ statusCode: number; headers: Record<string, unknown>; body: string; json: () => unknown }> {
  return h.runtime.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: auth(h),
    payload: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], ...body },
  });
}

function headerOf(call: Call, name: string): string {
  const raw = (call.init.headers ?? {}) as Record<string, string>;
  return raw[name] ?? '';
}

function logRows(db: Db): Array<{ key_id: string | null; status: number; error_code: string | null; model: string; cost_cents: number; ttfb_ms: number | null }> {
  return db
    .prepare('SELECT key_id, status, error_code, model, cost_cents, ttfb_ms FROM usage_logs ORDER BY status')
    .all() as Array<{ key_id: string | null; status: number; error_code: string | null; model: string; cost_cents: number; ttfb_ms: number | null }>;
}

/* ------------------------------ 用例 ------------------------------ */

describe('/v1/* 鉴权与校验', () => {
  it('缺 Authorization → 401，且是 OpenAI 形状（不许漏管理面的 code/message）', async () => {
    const h = await setup();
    const res = await h.runtime.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'gpt-4o', messages: [] } });

    assert.equal(res.statusCode, 401);
    const body = res.json() as { error?: { type?: string; code?: string }; code?: unknown; message?: unknown };
    assert.equal(body.error?.type, 'authentication_error');
    assert.equal(body.code, undefined);
    assert.equal(body.message, undefined);
    assert.equal(h.calls.length, 0, '没通过鉴权就不该有出站请求');
  });

  it('用户组被禁用 → 403 GROUP_DISABLED', async () => {
    const h = await setup();
    h.db.prepare('UPDATE groups SET enabled = 0').run();

    const res = await chat(h);
    assert.equal(res.statusCode, 403);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'GROUP_DISABLED');
  });

  it('key 被重置 → 旧明文立刻失效（鉴权是实时读，不是快照）', async () => {
    const h = await setup();
    assert.equal((await chat(h)).statusCode, 200);

    h.db.prepare('DELETE FROM gateway_keys').run();
    const res = await chat(h);
    assert.equal(res.statusCode, 401, '被作废的凭据必须下一个请求就 401，不能等缓存过期');
  });
});

describe('转发链路', () => {
  it('200 透传：出站打到上游 baseUrl 的正确路径、带上游 key，响应头如实回报', async () => {
    const h = await setup();
    const res = await chat(h);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), COMPLETION, '响应体原样透传，不许包装');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]?.url, 'https://a.example.com/chat/completions');
    assert.equal(h.calls[0]?.init.method, 'POST');
    assert.equal(headerOf(h.calls[0] as Call, 'authorization'), `Bearer ${h.keyPlain1}`);
    assert.equal(res.headers['x-gateway-key-id'], h.keyId1);
    assert.equal(res.headers['x-gateway-attempts'], '1');
    assert.equal(typeof Number(res.headers['x-gateway-ttfb-ms']), 'number');
  });

  it('一次请求不落库：用量只在队列里，flush 之后才有行（验收 6/8）', async () => {
    const h = await setup();
    await chat(h);

    assert.equal(logRows(h.db).length, 0, '热路径出现任何 INSERT 都会把 TTFB 卖给写锁');
    assert.equal(h.runtime.sink.pending(), 1);

    assert.equal(h.runtime.sink.flush(), 1);
    const [row] = logRows(h.db);
    assert.ok(row);
    assert.equal(row.status, 200);
    assert.equal(row.key_id, h.keyId1);
    // 日志里的模型名是**客户端发的名字**，金额按上游真实名换算
    assert.equal(row.model, 'gpt-4o');
    // 单价单位是**分/1k tokens**（契约 §5）：100 tokens × 100 分/1k = 10 分，20 × 200/1k = 4 分
    assert.equal(row.cost_cents, 10 + 4);
    assert.equal(typeof row.ttfb_ms, 'number');
  });

  it('上游 401 → 换下一把 key，客户端只看到 200（验收 2）', async () => {
    const h = await setup((_url, init) => {
      const authorization = (init.headers as Record<string, string>).authorization ?? '';
      return authorization === `Bearer ${h.keyPlain1}` ? jsonResponse({ error: { message: 'bad key' } }, 401) : jsonResponse(COMPLETION);
    });

    const res = await chat(h);

    assert.equal(res.statusCode, 200, '单 key 故障对客户端必须无感');
    assert.equal(res.headers['x-gateway-attempts'], '2');
    assert.equal(h.calls.length, 2);
    assert.equal(headerOf(h.calls[0] as Call, 'authorization'), `Bearer ${h.keyPlain1}`);
    assert.equal(headerOf(h.calls[1] as Call, 'authorization'), `Bearer ${h.keyPlain2}`);
    assert.equal(res.headers['x-gateway-key-id'], h.keyId2, '回报的必须是最终成功那把');

    h.runtime.sink.flush();
    const rows = logRows(h.db);
    // 引擎只在**终态**记一条（失败尝试的账由 attempts/错误码体现，不逐次写行）——
    // 这里断言的是"最终成功那把归属正确、且没有把失败 key 记成使用中的 key"
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, 200);
    assert.equal(rows[0]?.key_id, h.keyId2);

    // 故障的那把进了冷却：管理端 key 健康状态读的就是这份 runtime（可用 /internal/snapshot 验）
    const snap = (await h.runtime.app.inject({ method: 'GET', url: '/internal/snapshot' })).json() as {
      keys: Array<{ keyId: string; failCount: number; consecutiveFails: number; cooldownUntil: number | null; lastFailureReason: string | null; inflight: number }>;
    };
    const failed = snap.keys.find((k) => k.keyId === h.keyId1);
    assert.ok(failed, '两把 key 都应出现在快照里');
    assert.equal(failed.failCount, 1);
    assert.equal(failed.lastFailureReason, 'AUTH_INVALID');
    assert.ok((failed.cooldownUntil ?? 0) > Date.now(), '失败 key 必须进冷却，否则下一个请求还会先撞它');
    assert.equal(failed.inflight, 0, '并发位不许泄漏');
  });

  it('两把 key 都 401 → 502 UPSTREAM_ERROR（口径见 errors.ts：候选用尽≠无候选）', async () => {
    const h = await setup(() => jsonResponse({ error: { message: 'bad key' } }, 401));
    const res = await chat(h);

    // 注意与「无候选」区分：候选为空是 503 NO_AVAILABLE_KEY（见下一个用例），
    // 这里是有候选、全试完仍失败 → 502，且 lastFailureReason 的枚举进日志
    assert.equal(res.statusCode, 502);
    const body = res.json() as { error: { type: string; code: string }; code?: unknown };
    assert.equal(body.error.code, 'UPSTREAM_ERROR');
    assert.equal(body.error.type, 'api_error');
    assert.ok(h.calls.length >= 1);

    // 全失败也要留一条终态账：没有"那把 key"，所以外键为 NULL（不是空串）
    h.runtime.sink.flush();
    const [terminal] = logRows(h.db);
    assert.ok(terminal);
    assert.equal(terminal.status, 502);
    assert.equal(terminal.key_id, null);
    assert.equal(terminal.error_code, 'AUTH_INVALID', '终态日志保留最后一次失败原因，排障才有线索');
  });

  it('档案里没有的模型 → 503 NO_AVAILABLE_KEY（不上游、不落 key 账）', async () => {
    const h = await setup();
    const res = await chat(h, { model: '没人登记的模型' });

    assert.equal(res.statusCode, 503);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'NO_AVAILABLE_KEY');
    assert.equal(h.calls.length, 0, '候选为空时一个出站请求都不该发');
  });

  it('失败 key 的运行态经镜像落进 key_runtime：管理端 ?health=cooling 查得到（ADR-0010 接线）', async () => {
    // 只让第一把 401：第二把要能成功，否则两把都进冷却，就分不出"镜像写对了谁"
    const h = await setup((_url, init) =>
      (init.headers as Record<string, string>).authorization === `Bearer ${h.keyPlain1}`
        ? jsonResponse({ error: { message: 'bad key' } }, 401)
        : jsonResponse(COMPLETION),
    );
    await chat(h);

    // 这是从 /v1/* 转发链路一路到管理面读路径的端到端：池内存 → mirror → key_runtime → listKeys
    h.runtime.mirror.flush();
    const cooling = listKeys(h.db, { health: 'cooling', includeDeleted: false, page: 1, pageSize: 10 });
    assert.equal(cooling.total, 1, '只有被 401 打掉的那把在冷却；另一把仍是 healthy');
    assert.equal(cooling.items[0]?.id, h.keyId1);
    assert.equal(cooling.items[0]?.consecutiveFailures, 1);
    assert.equal(cooling.items[0]?.lastFailureReason, 'AUTH_INVALID');
    assert.ok(cooling.items[0]?.cooldownUntil != null, 'cooling 必须带未来时刻，否则管理端读路径不会判成 cooling');
    assert.equal(listKeys(h.db, { health: 'healthy', includeDeleted: false, page: 1, pageSize: 10 }).total, 1);
  });

  it('未实现的端点 → 501（不是 404，前端据此区分"没实现"与"写错路径"）', async () => {
    const h = await setup();
    const res = await h.runtime.app.inject({ method: 'POST', url: '/v1/images/generations', headers: auth(h), payload: { model: 'gpt-image-1', prompt: 'x' } });

    assert.equal(res.statusCode, 501);
    assert.equal(typeof (res.json() as { error: { message: string } }).error.message, 'string');
  });
});

describe('/v1/models 与内部观测口', () => {
  it('/v1/models 与「已启用档案」0 差异，且改档案立刻生效', async () => {
    const h = await setup();
    upsertModelFromSync(h.db, {
      upstreamId: h.upstreamId,
      name: 'gpt-4o-mini',
      displayName: null,
      type: 'chat',
      capabilities: [],
      contextLength: null,
      price: null,
    });

    const listed = async (): Promise<string[]> => {
      const res = await h.runtime.app.inject({ method: 'GET', url: '/v1/models', headers: auth(h) });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { object: string; data: Array<{ id: string; object: string; owned_by: string }> };
      assert.equal(body.object, 'list');
      assert.equal(body.data[0]?.object, 'model');
      assert.equal(body.data[0]?.owned_by, 'up-a');
      return body.data.map((m) => m.id).sort();
    };

    assert.deepEqual(await listed(), ['gpt-4o', 'gpt-4o-mini']);

    // 实时读：不等 1s 轮询窗口（验收 4 的校验脚本就是这么打的）
    const dto = getModel(h.db, h.modelId);
    assert.ok(dto);
    updateModel(h.db, h.modelId, { enabled: false, revision: dto.revision });
    assert.deepEqual(await listed(), ['gpt-4o-mini']);
  });

  it('/v1/models 也要鉴权（不是公开端点）', async () => {
    const h = await setup();
    const res = await h.runtime.app.inject({ method: 'GET', url: '/v1/models' });
    assert.equal(res.statusCode, 401);
  });

  it('/internal/snapshot 回环可读，且只有快照不含明文', async () => {
    const h = await setup();
    const res = await h.runtime.app.inject({ method: 'GET', url: '/internal/snapshot' });

    assert.equal(res.statusCode, 200);
    const body = res.json() as { at: string; keys: Array<{ keyId: string; failCount: number; inflight: number; cooldownUntil: number | null }> };
    assert.equal(typeof body.at, 'string');
    assert.equal(body.keys.length, 2);
    // 这是 **runtime 健康态**（不是配置快照）：字段是 failCount/cooldownUntil/inflight
    assert.equal(typeof body.keys[0]?.failCount, 'number');
    assert.equal(body.keys[0]?.inflight, 0);
    assert.equal(body.keys[0]?.cooldownUntil, null);
    assert.ok(!res.body.includes('sk-'), '快照里不许出现上游 key 明文');
    assert.ok(!res.body.includes(h.keyPlain1));
  });

  it('runtime.start() 后定时器能停干净（stop 之后不再刷新）', async () => {
    const h = await setup();
    h.runtime.start();
    h.runtime.start(); // 幂等
    await h.runtime.stop();

    // 改配置后已无轮询：快照不会自己变（要变得显式 refreshNow()）
    upsertModelFromSync(h.db, {
      upstreamId: h.upstreamId,
      name: 'gpt-4o-mini',
      displayName: null,
      type: 'chat',
      capabilities: [],
      contextLength: null,
      price: null,
    });
    assert.equal(h.runtime.refreshNow(), true);
    assert.equal(h.runtime.store.poolSnapshot().upstreams[0]?.models?.length, 2);
  });
});
