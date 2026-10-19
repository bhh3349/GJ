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
import { encryptSecret, sha256Hex } from '../db/crypto.js';
import { openDatabase, type Db } from '../db/database.js';
import { bootstrapAdmin, hashPassword } from '../api/auth.js';
import { buildApp } from '../api/app.js';
import { createGroup, deleteGroup } from '../db/repo/groups.js';
import { createUser, findUser } from '../db/repo/users.js';
import { batchSetEnabled, createKey, listKeys } from '../db/repo/keys.js';
import { upsertModelFromSync, getModel, updateModel } from '../db/repo/models.js';
import { createUpstream } from '../db/repo/upstreams.js';
import { permissiveEgressGate } from '../egress/port.js';
import type { EgressGate } from '../egress/port.js';
import type { FetchLike } from '../gateway/engine.js';
import { appendChange } from '../db/repo/change-log.js';
import { createEgressProxy } from '../db/repo/egress.js';
import { createSupplierAccount, linkSupplierAccountKey } from '../db/repo/supplier-accounts.js';
import { createEgressProxyLifecycle } from './egress-proxy.js';
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
    readonlyToken: null,
    logRetentionDays: 30,
    auditRetentionDays: 180,
    taskRetentionDays: 7,
    changeLogKeepRows: 10_000,
    healthSnapshotRetentionDays: 90,
    maxAttempts: 3,
    maxConcurrencyPerKey: 4,
    cooldownLadderSeconds: [0, 60, 300, 900, 1800],
    // 新增必填配置项（契约 §13 `ASSISTANT_MODEL`）的测试取值：本套用例不涉及助手
    assistantModel: null,
    egressHeartbeatInboxDir: null,
    egressEchoUrl: null,
    // 同上，契约 §14 新增两项：测试里关掉自动同步，不引后台定时器
    balanceSyncMinutes: 0,
    balanceSnapshotRetentionDays: 90,
    // 能力探测（契约 §5 / ADR-0024）测试取值：与装配默认逐字一致（本套用例不触发补探）
    modelProbeEnabled: true,
    modelProbeMaxModels: 10,
    // 托管默认关（契约 §17）：本套用例不挂前端，`GET /` 维持既有 JSON 404
    adminWebDist: null,
    egressBudgetCapacity: null,
    publicHost: null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const COMPLETION = { id: 'cmpl_1', object: 'chat.completion', choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };

interface Harness {
  db: Db;
  dbPath: string;
  runtime: GatewayRuntime;
  gatewayKey: string;
  /** 默认那个接入组的 id —— 组授权用例要拿它写 `group_models`（v1.15.8） */
  groupId: string;
  keyPlain1: string;
  keyPlain2: string;
  keyId1: string;
  keyId2: string;
  upstreamId: string;
  modelId: string;
  calls: Call[];
}

async function setup(script?: Script, gate: EgressGate = permissiveEgressGate): Promise<Harness> {
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

  const created = createGroup(db, { name: '接入组' });
  const gatewayKey = created.gatewayKey.gatewayKey;
  const groupId = created.group.id;

  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return script === undefined ? jsonResponse(COMPLETION) : script(url, init);
  };

  // 出口闸必填（ADR-0021 决策 4c）。本文件判的是端到端转发口径，不判预算，缺省闸 = "没有闸"。
  const runtime = createGatewayRuntime({ db, config: makeConfig(dbPath), fetchImpl, egress: gate });
  await mountGatewayRoutes(runtime);
  await runtime.app.ready();

  live.push(async () => {
    await runtime.stop();
    await runtime.app.close();
    db.close();
  });

  return { db, dbPath, runtime, gatewayKey, groupId, keyPlain1, keyPlain2, keyId1, keyId2, upstreamId, modelId: model.id, calls };
}

function auth(h: Harness): Record<string, string> {
  return { authorization: `Bearer ${h.gatewayKey}` };
}

/** 直接往 `group_models` 写授权行（绕过管理面 API —— 本文件测的是网关侧读这条授权）。 */
function authorize(h: Harness, groupId: string, modelIds: readonly string[]): void {
  h.db.prepare('DELETE FROM group_models WHERE group_id = ?').run(groupId);
  for (const id of modelIds) {
    h.db.prepare('INSERT INTO group_models (group_id, model_id) VALUES (?, ?)').run(groupId, id);
  }
}

/** 再建一个组（默认组之外的第二个身份），返回它的 id 与网关 key 明文。 */
function addGroup(h: Harness, tag: string): { groupId: string; gatewayKey: string } {
  const created = createGroup(h.db, { name: `组-${tag}` });
  return { groupId: created.group.id, gatewayKey: created.gatewayKey.gatewayKey };
}

/**
 * 新建一把带**模型白名单**的 key（§15.2 的真写入路径，会自己发 `change_log` 行）。
 *
 * 为什么不用裸 SQL 改 `model_limits`：网关读的是**快照**，快照只在 `change_log`
 * 出现相关实体时重建（`wiring/store.ts` 文件头那条纪律）。裸改库不发广播，
 * `refreshNow()` 就返回 false，用例会误判成"白名单不生效"。
 */
function addKeyWithModels(
  h: Harness,
  upstreamId: string,
  tag: string,
  models: readonly string[],
): string {
  return createKey(h.db, { upstreamId, key: probeSecret(tag), category: 'balance', models: [...models] }, MASTER_KEY).id;
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

/* ------------- 组模型授权：真库 → 真适配器 → 真路由（v1.15.8 / ADR-0037） ------------- */

/**
 * 这一组用例钉的**只有**真链路才看得见的那几件事：
 *   - 授权是**实时读**的（`wiring/auth.ts` 每请求一次），改库 ⇒ 下一个请求变，不重启；
 *   - `/v1/models` 与 `/api/console/models` 报的是**同一个集合**（同源三角，决策 6）；
 *   - 组授权与 key 白名单是**交集**（背景表）—— 只加组这一层不会绕过 key 那层。
 *
 * 「403 的响应体/事件字段」在 `src/gateway/routes.spec.ts` 与 `error-events.spec.ts` 里钉，
 * 这里不重复；这里值钱的是**真 SQLite 行**驱动的行为。
 */
describe('组模型授权（v1.15.8 / ADR-0037）', () => {
  const listModels = async (
    h: Harness,
    gatewayKey: string,
  ): Promise<{ statusCode: number; ids: string[] }> => {
    const res = await h.runtime.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${gatewayKey}` },
    });
    const body = res.json() as { data?: { id: string }[] };
    return { statusCode: res.statusCode, ids: (body.data ?? []).map((m) => m.id).sort() };
  };

  it('改授权后**下一个请求**即按新授权判（实时读库，不重启、不等轮询）', async () => {
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
    // 新档案要进**快照**才算"该上游有这个模型"（`/v1/models` 是实时读库，选路不是）。
    // 授权面（本用例的判据）与快照无关，这一步只为让"未收窄时能打通"这一侧成立。
    assert.equal(h.runtime.refreshNow(), true);

    // 未授权收缩（没有授权行）= 逐项同改版前：两个模型都能打（升级零行为变更）
    assert.equal((await chat(h, { model: 'gpt-4o-mini' })).statusCode, 200);
    assert.deepEqual((await listModels(h, h.gatewayKey)).ids, ['gpt-4o', 'gpt-4o-mini']);

    // 授权只留 gpt-4o：下一个请求就该拒 gpt-4o-mini
    authorize(h, h.groupId, [h.modelId]);
    const denied = await chat(h, { model: 'gpt-4o-mini' });
    assert.equal(denied.statusCode, 403);
    assert.equal((denied.json() as { error: { code: string } }).error.code, 'MODEL_NOT_AUTHORIZED');
    assert.equal(h.calls.length, 1, '被授权门拒掉的请求一次上游都不许敲');
    assert.equal((await chat(h, { model: 'gpt-4o' })).statusCode, 200);
    assert.deepEqual((await listModels(h, h.gatewayKey)).ids, ['gpt-4o']);

    // 撤销授权（清空行）→ 同一把 key 立即恢复全量，**不重启进程**
    h.db.prepare('DELETE FROM group_models WHERE group_id = ?').run(h.groupId);
    assert.equal((await chat(h, { model: 'gpt-4o-mini' })).statusCode, 200);
    assert.deepEqual((await listModels(h, h.gatewayKey)).ids, ['gpt-4o', 'gpt-4o-mini']);
  });

  it('按组收窄互不干扰：组 A 授权一条、组 B 不限 → 两把 key 各看到各自的集合', async () => {
    const h = await setup();
    const a = addGroup(h, 'auth-a');
    const b = addGroup(h, 'auth-b');
    // 上游再加一条档案：收窄的组只看见一条，不限的组看见两条 —— 差别才看得见
    upsertModelFromSync(h.db, {
      upstreamId: h.upstreamId,
      name: 'probe-extra',
      displayName: null,
      type: 'chat',
      capabilities: [],
      contextLength: null,
      price: null,
    });
    assert.equal(h.runtime.refreshNow(), true);

    // 组 A 只授权默认那条档案；组 B 一个授权行都没有 = 不限
    authorize(h, a.groupId, [h.modelId]);

    assert.deepEqual((await listModels(h, a.gatewayKey)).ids, ['gpt-4o']);
    assert.deepEqual((await listModels(h, b.gatewayKey)).ids, ['gpt-4o', 'probe-extra']);

    // 强制门同样是按组的：同一个请求体，两把 key 两种结局 —— 唯一变量是组
    const post = async (key: string, model: string) =>
      h.runtime.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${key}` },
        payload: { model, messages: [{ role: 'user', content: 'hi' }] },
      });

    assert.equal((await post(a.gatewayKey, 'gpt-4o')).statusCode, 200);
    // A 授权名单里没有 probe-extra ⇒ 403（策略拒绝），不是 503（档案里没有）
    const denied = await post(a.gatewayKey, 'probe-extra');
    assert.equal(denied.statusCode, 403);
    assert.equal((denied.json() as { error: { code: string } }).error.code, 'MODEL_NOT_AUTHORIZED');
    // B 不限 ⇒ 同一条档案放行，真打到上游
    assert.equal((await post(b.gatewayKey, 'probe-extra')).statusCode, 200);
  });

  it('组授权 ∩ key 白名单 = 交集：组放行而 key 白名单不含它 → 503，不是 200', async () => {
    const h = await setup();
    // 这一层是 **key 白名单**（§15.2 / §16.3 冻结件），归组管不到它。
    // 走真写入路径建一把"只认别的模型"的 key（裸 SQL 不发 change_log ⇒ 快照不重建），
    // 并把默认那两把挪开 —— 否则它们照样认 gpt-4o，这条用例就永远打不出那一声 503。
    const keyId = addKeyWithModels(h, h.upstreamId, 'wl', ['some-other-model']);
    assert.equal(batchSetEnabled(h.db, [h.keyId1, h.keyId2], false), 2);
    assert.equal(h.runtime.refreshNow(), true);
    // 白名单**真的**进了快照、默认两把**真的**不在可用集里 —— 否则下面那条 503 可能是别的原因
    // （用例就成了假绿：断言"没打通"，而没打通的理由并不是本用例要证的那一条）
    const snapshot = h.runtime.store.poolSnapshot();
    assert.deepEqual(snapshot.keys.find((k) => k.keyId === keyId)?.models, ['some-other-model']);
    assert.deepEqual(
      snapshot.keys.filter((k) => k.status === 'enabled').map((k) => k.keyId),
      [keyId],
    );

    authorize(h, h.groupId, [h.modelId]); // 组**授权了** gpt-4o
    const res = await chat(h, { model: 'gpt-4o' });

    // 授权门放行（名字在授权列表里），但候选集为空 ⇒ 503 NO_AVAILABLE_KEY。
    // 这条用例存在的理由：只加"组"这一层不构成对 key 白名单的替代 —— 两层是交集。
    assert.equal(res.statusCode, 503);
    const body = res.json() as { error: { code: string } };
    assert.equal(body.error.code, 'NO_AVAILABLE_KEY');
    assert.equal(h.calls.length, 0);
  });

  it('同源三角：同组会话的 /api/console/models 与该组 key 的 /v1/models 逐项 0 差异', async () => {
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
    authorize(h, h.groupId, [h.modelId]); // 只授权 gpt-4o

    // 管理面/消费面挂在同一个 db 上（线上是同一进程两个监听口，这里两个实例同一个库）
    const admin = buildApp({
      db: h.db,
      config: makeConfig(h.dbPath),
      balanceSync: false,
      healthSnapshots: false,
      adminWebDist: null,
    });
    live.push(async () => {
      await admin.close();
    });
    createUser(h.db, {
      username: 'tri-user',
      passwordHash: hashPassword('tri-user-pass-1'),
      role: 'user',
      groupId: h.groupId,
    });
    const login = await admin.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'tri-user', password: 'tri-user-pass-1' },
      headers: { 'x-requested-with': 'fetch' },
    });
    assert.equal(login.statusCode, 200, login.body);
    const raw = login.headers['set-cookie'];
    const cookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '';

    const consoleRes = await admin.inject({
      method: 'GET',
      url: '/api/console/models',
      headers: { cookie },
    });
    assert.equal(consoleRes.statusCode, 200, consoleRes.body);
    const consoleIds = (consoleRes.json() as { models: { name: string }[] }).models
      .map((m) => m.name)
      .sort();

    assert.deepEqual(consoleIds, (await listModels(h, h.gatewayKey)).ids);
    // 收窄**真的发生了**（否则上面那条等式在"两边都返回全量"时也成立 —— 那是最没价值的绿）
    assert.deepEqual(consoleIds, ['gpt-4o']);
  });

  it('未分配组的会话（groupId=null）不受任何授权影响：照旧看到全部已启用模型', async () => {
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
    authorize(h, h.groupId, [h.modelId]); // 那个组被收窄了

    const admin = buildApp({
      db: h.db,
      config: makeConfig(h.dbPath),
      balanceSync: false,
      healthSnapshots: false,
      adminWebDist: null,
    });
    live.push(async () => {
      await admin.close();
    });
    createUser(h.db, {
      username: 'no-group-user',
      passwordHash: hashPassword('no-group-pass-1'),
      role: 'user',
      groupId: null,
    });
    const login = await admin.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'no-group-user', password: 'no-group-pass-1' },
      headers: { 'x-requested-with': 'fetch' },
    });
    const raw = login.headers['set-cookie'];
    const cookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '';

    const res = await admin.inject({ method: 'GET', url: '/api/console/models', headers: { cookie } });
    assert.equal(res.statusCode, 200, res.body);
    // 没有组就没有"这个组授权了什么"可言 —— 收窄的判据挂在组上，不挂在"有人被收窄了"上
    assert.deepEqual(
      (res.json() as { models: { name: string }[] }).models.map((m) => m.name).sort(),
      ['gpt-4o', 'gpt-4o-mini'],
    );
  });
});

describe('错误事件：热路径 → 队列 → 落库（契约 §12.1 / ADR-0013 §7 / ADR-0014）', () => {
  interface EventRow {
    request_id: string | null;
    severity: string;
    category: string;
    status: number;
    gateway_code: string | null;
    failure_reason: string | null;
    endpoint: string;
    model: string | null;
    upstream_id: string | null;
    key_id: string | null;
    key_masked: string | null;
    stream: number;
    upstream_status: number | null;
    attempts: number;
    candidates: number | null;
    message: string | null;
  }

  function eventRows(db: Db): EventRow[] {
    return db
      .prepare(
        `SELECT request_id, severity, category, status, gateway_code, failure_reason, endpoint, model,
                upstream_id, key_id, key_masked, stream, upstream_status, attempts, candidates, message
           FROM gateway_error_events ORDER BY ts, id`,
      )
      .all() as EventRow[];
  }

  it('被拒的请求：先只有队列、flush 后才落一行，且 request_id 与响应头同值', async () => {
    const h = await setup();
    // 不带 Authorization：鉴权在**读 body 之前**就拒了，这是最热的那条拒绝路径
    const res = await h.runtime.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'gpt-4o', messages: [] } });

    assert.equal(res.statusCode, 401);
    assert.equal(eventRows(h.db).length, 0, '响应都回到客户端了，事件还只在内存队列里 —— 热路径不许同步落库');
    assert.equal(h.runtime.errors.pending(), 1);
    assert.equal(h.runtime.errors.dropped(), 0);

    assert.equal(h.runtime.errors.flush(), 1);
    const [row] = eventRows(h.db);
    assert.ok(row);
    assert.equal(row.gateway_code, 'INVALID_API_KEY');
    assert.equal(row.category, 'AUTH_FAILED', '码值 → 分型由 sink 派生，网关不报 category');
    assert.equal(row.severity, 'warn');
    assert.equal(row.endpoint, '/v1/chat/completions');
    assert.equal(row.model, null, '未通过鉴权的请求不该有往事件表里写字的能力');
    assert.equal(row.key_id, null, '一次上游都没碰到');
    assert.equal(row.upstream_id, null);
    assert.equal(row.attempts, 0);
    assert.equal(row.candidates, null, '没走到选路，"候选数"不适用');
    assert.equal(row.upstream_status, null);
    // 关联键端到端第五跳：调用方手上的回执 == 库里那一行的关联键（ADR-0014 §2）
    assert.equal(row.request_id, res.headers['x-request-id']);
    assert.ok(typeof row.request_id === 'string' && row.request_id.length >= 8);
  });

  it('用户组被禁用 → 403 一行：已过鉴权读 body 填 model/stream，分型归 AUTH_FAILED（组合，非仅 HTTP）', async () => {
    // 这是 401 那条「没鉴权、不读 body」的对照：403 已过鉴权，事件里的 model/stream 必须非空。
    // 也是 621f40b 修的那个缝的组合层 —— 两个单测各自绿不等于拼起来对。
    const h = await setup();
    h.db.prepare('UPDATE groups SET enabled = 0').run();

    const res = await chat(h, { stream: true });

    assert.equal(res.statusCode, 403);
    const body = res.json() as { error: { type: string; code: string } };
    assert.equal(body.error.type, 'authentication_error');
    assert.equal(body.error.code, 'GROUP_DISABLED');

    assert.equal(eventRows(h.db).length, 0, '响应都回到客户端了，事件还只在内存队列里 —— 热路径不许同步落库');
    assert.equal(h.runtime.errors.pending(), 1);
    assert.equal(h.runtime.errors.dropped(), 0);

    assert.equal(h.runtime.errors.flush(), 1);
    const [row] = eventRows(h.db);
    assert.ok(row);
    assert.equal(row.status, 403);
    assert.equal(row.gateway_code, 'GROUP_DISABLED');
    assert.equal(row.category, 'AUTH_FAILED', 'sink 分型：403 GROUP_DISABLED 归 AUTH_FAILED，不是 INTERNAL');
    assert.equal(row.severity, 'warn');
    assert.equal(row.endpoint, '/v1/chat/completions');
    assert.equal(row.model, 'gpt-4o', '已过鉴权 → 读 body 填 clientModel（与 401 的 null 区分）');
    assert.equal(row.stream, 1, '已过鉴权 → 读 body 填 stream（契约 §12.1）');
    assert.equal(row.failure_reason, null);
    assert.equal(row.key_id, null, '一次上游都没碰到');
    assert.equal(row.upstream_id, null);
    assert.equal(row.attempts, 0);
    assert.equal(row.candidates, null, '没走到选路，"候选数"不适用');
    assert.equal(row.upstream_status, null);
    assert.equal(row.request_id, res.headers['x-request-id'], '关联键与响应头同值');
    assert.ok(typeof row.request_id === 'string' && row.request_id.length >= 8);
    assert.equal(row.message, 'user group is disabled');

    // 被拒的请求不该写 usage_logs（与错误事件是两条独立的落库路径）
    h.runtime.sink.flush();
    assert.equal(logRows(h.db).length, 0, '被拒的请求不该进 usage_logs');
  });

  it('上游全挂 → 502 一行：掩码 key、上游原始状态、尝试数都如实落库，且库里没有明文', async () => {
    const h = await setup(() => jsonResponse({ error: { message: 'bad key' } }, 401));
    assert.equal((await chat(h)).statusCode, 502);
    h.runtime.errors.flush();

    const [row] = eventRows(h.db);
    assert.ok(row);
    assert.equal(row.category, 'UPSTREAM_ERROR');
    assert.equal(row.severity, 'error');
    assert.equal(row.upstream_status, 401, '「502 里藏着 401」是值班最需要的那个数');
    assert.equal(row.failure_reason, 'AUTH_INVALID');
    assert.equal(row.attempts, 2);
    assert.equal(row.candidates, 2);
    assert.equal(row.key_id, null, '两把都试完了：没有"那把 key"可言');
    assert.equal(row.upstream_id, null);
    assert.ok(row.key_masked !== null && row.key_masked.startsWith('****'), `掩码列只能是 ****+后4位，实际 ${String(row.key_masked)}`);
    assert.equal(row.model, 'gpt-4o');

    // 明文纪律：整表 dump 里不许出现任何一把上游 key
    const dump = JSON.stringify(eventRows(h.db));
    assert.ok(!dump.includes(h.keyPlain1) && !dump.includes(h.keyPlain2), '事件表里出现上游 key 明文');
  });

  it('stop() 做最后一次 flush：退出前的存量事件不丢', async () => {
    const h = await setup();
    const res = await h.runtime.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'gpt-4o', messages: [] } });
    assert.equal(res.statusCode, 401);
    assert.equal(eventRows(h.db).length, 0);

    await h.runtime.stop();
    assert.equal(eventRows(h.db).length, 1, 'stop() 不 flush 的话，进程退出时最后一批事件就没了');
  });

  it('成功请求：flush 之后事件表仍是 0 行（它是稀疏的失败流，不是访问日志）', async () => {
    const h = await setup();
    assert.equal((await chat(h)).statusCode, 200);
    h.runtime.errors.flush();
    assert.equal(eventRows(h.db).length, 0);
    assert.equal(h.runtime.errors.dropped(), 0);
  });

  it('成功请求：usage_logs.request_id == 响应头 == 发给上游的那个头（ADR-0014 §2 三跳同值）', async () => {
    const h = await setup();
    const inbound = 'req-abcde12345';
    const res = await h.runtime.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { ...auth(h), 'x-request-id': inbound },
      payload: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-request-id'], inbound, '入站合法的值原样回写 —— 调用方排障时手里就是它');
    h.runtime.sink.flush();

    const log = h.db.prepare('SELECT request_id FROM usage_logs').get() as { request_id: string | null };
    assert.equal(log.request_id, inbound, '第二张表（用量）落的是同一个值，否则两表对不上账');
    const [call] = h.calls;
    assert.ok(call);
    assert.equal(headerOf(call, 'x-request-id'), inbound, '上游也要收到同一个值：跨我们这层的调用链才对得起来');
  });
});

/* ------------- 出口闸接线：数据面消费的是**注入的那个实例**（ADR-0021 决策 4c / 4） ------------- */

describe('出口预算闸的接线', () => {
  /**
   * 间谍闸：把端口那五个方法全包一遍，只记录调用，不改变任何一个结论。
   *
   * 为什么不用"断言闸里的状态被改了"来判接线：那要求请求先撞上限流，判据就混进了归因逻辑
   * （那条路已经在 `src/gateway/egress.spec.ts` 判过）。这里要判的是一件更小、也更基础的事 ——
   * **数据面到底有没有在用这个对象**。一次成功请求也会经过 `cooldownUntil`（选路前的冷却检查）
   * 与 `reserve`（出站前取配额），所以调用痕迹天然存在。
   */
  function spyGate() {
    const seen = { reserve: [] as string[], cooldown: [] as string[], success: [] as string[] };
    const gate: EgressGate = {
      reserve: (egressId, consumer) => {
        seen.reserve.push(`${egressId}:${consumer}`);
        return permissiveEgressGate.reserve(egressId, consumer);
      },
      observeLimited: (input) => permissiveEgressGate.observeLimited(input),
      observeSuccess: (egressId) => {
        seen.success.push(egressId);
        permissiveEgressGate.observeSuccess(egressId);
      },
      cooldownUntil: (egressId) => {
        seen.cooldown.push(egressId);
        return permissiveEgressGate.cooldownUntil(egressId);
      },
      snapshot: () => permissiveEgressGate.snapshot(),
    };
    return { gate, seen };
  }

  it('`createGatewayRuntime({ egress })` 注入的实例就是数据面用的那个（两侧不是各造一份）', async () => {
    // 这条是"造一次、注入两处"在数据面这一侧的可见证据：引擎若自建一份闸，
    // 这里的 `seen` 会全空 —— 而症状只是"预算永远满着 / 冷却永远不生效"，没有任何报错。
    const { gate, seen } = spyGate();
    const h = await setup(() => jsonResponse(COMPLETION), gate);

    const res = await chat(h);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(seen.cooldown, ['a.example.com'], '选路前查冷却走的是注入的那个实例（Tier 1 = 归一化 host）');
    assert.deepEqual(seen.reserve, ['a.example.com:data'], '出站前取配额走的是同一个实例，且消费方是 `data`');
  });

  it('注入的闸**不替换** `fetchImpl`：出站仍然落到测试桩上（决策 4 末尾那条）', async () => {
    // 装饰器包的是 `doFetch`（= `options.fetchImpl`），不是全局 fetch。
    // 包错一层，测试就会真的往外发请求 —— 而且看起来只是"这个用例变慢了"。
    const { gate } = spyGate();
    const h = await setup(() => jsonResponse(COMPLETION), gate);

    await chat(h);

    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]?.url, 'https://a.example.com/chat/completions');
  });
});


/* --------------- 出口代理接线（缺口 A，ADR-0021 决策 4c） --------------- */

describe('出口代理接线：绑出口的 key 真从代理层出去（缺口 A）', () => {
  /**
   * 主 harness 的真链路 + 一个**真库驱动**的出口代理。桩 fetch 记录"这一发出站带没带 dispatcher"
   * —— `dispatcher` 出现 = 走了代理层；不出现 = 宿主直连。
   *
   * 绑定用仓储 API（不是裸 INSERT）：`linkSupplierAccountKey` 会自己广播 `key` 变更；
   * 账号级出口列改完再补一条 `egress` 广播 —— 这正是缺口 C 的写路径该做的事，
   * 本笔只**消费**那条广播（不实现写入口）。
   */
  async function setupWithProxy() {
    const dir = mkdtempSync(join(tmpdir(), 'wiring-egress-live-'));
    dirs.push(dir);
    const dbPath = join(dir, 'gateway.db');
    const db = openDatabase({ path: dbPath });

    const upstreamId = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' }).id;
    // 两把 key 同上游：绑出口的那把给高权重 ⇒ 先被选走，出站路径可判
    const keyBound = probeSecret('bound');
    const keyPlain = probeSecret('plain');
    const keyIdBound = createKey(db, { upstreamId, key: keyBound, category: 'balance', weight: 9, balance: 10_000 }, MASTER_KEY).id;
    const keyIdPlain = createKey(db, { upstreamId, key: keyPlain, category: 'balance', weight: 1, balance: 10_000 }, MASTER_KEY).id;

    upsertModelFromSync(db, {
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
      return jsonResponse(COMPLETION);
    };

    // 真出口（带凭据，走同一份 aes-256-gcm）
    const egressId = createEgressProxy(
      db,
      { name: 'hk-1', url: 'https://proxy.example.com:8080', username: 'u', password: 'p' },
      MASTER_KEY,
    ).id;
    // 账号 + 台账绑定（Tier 2 的账号级出口；写入口是缺口 C，这里只造快照输入）
    const accountId = `acc_spec_${Math.random().toString(36).slice(2, 10)}`;
    createSupplierAccount(db, accountId, {
      upstreamId,
      supplier: 'tierflow',
      identifier: '138****0101',
      identifierHash: sha256Hex(`egress-live-${accountId}`),
      status: 'active',
      encryptedPassword: encryptSecret(probeSecret('acct'), MASTER_KEY),
    });
    linkSupplierAccountKey(db, accountId, keyIdBound, '****0101', null);
    db.prepare('UPDATE supplier_accounts SET egress_id = ? WHERE id = ?').run(egressId, accountId);
    appendChange(db, 'egress', egressId, 'update', null);

    const proxy = createEgressProxyLifecycle({ db, masterKey: MASTER_KEY });
    const runtime = createGatewayRuntime({
      db,
      config: makeConfig(dbPath),
      fetchImpl,
      egress: permissiveEgressGate,
      egressProxy: proxy,
    });
    await mountGatewayRoutes(runtime);
    await runtime.app.ready();
    live.push(async () => {
      await runtime.stop();
      await runtime.app.close();
      db.close();
    });
    return { db, runtime, gatewayKey, keyIdBound, keyIdPlain, egressId, calls };
  }

  const body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };

  it('绑出口的 key 出站带 `dispatcher`；未绑的照旧宿主直连（同一请求流上两条路都能走到）', async () => {
    const h = await setupWithProxy();
    h.runtime.refreshNow();
    const headers = { authorization: `Bearer ${h.gatewayKey}` };

    const r1 = await h.runtime.app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: body });
    assert.equal(r1.statusCode, 200);
    assert.equal(h.calls.length, 1);
    assert.notEqual(
      (h.calls[0]?.init as unknown as Record<string, unknown>).dispatcher,
      undefined,
      '绑出口（高权重）那把必须先被选走，且这一出站必须经代理层',
    );

    // 停用绑定那把 ⇒ 候选只剩未绑的 ⇒ 这一出站不得带 dispatcher
    h.db.prepare('UPDATE upstream_keys SET enabled = 0 WHERE id = ?').run(h.keyIdBound);
    appendChange(h.db, 'key', h.keyIdBound, 'update', null);
    h.runtime.refreshNow();

    const r2 = await h.runtime.app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: body });
    assert.equal(r2.statusCode, 200);
    assert.equal(h.calls.length, 2);
    assert.equal(
      (h.calls[1]?.init as unknown as Record<string, unknown>).dispatcher,
      undefined,
      '未绑出口（池外 id）照旧宿主直连，不得凭空挂代理',
    );
  });

  it('启动 prime：构造完成、还没走第一个 1s 轮询时，绑出口那把也已进镜像（不回落宿主直连）', async () => {
    // 这一条盯的是"启动窗口"：镜像若只在第一拍刷新，头一个拍子里绑了出口的账号会被判成
    // "池外 ⇒ 直连" —— 从宿主 IP 出站、账却记在那个出口头上，且没有任何报错（决策 9(5)）。
    const h = await setupWithProxy();
    // **刻意不调 `refreshNow()`**：账号绑定与 `egress` 广播都在构造之前落库，
    // 该看到它们的只有构造期那次 prime —— 去掉它，这条用例必须变红（否则它没在判任何东西）。
    const r = await h.runtime.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${h.gatewayKey}` },
      payload: body,
    });
    assert.equal(r.statusCode, 200);
    assert.equal(h.calls.length, 1);
    assert.notEqual((h.calls[0]?.init as unknown as Record<string, unknown>).dispatcher, undefined);
  });
});

/*
  ── 开箱即用端到端：管理员的账号能真的用路由（v1.15.6 / ADR-0035 判据）──

  这一条是 Bo 那句「管理员的账号无法使用路由」的**可执行反面**，所以它刻意跨三层：
  首启引导（`bootstrapAdmin` 建组 + 把管理员放进去）→ 网关鉴权（`key_hash` → 组上下文）
  → 真路由（`/v1/models` 出 200）。断在中间任何一层的"表里有条记录"都不算数 ——
  组存在、key 存在、`group_id` 也指对了，而链子断在鉴权上的形状完全可能
  （那正是本版要修的故障：每一环都在，整条链不可达）。

  它跑在**闸门之后**（网关面只需要一把 key，不需要任何会话），这是唯一一条能证明
  "管理员这个账号拿到了能用的凭据"的判据。
*/
describe('开箱即用：首启引导的管理员能用自己的 key 打 /v1/*（ADR-0035）', () => {
  it('引导时签发的 key 打 /v1/models → 200（跨引导 / 鉴权 / 路由三层）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wiring-boot-'));
    dirs.push(dir);
    const dbPath = join(dir, 'gateway.db');
    const db = openDatabase({ path: dbPath });

    // 与线上 `src/server.ts` 同序：先引导（这时库空），再装配网关。
    const boot = bootstrapAdmin(db, { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'boot-pass-1234' });
    assert.equal(boot.created, true);
    assert.equal(boot.adminGroup?.name, '管理组');
    assert.ok(boot.adminGatewayKey, '引导必须交出管理组那把 key 的明文（唯一一次）');

    // 归属真的落库了 —— 否则下面 200 的成因说不清（可能只是"key 恰好有效"）
    assert.equal(findUser(db, 'admin')?.group_id, boot.adminGroup?.id);

    upsertModelFromSync(db, {
      upstreamId: createUpstream(db, { name: 'up-boot', baseUrl: 'https://boot.example.com' }).id,
      name: 'gpt-4o-mini',
      displayName: null,
      type: 'chat',
      capabilities: [],
      contextLength: null,
      price: null,
    });

    const runtime = createGatewayRuntime({ db, config: makeConfig(dbPath), egress: permissiveEgressGate });
    await mountGatewayRoutes(runtime);
    await runtime.app.ready();
    live.push(async () => {
      await runtime.stop();
      await runtime.app.close();
      db.close();
    });

    const res = await runtime.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${boot.adminGatewayKey ?? ''}` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { data: Array<{ id: string }> };
    assert.deepEqual(
      body.data.map((m) => m.id),
      ['gpt-4o-mini'],
    );

    // 明文只在返回值里；库里只有散列（§4 铁律，顺手钉一下这条路径没破它）
    const stored = db.prepare('SELECT key_hash FROM gateway_keys').all() as { key_hash: string }[];
    assert.equal(stored.length, 1);
    assert.notEqual(stored[0]?.key_hash, boot.adminGatewayKey);
  });

  it('老库（升级上来的、已有账号且没有组）引导 → 零动作：不建组、不签发 key、不改归属', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wiring-boot-old-'));
    dirs.push(dir);
    const dbPath = join(dir, 'gateway.db');
    const db = openDatabase({ path: dbPath });
    live.push(async () => {
      db.close();
    });

    // 造一个**真的老库**：v1.15.6 之前的账号行就是这个样子 ——
    // 有 `admin_users` 行、没有组、也没有 `groupId` 这一说。
    // 刻意不走 `bootstrapAdmin` 来造它：那会顺手把管理组种进去，
    // 于是"有没有被种"就测不出来了（这正是本用例要测的东西）。
    const at = new Date().toISOString();
    db.prepare('INSERT INTO admin_users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
      'legacy',
      'scrypt$1$1$1$AAAA$AAAA',
      at,
      at,
    );

    const groupsBefore = (db.prepare('SELECT COUNT(*) AS n FROM groups').get() as { n: number }).n;
    const keysBefore = (db.prepare('SELECT COUNT(*) AS n FROM gateway_keys').get() as { n: number }).n;
    assert.equal(groupsBefore, 0);

    const again = bootstrapAdmin(db, { ADMIN_USERNAME: 'someone-else', ADMIN_PASSWORD: 'other-pass-1234' });
    // 上面那就是 `server.ts` 每次启动都会走的一步 —— 老库上必须整段 no-op。
    // 不替用户做"给你补一个组"这个配额决策：那是一次会改变他账单的行为，
    // 而它发生在一个没人要求过的地方（启动日志里还不会有任何痕迹）。
    assert.equal(again.created, false);
    assert.equal(again.adminGatewayKey, undefined);
    assert.equal(again.adminGroup, undefined);

    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM groups').get() as { n: number }).n, groupsBefore);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM gateway_keys').get() as { n: number }).n, keysBefore);
    // 老账号的归属没被动过，也没多出 `someone-else` 这个人
    const row = db.prepare('SELECT username, group_id FROM admin_users').all() as {
      username: string;
      group_id: string | null;
    }[];
    assert.deepEqual(row, [{ username: 'legacy', group_id: null }]);
  });

  it('删掉种出来的管理组 → 管理员还在、归属退回 NULL、那把 key 一起失效（组是普通组）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wiring-boot-del-'));
    dirs.push(dir);
    const dbPath = join(dir, 'gateway.db');
    const db = openDatabase({ path: dbPath });

    const boot = bootstrapAdmin(db, { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'boot-pass-1234' });
    const groupId = boot.adminGroup?.id ?? '';
    const key = boot.adminGatewayKey ?? '';

    upsertModelFromSync(db, {
      upstreamId: createUpstream(db, { name: 'up-del', baseUrl: 'https://del.example.com' }).id,
      name: 'gpt-4o-mini',
      displayName: null,
      type: 'chat',
      capabilities: [],
      contextLength: null,
      price: null,
    });

    const runtime = createGatewayRuntime({ db, config: makeConfig(dbPath), egress: permissiveEgressGate });
    await mountGatewayRoutes(runtime);
    await runtime.app.ready();
    live.push(async () => {
      await runtime.stop();
      await runtime.app.close();
      db.close();
    });

    // 删组**不走 HTTP**：本用例钉的是仓储层的成员处置（路由层的删组已有回归）。
    // 也是刻意的：管理组没有任何特权，它必须能被普通地删掉 ——
    // 否则"管理"就成了一种藏在别处的身份（ADR-0035 决策 3 要防的正是这个）。
    deleteGroup(db, groupId);

    // 三件事各自成立，缺一条这个"删"就不是干净的：
    //   ① 账号还在（删组不该顺带销毁登录身份，那是用户管理页的职责）
    const user = findUser(db, 'admin');
    assert.equal(user?.username, 'admin');
    assert.equal(user?.group_id, null); // ② 归属退回 NULL = 合法可读的降级，不是报错
    //   ③ 那把 key 一起没了 —— 留着就是一把"能过鉴权但找不到组"的凭据
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM gateway_keys').get() as { n: number }).n, 0);

    // 而它确实打不通了：**用旧 key 打 /v1/models**。
    // 这是"key 真的失效"与"表里少了一行"的区别 —— 前者才是调用方感受到的事实。
    const res = await runtime.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${key}` },
    });
    assert.equal(res.statusCode, 401);
  });

  it('引导幂等：同一个新库连引导两次，只有第一次建组签发', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wiring-boot-twice-'));
    dirs.push(dir);
    const db = openDatabase({ path: join(dir, 'gateway.db') });
    live.push(async () => {
      db.close();
    });

    const first = bootstrapAdmin(db, { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'boot-pass-1234' });
    assert.equal(first.created, true);

    // 第二次：库里有账号了 → 整段 no-op。判据是**组与 key 的计数不变**，
    // 不只是返回值好看 —— 一个"每次启动都多给管理组发一把 key"的实现
    // 会让库里每次重启多一份可用凭据，而它同样可以返回 `{created:false}`。
    const groups = (db.prepare('SELECT COUNT(*) AS n FROM groups').get() as { n: number }).n;
    const keys = (db.prepare('SELECT COUNT(*) AS n FROM gateway_keys').get() as { n: number }).n;

    const second = bootstrapAdmin(db, { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'boot-pass-1234' });
    assert.equal(second.created, false);
    assert.equal(second.adminGatewayKey, undefined);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM groups').get() as { n: number }).n, groups);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM gateway_keys').get() as { n: number }).n, keys);
  });
});
