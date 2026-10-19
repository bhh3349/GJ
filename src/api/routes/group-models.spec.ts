// 组模型授权 —— 管理面与级联（契约 §4「模型授权」/ v1.15.8 / ADR-0037）。
//
// 这一层钉的是**写面的事实**：名字怎么解析成档案、乐观锁挂在哪一条、`[]` 与 `null`
// 是不是真的同义、两条外键级联有没有清干净。网关侧的强制门在 `src/gateway/routes.spec.ts`
// 与 `src/wiring/runtime.spec.ts`（那里才有真链路），这里一条也不重复。
//
// 三条一旦破了就静默出错的判据（所以断言写得比别处硬）：
//   1. **含未知名字必须库零变更**：先解析后写库 —— 先删后校验的话，一次拼错的名字
//      会把原授权删掉，界面上是"保存失败"，库里的授权却已经没了；
//   2. **`[]` 与 `null` 是同一件事**：出口恒不为 `[]`（与 `db/model-limits.ts` 那条冻结口径同构）；
//   3. **级联漏一条 = 删除 500**：全库 `foreign_keys=ON` 且无 `ON DELETE` 子句，
//      `group_models` 的两个外键方向（组 / 档案）各要一条显式 DELETE。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../../config.js';
import { openDatabase, type Db } from '../../db/database.js';
import { upsertModelFromSync } from '../../db/repo/models.js';
import { buildApp } from '../app.js';
import { bootstrapAdmin } from '../auth.js';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'group-models-pass-1';
const MASTER_KEY = Buffer.from('7c'.repeat(32), 'hex');

const dirs: string[] = [];
const harnesses: Harness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.app.close().catch(() => undefined);
    try {
      h.db.close();
    } catch {
      /* 已关 */
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上临时目录偶尔仍被短时占用 */
    }
  }
});

interface Harness {
  app: FastifyInstance;
  db: Db;
  cookie: string;
}

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
    assistantModel: null,
    egressHeartbeatInboxDir: null,
    egressEchoUrl: null,
    balanceSyncMinutes: 0,
    balanceSnapshotRetentionDays: 90,
    modelProbeEnabled: true,
    modelProbeMaxModels: 10,
    adminWebDist: null,
    publicHost: null,
  };
}

async function setup(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'group-models-'));
  dirs.push(dir);
  const dbPath = join(dir, 'gateway.db');
  const db = openDatabase({ path: dbPath });
  const app = buildApp({
    db,
    config: makeConfig(dbPath),
    balanceSync: false,
    healthSnapshots: false,
  });
  bootstrapAdmin(db, { ADMIN_USERNAME: ADMIN_USER, ADMIN_PASSWORD: ADMIN_PASS });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: ADMIN_USER, password: ADMIN_PASS },
    headers: { 'x-requested-with': 'fetch' },
  });
  expect(res.statusCode, res.body).toBe(200);
  const raw = res.headers['set-cookie'];
  const cookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '';
  const h: Harness = { app, db, cookie };
  harnesses.push(h);
  return h;
}

/** 带会话与 CSRF 头的管理面写请求。返回类型只声明本文件用到的那几格（不引 light-my-request 类型）。 */
async function write(
  h: Harness,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
): Promise<{
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  json: <T = unknown>() => T;
}> {
  return h.app.inject({
    method,
    url,
    headers: { cookie: h.cookie, 'x-requested-with': 'fetch' },
    ...(payload === undefined ? {} : { payload }),
  });
}

/** 建一个上游 + 一条档案，返回 {upstreamId, modelId, name}。 */
function seedUpstreamWithModel(h: Harness, name = 'probe-up', modelName = 'probe-m1'): {
  upstreamId: string;
  modelId: string;
  modelName: string;
} {
  const at = '2026-10-17T00:00:00.000Z';
  const upstreamId = 'up_probe_' + name;
  h.db
    .prepare(
      `INSERT INTO upstreams (id, name, base_url, enabled, supplier, balance_query, revision, created_at, updated_at)
       VALUES (?, ?, ?, 1, NULL, '{}', 1, ?, ?)`,
    )
    .run(upstreamId, name, 'https://probe.example.com', at, at);
  const { id } = upsertModelFromSync(h.db, {
    upstreamId,
    name: modelName,
    displayName: null,
    type: 'chat',
    capabilities: ['stream'],
    contextLength: 128_000,
    price: { inputPer1k: 10, outputPer1k: 30 },
  });
  return { upstreamId, modelId: id, modelName };
}

async function createGroupViaApi(h: Harness, name: string): Promise<{ id: string; revision: number }> {
  const res = await write(h, 'POST', '/api/groups', { name });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json() as { id: string; revision: number };
  return { id: body.id, revision: body.revision };
}

function count(h: Harness, sql: string, ...params: unknown[]): number {
  return (h.db.prepare(sql).get(...params) as { n: number }).n;
}

const modelRows = (h: Harness, groupId: string): number =>
  count(h, 'SELECT COUNT(*) AS n FROM group_models WHERE group_id = ?', groupId);

describe('GET/PUT /api/groups/:id/models（契约 §4）', () => {
  it('PUT 授权一批名字 → GET 回同一份名字 + 展开行；组行的 authorizedModels 同步变化', async () => {
    const h = await setup();
    const { modelName } = seedUpstreamWithModel(h);
    const group = await createGroupViaApi(h, 'probe-auth-1');

    // 新组的起点是"不限"（没有授权行），不是空集
    const initial = await h.app.inject({
      method: 'GET',
      url: `/api/groups/${group.id}/models`,
      headers: { cookie: h.cookie },
    });
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json()).toEqual({ models: null, authorizedModels: [] });

    const put = await write(h, 'PUT', `/api/groups/${group.id}/models`, {
      models: [modelName],
      revision: group.revision,
    });
    expect(put.statusCode, put.body).toBe(200);
    const body = put.json() as {
      models: string[] | null;
      authorizedModels: { id: string; name: string; upstreamId: string }[];
      group: { authorizedModels: string[] | null; revision: number };
    };
    // 名字列表与展开行**并存且各司其职**：前者是 PUT 的 body 形状（可写回），
    // 后者告诉界面"这条授权落到哪个上游"
    expect(body.models).toEqual([modelName]);
    expect(body.authorizedModels).toHaveLength(1);
    expect(body.authorizedModels[0]?.name).toBe(modelName);
    expect(body.authorizedModels[0]?.upstreamId).toBe('up_probe_probe-up');
    expect(body.authorizedModels[0]?.id).toEqual(expect.any(String));
    // 组行同步：revision 已 +1、授权名已变 —— 前端就地更新那一格不必再发一次 GET
    expect(body.group.authorizedModels).toEqual([modelName]);
    expect(body.group.revision).toBe(group.revision + 1);

    // 列表页的授权列（N+1 查询那条）也读得到
    const list = await h.app.inject({ method: 'GET', url: '/api/groups', headers: { cookie: h.cookie } });
    const items = (list.json() as { items: { id: string; authorizedModels: string[] | null }[] }).items;
    expect(items.find((g) => g.id === group.id)?.authorizedModels).toEqual([modelName]);
  });

  it('`[]` 与 `null` 同义：写回后 GET 回 null，授权行清空（不造第三态）', async () => {
    const h = await setup();
    const { modelName } = seedUpstreamWithModel(h);
    const group = await createGroupViaApi(h, 'probe-auth-2');

    const first = await write(h, 'PUT', `/api/groups/${group.id}/models`, {
      models: [modelName],
      revision: group.revision,
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(modelRows(h, group.id)).toBe(1);

    const second = await write(h, 'PUT', `/api/groups/${group.id}/models`, {
      models: [],
      revision: group.revision + 1,
    });
    expect(second.statusCode, second.body).toBe(200);
    const body = second.json() as {
      models: string[] | null;
      authorizedModels: unknown[];
      group: { authorizedModels: string[] | null };
    };
    // `[]`（显式空）落库 = 删全部行 = `null`（不限）。**不是**"一个都不许"：
    // 出口恒不出现 `[]`，与 §15.7/§16.3 的 serializeModelLimits 逐字同构。
    expect(body.models).toBeNull();
    expect(body.authorizedModels).toEqual([]);
    expect(modelRows(h, group.id)).toBe(0);
    expect(body.group.authorizedModels).toBeNull();
  });

  it('含未知模型名 → 400 INVALID_PARAM（field=models）且**库零变更**', async () => {
    const h = await setup();
    const { modelName } = seedUpstreamWithModel(h);
    const group = await createGroupViaApi(h, 'probe-auth-3');

    // 先建一份真实授权，好让"零变更"有东西可比
    const seeded = await write(h, 'PUT', `/api/groups/${group.id}/models`, {
      models: [modelName],
      revision: group.revision,
    });
    expect(seeded.statusCode, seeded.body).toBe(200);

    const bad = await write(h, 'PUT', `/api/groups/${group.id}/models`, {
      models: [modelName, 'typo-model'],
      revision: group.revision + 1,
    });
    expect(bad.statusCode, bad.body).toBe(400);
    const body = bad.json() as { code: string; message: string; details?: { field?: string } };
    expect(body.code).toBe('INVALID_PARAM');
    // 报错要指名道姓 + 说出是哪个名字拼错了（静默丢掉 = 一个"保存成功但什么都没授权"的面）
    expect(body.details?.field).toBe('models');
    expect(body.message).toContain('typo-model');

    // 库零变更：原授权原样还在，revision 也没被推进一步
    expect(modelRows(h, group.id)).toBe(1);
    expect(
      (h.db.prepare('SELECT revision FROM groups WHERE id = ?').get(group.id) as { revision: number })
        .revision,
    ).toBe(group.revision + 1);
  });

  it('revision 不匹配 → 409 REVISION_MISMATCH（带 expected/actual），库零变更', async () => {
    const h = await setup();
    const { modelName } = seedUpstreamWithModel(h);
    const group = await createGroupViaApi(h, 'probe-auth-4');

    const stale = await write(h, 'PUT', `/api/groups/${group.id}/models`, {
      models: [modelName],
      revision: group.revision + 5,
    });
    expect(stale.statusCode, stale.body).toBe(409);
    const body = stale.json() as { code: string; details?: { expected?: number; actual?: number } };
    expect(body.code).toBe('REVISION_MISMATCH');
    expect(body.details?.expected).toBe(group.revision + 5);
    expect(body.details?.actual).toBe(group.revision);
    expect(modelRows(h, group.id)).toBe(0);
  });

  it('授权用的是**同一条** revision：PUT 之后 PATCH 用旧版本号 → 409，用新版本号 → 200', async () => {
    const h = await setup();
    const { modelName } = seedUpstreamWithModel(h);
    const group = await createGroupViaApi(h, 'probe-auth-5');

    const put = await write(h, 'PUT', `/api/groups/${group.id}/models`, {
      models: [modelName],
      revision: group.revision,
    });
    expect(put.statusCode, put.body).toBe(200);

    // 有人改过授权 ⇒ 拿旧 revision 改配额的人必须知道（组只有一条版本号）
    const stalePatch = await write(h, 'PATCH', `/api/groups/${group.id}`, {
      rpm: 10,
      revision: group.revision,
    });
    expect(stalePatch.statusCode, stalePatch.body).toBe(409);
    expect((stalePatch.json() as { code: string }).code).toBe('REVISION_MISMATCH');

    const fresh = await write(h, 'PATCH', `/api/groups/${group.id}`, {
      rpm: 10,
      revision: group.revision + 1,
    });
    expect(fresh.statusCode, fresh.body).toBe(200);
    // 配额改动**不**动授权：两件事共用版本号，但不互相覆盖
    expect((fresh.json() as { authorizedModels: string[] | null }).authorizedModels).toEqual([modelName]);
  });

  it('审计 `group.models.update` 的 detail 是 {from,to}（写入前读 from，写后 from≠to）', async () => {
    const h = await setup();
    const { modelName } = seedUpstreamWithModel(h);
    const group = await createGroupViaApi(h, 'probe-auth-6');

    const put = await write(h, 'PUT', `/api/groups/${group.id}/models`, {
      models: [modelName],
      revision: group.revision,
    });
    expect(put.statusCode, put.body).toBe(200);

    const row = h.db
      .prepare("SELECT target_type, target_id, detail FROM audit_log WHERE action = 'group.models.update'")
      .get() as { target_type: string; target_id: string; detail: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.target_type).toBe('group');
    expect(row?.target_id).toBe(group.id);
    // from 必须是**写入前**的值（null = 不限），写完之后再读就都是新值了
    expect(JSON.parse(row?.detail ?? '{}')).toEqual({ from: null, to: [modelName] });
  });

  it('组不存在 → 404（GET 与 PUT 各一次，PUT 不新建任何东西）', async () => {
    const h = await setup();
    const get = await h.app.inject({
      method: 'GET',
      url: '/api/groups/grp_nope/models',
      headers: { cookie: h.cookie },
    });
    expect(get.statusCode).toBe(404);

    const put = await write(h, 'PUT', '/api/groups/grp_nope/models', {
      models: null,
      revision: 1,
    });
    expect(put.statusCode, put.body).toBe(404);
    expect(count(h, 'SELECT COUNT(*) AS n FROM groups WHERE id = ?', 'grp_nope')).toBe(0);
  });

  it('body 缺 revision / 缺 models → 400（两格都必填：省略表达不了"置回不限"）', async () => {
    const h = await setup();
    const group = await createGroupViaApi(h, 'probe-auth-7');

    const noRevision = await write(h, 'PUT', `/api/groups/${group.id}/models`, { models: null });
    expect(noRevision.statusCode, noRevision.body).toBe(400);
    expect((noRevision.json() as { details?: { field?: string } }).details?.field).toBe('revision');

    const noModels = await write(h, 'PUT', `/api/groups/${group.id}/models`, {
      revision: group.revision,
    });
    expect(noModels.statusCode, noModels.body).toBe(400);
    expect((noModels.json() as { details?: { field?: string } }).details?.field).toBe('models');
  });

  it('同名档案跨上游一起授权（按名判定、按 id 落库的**代价**，ADR-0037 遗留 1）', async () => {
    const h = await setup();
    const a = seedUpstreamWithModel(h, 'up-alpha', 'shared-name');
    const b = seedUpstreamWithModel(h, 'up-beta', 'shared-name');
    const group = await createGroupViaApi(h, 'probe-auth-8');

    const put = await write(h, 'PUT', `/api/groups/${group.id}/models`, {
      models: ['shared-name'],
      revision: group.revision,
    });
    expect(put.statusCode, put.body).toBe(200);

    // 两行（两条档案各一行）—— 名字解析到了谁就授权谁，读出去仍去重成一个名字
    expect(modelRows(h, group.id)).toBe(2);
    const body = put.json() as {
      models: string[] | null;
      authorizedModels: { id: string; upstreamId: string }[];
    };
    expect(body.models).toEqual(['shared-name']);
    expect(body.authorizedModels.map((m) => m.upstreamId).sort()).toEqual([
      'up_probe_up-alpha',
      'up_probe_up-beta',
    ]);
    expect(new Set(body.authorizedModels.map((m) => m.id))).toEqual(new Set([a.modelId, b.modelId]));
  });

  it('停用的档案也能被授权（授权是组的长期策略，停用是档案的临时状态）', async () => {
    const h = await setup();
    const { modelId, modelName } = seedUpstreamWithModel(h);
    h.db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(modelId);
    const group = await createGroupViaApi(h, 'probe-auth-9');

    const put = await write(h, 'PUT', `/api/groups/${group.id}/models`, {
      models: [modelName],
      revision: group.revision,
    });
    // 不报 400：解析面刻意不看 enabled —— 否则"先授权、再启用"会变成一条操作顺序约束
    expect(put.statusCode, put.body).toBe(200);
    expect((put.json() as { models: string[] | null }).models).toEqual([modelName]);
  });
});

describe('级联：两个外键方向各一条显式 DELETE（ADR-0037 决策 7）', () => {
  it('删组（带授权行）→ 204，授权行随之消失（漏了就是 FK 500）', async () => {
    const h = await setup();
    const { modelName } = seedUpstreamWithModel(h);
    const group = await createGroupViaApi(h, 'probe-cascade-group');

    const put = await write(h, 'PUT', `/api/groups/${group.id}/models`, {
      models: [modelName],
      revision: group.revision,
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(modelRows(h, group.id)).toBe(1);

    const del = await write(h, 'DELETE', `/api/groups/${group.id}`);
    // 修好之前这里是 500 INTERNAL / SQLITE_CONSTRAINT_FOREIGNKEY：
    // 组没了但授权行还指着它，foreign_keys=ON 且无 ON DELETE 子句
    expect(del.statusCode, del.body).toBe(204);
    expect(count(h, 'SELECT COUNT(*) AS n FROM groups WHERE id = ?', group.id)).toBe(0);
    expect(modelRows(h, group.id)).toBe(0);
    // 档案本身不受影响：授权消失不等于档案消失
    expect(count(h, 'SELECT COUNT(*) AS n FROM models WHERE name = ?', modelName)).toBe(1);
  });

  it('删上游 force（其档案被某组授权）→ 204，指向被删档案的授权行消失，别的组不受影响', async () => {
    const h = await setup();
    const victim = seedUpstreamWithModel(h, 'up-victim', 'victim-model');
    const keeper = seedUpstreamWithModel(h, 'up-keeper', 'keeper-model');
    const group = await createGroupViaApi(h, 'probe-cascade-upstream');

    const put = await write(h, 'PUT', `/api/groups/${group.id}/models`, {
      models: ['victim-model', 'keeper-model'],
      revision: group.revision,
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(modelRows(h, group.id)).toBe(2);

    const del = await write(h, 'DELETE', `/api/upstreams/${victim.upstreamId}?force=true`);
    // 不清理授权行的话：models 行被删 → group_models.model_id 的外键拦下 → 500
    expect(del.statusCode, del.body).toBe(204);

    expect(count(h, 'SELECT COUNT(*) AS n FROM models WHERE id = ?', victim.modelId)).toBe(0);
    expect(modelRows(h, group.id)).toBe(1);
    const left = await h.app.inject({
      method: 'GET',
      url: `/api/groups/${group.id}/models`,
      headers: { cookie: h.cookie },
    });
    expect((left.json() as { models: string[] | null }).models).toEqual(['keeper-model']);
    // 别组（这里用"没有授权的组"做对照）与另一条档案都没被顺手带走
    expect(count(h, 'SELECT COUNT(*) AS n FROM models WHERE id = ?', keeper.modelId)).toBe(1);
  });

  it('删上游 force 后组退回"不限"（不是退回空集）', async () => {
    const h = await setup();
    const only = seedUpstreamWithModel(h, 'up-only', 'only-model');
    const group = await createGroupViaApi(h, 'probe-cascade-single');

    const put = await write(h, 'PUT', `/api/groups/${group.id}/models`, {
      models: ['only-model'],
      revision: group.revision,
    });
    expect(put.statusCode, put.body).toBe(200);

    expect((await write(h, 'DELETE', `/api/upstreams/${only.upstreamId}?force=true`)).statusCode).toBe(204);
    expect(modelRows(h, group.id)).toBe(0);

    const after = await h.app.inject({
      method: 'GET',
      url: `/api/groups/${group.id}/models`,
      headers: { cookie: h.cookie },
    });
    // 唯一一条授权随档案消失 ⇒ 回到"不限"。这是**语义上唯一自洽**的落点：
    // 留一个空集就造出了决策 3 明确不承认的第三态。
    expect(after.json()).toEqual({ models: null, authorizedModels: [] });
    // 组行的授权列同值（同一份口径，不是两套）
    const detail = await h.app.inject({
      method: 'GET',
      url: `/api/groups/${group.id}`,
      headers: { cookie: h.cookie },
    });
    expect((detail.json() as { authorizedModels: string[] | null }).authorizedModels).toBeNull();
  });
});
