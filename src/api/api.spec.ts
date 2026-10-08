// 管理面 REST 的验收测试（契约 §0.5 / §3 / §6）。
//
// 这里测的不是"函数返回值对不对"，而是**四条一旦破了就会静默出错**的口径：
//   1. key 明文永不落盘 —— 走真实的 HTTP 路由写入，再对 SQLite 裸字节做双向扫描；
//   2. `balance: 0` 与 `balance: null` 是两件事，绝不被合并；
//   3. 余额三口径：只算 category='balance'、未知不补 0、软删不进合计；
//   4. 全量鉴权 + CSRF 闸门覆盖所有 /api/*（含登录本身）。
//
// 明文探针在运行时拼装，源码里不存在该字面量 —— 否则
// `pnpm check:secrets` 会在自己的测试文件里命中，把扫描器变成狼来了。

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import { openDatabase, type Db } from '../db/database.js';
import { sha256Hex } from '../db/crypto.js';
import { upsertKeyRuntimeStates } from '../db/repo/key-runtime.js';
import { upsertModelFromSync } from '../db/repo/models.js';
import { buildApp } from './app.js';
import { bootstrapAdmin } from './auth.js';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'probe-admin-pass-1';

/** 运行时拼装的假上游 key：形状像真的，但源码里没有这个字面量。 */
function probeSecret(): string {
  return ['sk', 'probe', sha256Hex('api-spec-plaintext-probe').slice(0, 40)].join('-');
}

const dirs: string[] = [];
/**
 * 已开、尚未关的 harness。
 *
 * 必须在这里统一收尾而不是每个用例自己 close：任何一个断言失败都会跳过用例末尾的
 * close，句柄一漏，afterEach 的 rmSync 就抛 EBUSY —— 于是**真正的失败信息被清理错误盖掉**，
 * 排查时看到的是"文件删不掉"，而不是"余额口径错了"。踩过一次，所以这么写。
 */
const live: Harness[] = [];
afterEach(async () => {
  for (const h of live.splice(0)) {
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
      /* Windows 上偶尔仍被短时占用，临时目录不影响判据 */
    }
  }
});

async function closeHarness(h: Harness): Promise<void> {
  await h.app.close();
  h.db.close();
  const i = live.indexOf(h);
  if (i >= 0) live.splice(i, 1);
}

interface Harness {
  app: FastifyInstance;
  db: Db;
  dbPath: string;
  cookie: string;
}

function makeConfig(dbPath: string): AppConfig {
  return {
    masterKey: Buffer.from('2a'.repeat(32), 'hex'),
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
    healthSnapshotRetentionDays: 90,
    maxAttempts: 3,
    maxConcurrencyPerKey: 4,
    cooldownLadderSeconds: [0, 60, 300, 900, 1800],
    // 助手未接线：本套用例只覆盖管理面 REST，助手端点有自己的 spec（routes/assistant.spec.ts）
    assistantModel: null,
    // 余额自动同步在测试配置里默认关：本套用例不为它开后台定时器（它有自己的 spec）
    balanceSyncMinutes: 0,
    balanceSnapshotRetentionDays: 90,
  };
}

async function setup(opts: { fetchImpl?: typeof fetch } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'api-probe-'));
  dirs.push(dir);
  const dbPath = join(dir, 'gateway.db');
  const db = openDatabase({ path: dbPath });
  const app = buildApp({
    db,
    config: makeConfig(dbPath),
    // 出站缝在 `buildApp` 那一刻定格。要换掉它只能从这里注入，**不能**事后
    // `vi.stubGlobal('fetch', …)`：那对已经拿定重放的缺省值无效，用例会打到真网络上，
    // 然后以"超时"的形式红 —— 红得与契约毫无关系。
    ...(opts.fetchImpl === undefined ? {} : { supplier: { fetchImpl: opts.fetchImpl } }),
  });
  bootstrapAdmin(db, { ADMIN_USERNAME: ADMIN_USER, ADMIN_PASSWORD: ADMIN_PASS });

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: ADMIN_USER, password: ADMIN_PASS },
    // 登录也是写请求，同样要过 CSRF 第三层（契约 §0.5）
    headers: { 'x-requested-with': 'fetch' },
  });
  expect(res.statusCode, `登录失败: ${res.body}`).toBe(200);
  const raw = res.headers['set-cookie'];
  const cookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '';
  const h: Harness = { app, db, dbPath, cookie };
  live.push(h);
  return h;
}

/** 带会话 + CSRF 头的请求头。 */
function auth(h: Harness, extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: h.cookie, 'x-requested-with': 'fetch', ...extra };
}

async function createUpstream(h: Harness, name = 'probe-up'): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/upstreams',
    headers: auth(h),
    payload: { name, baseUrl: 'https://upstream.example.com' },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

async function createKey(
  h: Harness,
  upstreamId: string,
  body: Record<string, unknown>,
): Promise<{ id: string; maskedKey: string; raw: string }> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/keys',
    headers: auth(h),
    payload: { upstreamId, category: 'balance', ...body },
  });
  expect(res.statusCode, res.body).toBe(201);
  return { ...(res.json() as { id: string; maskedKey: string }), raw: res.body };
}

/**
 * 等到墙上时钟跨过一个毫秒边界。
 *
 * 只为让「同序不变量」那类断言变得确定：`created_at` 是毫秒精度（`nowIso()` 直取
 * `toISOString()`），而 id 是随机 hex，所以同毫秒的两行相对次序不可预测。
 * 上界 200 次是防御性的 —— 即便时钟被冻住也不会把用例挂死。
 */
async function nextMillisecond(): Promise<void> {
  const start = Date.now();
  for (let i = 0; i < 200 && Date.now() === start; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** db 文件 + WAL + SHM 的裸字节。WAL 里可能还留着尚未 checkpoint 的页。 */
function readRawFiles(dbPath: string): Buffer {
  return Buffer.concat(
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p)),
  );
}

function containsPlaintext(raw: Buffer, secretValue: string): boolean {
  const forms = [
    Buffer.from(secretValue, 'utf8'),
    Buffer.from(Buffer.from(secretValue, 'utf8').toString('base64'), 'utf8'),
    Buffer.from(Buffer.from(secretValue, 'utf8').toString('hex'), 'utf8'),
  ];
  return forms.some((f) => f.length > 0 && raw.includes(f));
}

describe('鉴权与 CSRF 闸门（契约 §0.5）', () => {
  it('未登录访问 /api/* 一律 401，错误体是 {code,message}', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/api/upstreams' });
    expect(res.statusCode).toBe(401);
    const body = res.json() as { code: string; message: string };
    expect(body.code).toBe('UNAUTHORIZED');
    expect(typeof body.message).toBe('string');
    // 会话令牌绝不能出现在响应体里
    expect(res.body).not.toContain(h.cookie.split('=')[1] ?? '\u0000');
    await closeHarness(h);
  });

  it('缺 X-Requested-With 的写请求一律 403，即便会话有效', async () => {
    const h = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/upstreams',
      headers: { cookie: h.cookie },
      payload: { name: 'x', baseUrl: 'https://a.example.com' },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe('CSRF_REJECTED');
    await closeHarness(h);
  });
});

describe('key 明文永不落盘（验收第 9 条，走真实 HTTP 写入路径）', () => {
  it('POST /api/keys 之后裸库里找不到明文，响应里只有 ****+后四位', async () => {
    const h = await setup();
    const upstreamId = await createUpstream(h);
    const secretValue = probeSecret();
    const created = await createKey(h, upstreamId, { key: secretValue, balance: 12345 });

    expect(created.maskedKey).toBe(`****${secretValue.slice(-4)}`);
    expect(created.raw).not.toContain(secretValue);

    // 关掉连接再扫，确保 WAL 已落盘且没有缓冲中的明文
    await closeHarness(h);
    const raw = readRawFiles(h.dbPath);
    expect(containsPlaintext(raw, secretValue)).toBe(false);

    // 对照：同一个扫描函数在明文确实存在时必须抓得到，否则上面那句等于没测
    expect(containsPlaintext(Buffer.concat([raw, Buffer.from(secretValue, 'utf8')]), secretValue)).toBe(true);
  });

  it('审计日志里只有掩码，没有明文', async () => {
    const h = await setup();
    const upstreamId = await createUpstream(h);
    const secretValue = probeSecret();
    const created = await createKey(h, upstreamId, { key: secretValue });

    const res = await h.app.inject({ method: 'GET', url: '/api/audit', headers: auth(h) });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(secretValue);

    // 契约定的是审计"最小集"（不含 detail），所以掩码这一列不经过 HTTP 验证 ——
    // 直接读表看它落的是什么，否则这条测试只证明了"响应里没有明文"，
    // 而真正要防的是"明文进了这张表"。
    const row = h.db
      .prepare("SELECT detail FROM audit_log WHERE action = 'key.create'")
      .get() as { detail: string | null } | undefined;
    expect(row?.detail).toBe(created.maskedKey);
    expect(row?.detail ?? '').not.toContain(secretValue);
    await closeHarness(h);
  });
});

describe('余额：0 与 null 是两件事（ADR-0003）', () => {
  it('PUT balance=0 得到 0；PUT balance=null 得到 null 且计入未知', async () => {
    const h = await setup();
    const upstreamId = await createUpstream(h);
    const key = await createKey(h, upstreamId, { key: probeSecret() });

    const zero = await h.app.inject({
      method: 'PUT',
      url: `/api/keys/${key.id}/balance`,
      headers: auth(h),
      payload: { balance: 0, currency: 'CNY' },
    });
    expect(zero.statusCode, zero.body).toBe(200);
    expect((zero.json() as { balance: number | null }).balance).toBe(0);
    expect((zero.json() as { balanceSource: string | null }).balanceSource).toBe('manual');

    let balance = await h.app.inject({ method: 'GET', url: '/api/stats/balance', headers: auth(h) });
    expect((balance.json() as { global: { balanceUnknownKeyCount: number } }).global.balanceUnknownKeyCount).toBe(0);
    // 0 是**已知**的 0，会进合计
    expect((balance.json() as { global: { totalBalance: number | null } }).global.totalBalance).toBe(0);

    const clear = await h.app.inject({
      method: 'PUT',
      url: `/api/keys/${key.id}/balance`,
      headers: auth(h),
      payload: { balance: null },
    });
    expect(clear.statusCode, clear.body).toBe(200);
    expect((clear.json() as { balance: number | null }).balance).toBeNull();
    expect((clear.json() as { balanceSource: string | null }).balanceSource).toBeNull();

    balance = await h.app.inject({ method: 'GET', url: '/api/stats/balance', headers: auth(h) });
    const global = (balance.json() as { global: { totalBalance: number | null; balanceUnknownKeyCount: number } }).global;
    expect(global.balanceUnknownKeyCount).toBe(1);
    // 未知不得补 0 计入合计 —— 全部未知时合计是 null，不是 0
    expect(global.totalBalance).toBeNull();
    await closeHarness(h);
  });

  it('省略 balance 字段被拒（缺省不能用来表达"置回未知"）', async () => {
    const h = await setup();
    const upstreamId = await createUpstream(h);
    const key = await createKey(h, upstreamId, { key: probeSecret() });
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/keys/${key.id}/balance`,
      headers: auth(h),
      payload: { currency: 'CNY' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('INVALID_PARAM');
    await closeHarness(h);
  });
});

describe('余额三口径与软删（ADR-0003 规则 1/4）', () => {
  it('token-plan key 不进金额；软删 key 不进任何合计与未知计数', async () => {
    const h = await setup();
    const upstreamId = await createUpstream(h);
    const kept = await createKey(h, upstreamId, { key: probeSecret(), balance: 5000 });
    const removed = await createKey(h, upstreamId, { key: probeSecret(), balance: 7000 });
    const plan = await createKey(h, upstreamId, {
      key: probeSecret(),
      category: 'token-plan',
      tokenPlan: { remainingTokens: 100000, expiresAt: null },
    });

    const before = await h.app.inject({ method: 'GET', url: '/api/stats/balance', headers: auth(h) });
    const b1 = (before.json() as {
      global: { totalBalance: number | null; balanceKeyCount: number; tokenPlanKeyCount: number };
    }).global;
    expect(b1.totalBalance).toBe(12000);
    expect(b1.balanceKeyCount).toBe(2);
    expect(b1.tokenPlanKeyCount).toBe(1);

    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/keys/${removed.id}`,
      headers: auth(h),
    });
    expect(del.statusCode).toBe(204);

    const after = await h.app.inject({ method: 'GET', url: '/api/stats/balance', headers: auth(h) });
    const g = (after.json() as {
      global: {
        totalBalance: number | null;
        balanceKeyCount: number;
        balanceUnknownKeyCount: number;
        tokenPlanKeyCount: number;
        byUpstream: { totalBalance: number | null; keys: { keyId: string }[] }[];
      };
    }).global;
    expect(g.totalBalance).toBe(5000);
    expect(g.balanceKeyCount).toBe(1);
    expect(g.balanceUnknownKeyCount).toBe(0);
    // 全局 = 各上游之和（规则 2）
    expect(g.totalBalance).toBe(g.byUpstream.reduce((s, u) => s + (u.totalBalance ?? 0), 0));
    expect(g.byUpstream.flatMap((u) => u.keys).map((k) => k.keyId)).toEqual([kept.id]);

    // 软删的 key 默认读不到，带 includeDeleted 才可见
    const gone = await h.app.inject({ method: 'GET', url: `/api/keys/${removed.id}`, headers: auth(h) });
    expect(gone.statusCode).toBe(404);
    const shown = await h.app.inject({
      method: 'GET',
      url: `/api/keys/${removed.id}?includeDeleted=true`,
      headers: auth(h),
    });
    expect(shown.statusCode).toBe(200);
    expect((shown.json() as { deletedAt: string | null }).deletedAt).not.toBeNull();
    expect(plan.id).not.toBe(kept.id);
    await closeHarness(h);
  });
});

describe('乐观锁与参数口径（契约 §0.2 / §6）', () => {
  it('revision 过期返回 409 REVISION_MISMATCH 并带上实际版本号', async () => {
    const h = await setup();
    const upstreamId = await createUpstream(h);
    const key = await createKey(h, upstreamId, { key: probeSecret(), label: 'v1' });

    const first = await h.app.inject({
      method: 'PATCH',
      url: `/api/keys/${key.id}`,
      headers: auth(h),
      payload: { label: 'v2', revision: 1 },
    });
    expect(first.statusCode, first.body).toBe(200);
    const bumped = (first.json() as { revision: number }).revision;
    expect(bumped).toBe(2);

    const stale = await h.app.inject({
      method: 'PATCH',
      url: `/api/keys/${key.id}`,
      headers: auth(h),
      payload: { label: 'v3', revision: 1 },
    });
    expect(stale.statusCode).toBe(409);
    const body = stale.json() as { code: string; details?: { actual?: number } };
    expect(body.code).toBe('REVISION_MISMATCH');
    expect(body.details?.actual).toBe(2);
    await closeHarness(h);
  });

  it('usage 缺 groupBy 时 400 且 details.field 指名道姓', async () => {
    const h = await setup();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/stats/usage?from=2026-10-05T00:00:00.000Z&to=2026-10-06T00:00:00.000Z&bucket=1h',
      headers: auth(h),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { details?: { field?: string } }).details?.field).toBe('groupBy');
    await closeHarness(h);
  });

  it('usage 的 bucket 超点数时自动降档，并把实际档位回显', async () => {
    const h = await setup();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/stats/usage?from=2026-10-05T00:00:00.000Z&to=2026-10-06T00:00:00.000Z&bucket=1m&groupBy=upstream',
      headers: auth(h),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { bucket: string; axis: string[]; series: { points: unknown[] }[] };
    // 24h 按 1m 是 1440 点 > 500，降一档到 5m（288 点）
    expect(body.bucket).toBe('5m');
    expect(body.axis.length).toBeLessThanOrEqual(500);
    for (const s of body.series) expect(s.points.length).toBe(body.axis.length);
    await closeHarness(h);
  });
});

describe('用户组与网关 key（契约 §4，C1）', () => {
  it('建组即签发网关 key，明文只在创建响应出现一次', async () => {
    const h = await setup();
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: auth(h),
      payload: { name: 'probe-group', rpm: 60 },
    });
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json() as {
      id: string;
      gatewayKeyMasked: string | null;
      keyCount: number;
      gatewayKey: { gatewayKey: string; maskedKey: string };
    };
    expect(body.keyCount).toBe(1);
    expect(body.gatewayKey.gatewayKey.startsWith('gw-')).toBe(true);
    expect(body.gatewayKeyMasked).toBe(body.gatewayKey.maskedKey);

    // 详情里不再有明文
    const detail = await h.app.inject({ method: 'GET', url: `/api/groups/${body.id}`, headers: auth(h) });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toContain(body.gatewayKey.gatewayKey);

    // 明文也没落盘
    const secretValue = body.gatewayKey.gatewayKey;
    await closeHarness(h);
    expect(containsPlaintext(readRawFiles(h.dbPath), secretValue)).toBe(false);
  });

  /** 建一个组并再签发一把 key，返回两把 key 的 id / 掩码 / 明文。 */
  async function groupWithTwoKeys(h: Harness, name: string): Promise<{
    groupId: string;
    first: { id: string; gatewayKey: string; maskedKey: string };
    second: { id: string; gatewayKey: string; maskedKey: string };
    gatewayKeyMasked: string | null;
  }> {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: auth(h),
      payload: { name },
    });
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json() as {
      id: string;
      gatewayKeyMasked: string | null;
      gatewayKey: { id: string; gatewayKey: string; maskedKey: string };
    };
    // 显式错开一毫秒再签发第二把。`gateway_keys` 的列表序是 `ORDER BY created_at, id`，
    // 而 id 是随机 hex —— 同毫秒内签发的两把 key，相对次序由随机 id 决定。
    // 下面那条用例要验的是「列表第一项 == Group.gatewayKeyMasked」（契约承诺的同序不变量），
    // 它只在两次签发落在**不同毫秒**时才有意义；不错开的话，快机器上两次插入常常同毫秒，
    // 用例会以约 50% 概率随机失败，把「四闸全绿」变成掷骰子。这是修一个既有的 flaky，不是改判据。
    await nextMillisecond();
    const second = await h.app.inject({
      method: 'POST',
      url: `/api/groups/${body.id}/keys`,
      headers: auth(h),
    });
    expect(second.statusCode, second.body).toBe(201);
    return {
      groupId: body.id,
      first: body.gatewayKey,
      second: second.json() as { id: string; gatewayKey: string; maskedKey: string },
      gatewayKeyMasked: body.gatewayKeyMasked,
    };
  }

  /**
   * 这条测试守的是"前端到底能不能操作单把网关 key"——契约 v1.0-frozen 只给了
   * `Group.gatewayKeyMasked`，:keyId 无处可取，重置/吊销两个端点在 UI 上不可达。
   * 所以判据不是"列表返回了数据"，而是**列表里拿到的 id 真的能驱动 reset**。
   */
  it('GET /api/groups/:id/keys 交出可操作的 keyId，且响应里没有任何明文', async () => {
    const h = await setup();
    const { groupId, first, second, gatewayKeyMasked } = await groupWithTwoKeys(h, 'probe-list-a');

    const list = await h.app.inject({
      method: 'GET',
      url: `/api/groups/${groupId}/keys`,
      headers: auth(h),
    });
    expect(list.statusCode, list.body).toBe(200);
    const page = list.json() as {
      items: { id: string; maskedKey: string; createdAt: string }[];
      total: number;
      page: number;
      pageSize: number;
    };
    expect(page.total).toBe(2);
    expect(page.page).toBe(1);
    // 两把都在，但不假设它们的相对顺序：同一毫秒插入时 created_at 相同，次序由 id 决定
    expect(page.items.map((k) => k.maskedKey).sort()).toEqual(
      [first.maskedKey, second.maskedKey].sort(),
    );
    // 契约承诺的不变量：列表第一项 == Group.gatewayKeyMasked（两处同序，与 id 随机无关）
    expect(page.items[0]?.maskedKey).toBe(gatewayKeyMasked);

    // 列表明文与摘要都不出现：连 "gatewayKey" 这个键名本身都不该有
    expect(list.body).not.toContain(first.gatewayKey);
    expect(list.body).not.toContain(second.gatewayKey);
    expect(list.body).not.toContain('"gatewayKey"');

    // 这是本端点存在的唯一理由：拿到的 id 能真的重置掉它
    const target = page.items.find((k) => k.id !== first.id);
    if (!target) throw new Error('列表里应有第二把 key');
    const reset = await h.app.inject({
      method: 'POST',
      url: `/api/groups/${groupId}/keys/${target.id}/reset`,
      headers: auth(h),
    });
    expect(reset.statusCode, reset.body).toBe(200);
    expect((reset.json() as { id: string }).id).not.toBe(target.id);

    const after = await h.app.inject({
      method: 'GET',
      url: `/api/groups/${groupId}/keys`,
      headers: auth(h),
    });
    const afterItems = (after.json() as { items: { id: string }[] }).items;
    expect(afterItems.some((k) => k.id === target.id)).toBe(false);
    expect(afterItems.length).toBe(2);

    // 跨组越权一律 404（不是 403 —— 不泄漏该 keyId 是否存在）
    const other = await groupWithTwoKeys(h, 'probe-list-b');
    const crossReset = await h.app.inject({
      method: 'POST',
      url: `/api/groups/${other.groupId}/keys/${first.id}/reset`,
      headers: auth(h),
    });
    expect(crossReset.statusCode).toBe(404);
    // 越权失败不能有副作用：本组那把 key 还在
    const still = await h.app.inject({
      method: 'GET',
      url: `/api/groups/${groupId}/keys`,
      headers: auth(h),
    });
    expect((still.json() as { items: { id: string }[] }).items.some((k) => k.id === first.id)).toBe(
      true,
    );

    // 未知组 → 404，不是空列表（空列表会让前端以为"这个组没 key"）
    const missing = await h.app.inject({
      method: 'GET',
      url: '/api/groups/grp_does_not_exist/keys',
      headers: auth(h),
    });
    expect(missing.statusCode).toBe(404);
    await closeHarness(h);
  });

  it('吊销后 key 从列表消失、keyCount 同步，且两把明文都没落盘', async () => {
    const h = await setup();
    const { groupId, first, second } = await groupWithTwoKeys(h, 'probe-revoke');

    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/groups/${groupId}/keys/${second.id}`,
      headers: auth(h),
    });
    expect(del.statusCode, del.body).toBe(204);

    const list = await h.app.inject({
      method: 'GET',
      url: `/api/groups/${groupId}/keys`,
      headers: auth(h),
    });
    const items = (list.json() as { items: { id: string }[]; total: number }).items;
    expect(items.map((k) => k.id)).toEqual([first.id]);

    const detail = await h.app.inject({ method: 'GET', url: `/api/groups/${groupId}`, headers: auth(h) });
    expect((detail.json() as { keyCount: number }).keyCount).toBe(1);

    // 吊销是硬删：那把 keyId 已经不存在，再删一次是 404（重复点不该静默成功）
    const again = await h.app.inject({
      method: 'DELETE',
      url: `/api/groups/${groupId}/keys/${second.id}`,
      headers: auth(h),
    });
    expect(again.statusCode).toBe(404);

    // 两把网关 key 的明文都不得落盘（含被吊销的那把 —— 删行不等于它从没写过）
    await closeHarness(h);
    const raw = readRawFiles(h.dbPath);
    expect(containsPlaintext(raw, first.gatewayKey)).toBe(false);
    expect(containsPlaintext(raw, second.gatewayKey)).toBe(false);
    expect(containsPlaintext(Buffer.concat([raw, Buffer.from(second.gatewayKey, 'utf8')]), second.gatewayKey)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * 自测用假上游。未声明的请求直接抛 —— 静默返回 `{}` 会把"打错端点"伪装成"上游没给数据"。
 *
 * 只实现 queryBalance 真正用到的三个成员（`ok`/`status`/`text`），
 * 不去凑一个完整的 Response：凑出来的假 Response 反而会掩盖真实的读取路径缺陷。
 */
/**
 * 一个假的出站 fetch：把 `body` 当上游响应原样回。
 *
 * **返回假 fetch，而不是 `vi.stubGlobal('fetch', …)`**：自测两条端点走的是
 * `ctx.supplier.fetchImpl`（`balance-selftest.ts` 的 `fetchImpl` 已改必填注入），
 * 而那条缝在 `buildApp` 里就取定了 —— 事后改全局对它无效。硬要 stub 全局，用例就会
 * 静默打到真实上游，然后以"超时"的形式红。
 */
function fakeUpstreamFetch(body: unknown, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async (): Promise<string> => (typeof body === 'string' ? body : JSON.stringify(body)),
  })) as unknown as typeof fetch;
}

/** 自测草稿的默认形状：一个 GET + 直接取值路径。 */
function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: 'https://upstream.example.com/api/balance?token={key}',
    method: 'GET',
    headers: { Authorization: 'Bearer {key}' },
    body: null,
    parse: {
      balance: 'data.balance',
      currency: 'data.currency',
      remainingTokens: null,
      expiresAt: null,
      unit: 'yuan',
    },
    timeoutMs: 5000,
    ...overrides,
  };
}

describe('余额自测（契约 §2 · M6-A）：同步、诊断语义、绝不写库', () => {
  // 本 describe **没有** afterEach/`unstubAllGlobals`：出站全部由 `setup({ fetchImpl })` 注入，
  // 不碰全局。少了这条解除动作本身就是一条断言 —— 有全局兜底的路子才需要解除。

  it('上游级自测用草稿打真实查询：200 + 诊断全量，且不改动已有余额', async () => {
    const h = await setup({ fetchImpl: fakeUpstreamFetch({ data: { balance: '123.45', currency: 'CNY' } }) });
    const upstreamId = await createUpstream(h);
    // 先人工录入一个余额，用来证明"自测只是预览"
    const key = await createKey(h, upstreamId, { key: probeSecret(), balance: 8888 });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/upstreams/${upstreamId}/balance-template/test`,
      headers: auth(h),
      payload: { ...draft(), keyId: key.id },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      ok: boolean;
      source: string;
      presetId: string | null;
      endpoint: string;
      httpStatus: number;
      parsed: { balance: number | null; unit: string };
      keyId: string | null;
      hintCode: string | null;
    };
    expect(body.ok).toBe(true);
    expect(body.source).toBe('user-template');
    expect(body.presetId).toBeNull();
    expect(body.keyId).toBe(key.id);
    expect(body.parsed.balance).toBe(12345); // 123.45 元 → 分
    expect(body.hintCode).toBeNull();
    // endpoint 只留 协议//host/path：URL 里的 `{key}` 已被替换过，绝不能回显
    expect(body.endpoint).toBe('https://upstream.example.com/api/balance');
    expect(res.body).not.toContain(probeSecret());

    // 余额没被这次自测改掉（预览语义）
    const after = await h.app.inject({ method: 'GET', url: `/api/keys/${key.id}`, headers: auth(h) });
    expect((after.json() as { balance: number | null }).balance).toBe(8888);
    await closeHarness(h);
  });

  it('取不到值时 200 + ok:false + 引导码，且 raw 已抹掉明文 key', async () => {
    // 上游正常返回，但字段路径取不到数；同时把 key 明文回显在报错体里（上游常见行为）
    const h = await setup({ fetchImpl: fakeUpstreamFetch({ data: { currency: 'CNY' }, echo: `invalid api key ${probeSecret()}` }) });
    const upstreamId = await createUpstream(h);
    const key = await createKey(h, upstreamId, { key: probeSecret(), balance: 8888 });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/upstreams/${upstreamId}/balance-template/test`,
      headers: auth(h),
      payload: { ...draft(), keyId: key.id },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { ok: boolean; hintCode: string | null; hint: string | null; raw: unknown };
    expect(body.ok).toBe(false);
    expect(body.hintCode).toBe('BALANCE_PARSE_MISMATCH');
    expect(body.hint).toBeTruthy();
    // 明文 key 绝不随 raw 外露（上游回显的那份也必须被抹掉）
    expect(res.body).not.toContain(probeSecret());
    expect(JSON.stringify(body.raw)).toContain('****');

    const after = await h.app.inject({ method: 'GET', url: `/api/keys/${key.id}`, headers: auth(h) });
    expect((after.json() as { balance: number | null }).balance).toBe(8888);
    await closeHarness(h);
  });

  it('上游返回 401 时引导码是"鉴权被拒"，而不是"上游不可达"', async () => {
    const h = await setup({ fetchImpl: fakeUpstreamFetch({ error: 'unauthorized' }, 401) });
    const upstreamId = await createUpstream(h);
    const key = await createKey(h, upstreamId, { key: probeSecret() });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/upstreams/${upstreamId}/balance-template/test`,
      headers: auth(h),
      payload: { ...draft(), keyId: key.id },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { hintCode: string | null }).hintCode).toBe('BALANCE_AUTH_REJECTED');
    await closeHarness(h);
  });

  it('草稿字段写错是 400（请求本身有问题），并指名到具体字段', async () => {
    const h = await setup();
    const upstreamId = await createUpstream(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/upstreams/${upstreamId}/balance-template/test`,
      headers: auth(h),
      payload: { ...draft(), parse: { balance: null, unit: 'yuan' } },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string; details?: { field?: string } };
    expect(body.code).toBe('INVALID_PARAM');
    expect(body.details?.field).toBe('parse.balance');
    await closeHarness(h);
  });

  it('key 级自测：没有可用查询方式时 422，未知 key 404', async () => {
    const h = await setup();
    // 该上游既没启用模板，host 也不命中任何 preset → 三段解析落到 skipped
    const upstreamId = await createUpstream(h);
    const key = await createKey(h, upstreamId, { key: probeSecret() });

    const unprocessable = await h.app.inject({
      method: 'POST',
      url: `/api/keys/${key.id}/test-balance`,
      headers: auth(h),
    });
    expect(unprocessable.statusCode).toBe(422);
    expect((unprocessable.json() as { code: string }).code).toBe('UNPROCESSABLE');

    const missing = await h.app.inject({
      method: 'POST',
      url: '/api/keys/key_does_not_exist/test-balance',
      headers: auth(h),
    });
    expect(missing.statusCode).toBe(404);
    await closeHarness(h);
  });

  it('命中内置 preset 的上游，key 级自测走 preset（无需用户配模板）', async () => {
    // preset 是一个**两跳**查询（subscription + usage），所以这个假 fetch 按 URL 分型回不同 body
    const presetFetch = (async (input: unknown) => {
      const url = String(input);
      const body = url.includes('/subscription') ? { hard_limit_usd: 50 } : { total_usage: 1000 };
      return { ok: true, status: 200, text: async (): Promise<string> => JSON.stringify(body) };
    }) as unknown as typeof fetch;
    const h = await setup({ fetchImpl: presetFetch });
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/upstreams',
      headers: auth(h),
      payload: { name: 'openai-probe', baseUrl: 'https://api.openai.com/v1' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const upstreamId = (created.json() as { id: string; balancePreset: { id: string; effective: boolean } | null }).id;
    // 只读派生字段：命中 preset 且用户模板未启用 → 它就是当前生效者
    expect((created.json() as { balancePreset: { id: string } | null }).balancePreset?.id).toBe('openai');
    expect((created.json() as { balancePreset: { effective: boolean } | null }).balancePreset?.effective).toBe(true);

    const key = await createKey(h, upstreamId, { key: probeSecret() });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/keys/${key.id}/test-balance`,
      headers: auth(h),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { ok: boolean; source: string; presetId: string | null; parsed: { balance: number | null } };
    expect(body.ok).toBe(true);
    expect(body.source).toBe('preset');
    expect(body.presetId).toBe('openai');
    expect(body.parsed.balance).toBe(4000); // (50 − 10) 美元 × 100
    await closeHarness(h);
  });
});

/**
 * 删上游的从属资源处置（契约 §2 / ADR-0016，修订 §11 C4）。
 *
 * 之前只判 key：上游下**有模型档案**时 `DELETE` 会硬删 upstream 行，而
 * `models.upstream_id REFERENCES upstreams(id)` 挡住它 → `500 INTERNAL /
 * SQLITE_CONSTRAINT_FOREIGNKEY`。前端"上游管理"页的删除按钮在这条路上是死的。
 * 用例钉住三件事：①模型也进 409 守卫且拦下零副作用；②根因（软删 key 不解除行级
 * 外键，C4 原文在此 schema 下不可实现）；③`force=true` 按依赖序删整棵子树 + 广播发出。
 */
describe('删上游：从属资源处置（契约 §2 / ADR-0016）', () => {
  async function seedModel(h: Harness, upstreamId: string, name = 'probe-m1'): Promise<string> {
    const { id } = upsertModelFromSync(h.db, {
      upstreamId,
      name,
      displayName: null,
      type: 'chat',
      capabilities: ['stream'],
      contextLength: 128000,
      price: { inputPer1k: 10, outputPer1k: 30 },
    });
    return id;
  }

  function count(h: Harness, sql: string, ...params: unknown[]): number {
    return (h.db.prepare(sql).get(...params) as { n: number }).n;
  }

  it('只有模型、一把 key 都没有时，force!=true 也必须 409（模型同样是从属资源）', async () => {
    const h = await setup();
    const upstreamId = await createUpstream(h);
    await seedModel(h, upstreamId);

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/upstreams/${upstreamId}`,
      headers: auth(h),
    });
    expect(res.statusCode, res.body).toBe(409);
    const body = res.json() as { code: string; details?: { keyCount?: number; modelCount?: number } };
    expect(body.code).toBe('UPSTREAM_HAS_KEYS');
    expect(body.details?.keyCount).toBe(0);
    expect(body.details?.modelCount).toBe(1);

    // 拦下就必须零副作用：上游与模型都还在
    expect(count(h, 'SELECT COUNT(*) AS n FROM upstreams WHERE id = ?', upstreamId)).toBe(1);
    expect(count(h, 'SELECT COUNT(*) AS n FROM models WHERE upstream_id = ?', upstreamId)).toBe(1);
    await closeHarness(h);
  });

  it('根因：key 软删**不解除** upstream_keys→upstreams 外键，上游行照样删不掉（C4 原文不可实现）', async () => {
    const h = await setup();
    const upstreamId = await createUpstream(h);
    await createKey(h, upstreamId, { key: probeSecret() });

    // 把 key 按 C4 的写法软删掉
    h.db
      .prepare("UPDATE upstream_keys SET enabled = 0, deleted_at = '2026-10-07T00:00:00.000Z' WHERE upstream_id = ?")
      .run(upstreamId);

    // 软删之后外键引用还在，父行依然删不掉 —— 这就是 500 的来源，不是"模型才算"
    expect(() => h.db.prepare('DELETE FROM upstreams WHERE id = ?').run(upstreamId)).toThrow(/FOREIGN KEY/i);
    await closeHarness(h);
  });

  it('force=true 级联：上游/模型/key/key_runtime 整棵子树消失，三条广播都发出', async () => {
    const h = await setup();
    const upstreamId = await createUpstream(h);
    const key = await createKey(h, upstreamId, { key: probeSecret() });
    const modelId = await seedModel(h, upstreamId);
    upsertKeyRuntimeStates(h.db, [
      { keyId: key.id, consecutiveFails: 2, cooldownUntilMs: null, lastFailureReason: null, lastFailureAtMs: null },
    ]);

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/upstreams/${upstreamId}?force=true`,
      headers: auth(h),
    });
    // 修复前这里就是 500 INTERNAL / SQLITE_CONSTRAINT_FOREIGNKEY
    expect(res.statusCode, res.body).toBe(204);

    expect(count(h, 'SELECT COUNT(*) AS n FROM upstreams WHERE id = ?', upstreamId)).toBe(0);
    expect(count(h, 'SELECT COUNT(*) AS n FROM models WHERE upstream_id = ?', upstreamId)).toBe(0);
    expect(count(h, 'SELECT COUNT(*) AS n FROM upstream_keys WHERE upstream_id = ?', upstreamId)).toBe(0);
    // 运行态镜像跟着走，否则会留下指向已删 key 的孤儿行（ADR-0010 的已知缺口不再扩大）
    expect(count(h, 'SELECT COUNT(*) AS n FROM key_runtime WHERE key_id = ?', key.id)).toBe(0);

    // 广播：网关快照按 entity 增量重建，漏发 model 那条会让已删模型继续被路由
    const changes = h.db
      .prepare('SELECT entity, entity_id AS entityId, op FROM change_log')
      .all() as { entity: string; entityId: string; op: string }[];
    expect(changes).toContainEqual({ entity: 'model', entityId: modelId, op: 'delete' });
    expect(changes).toContainEqual({ entity: 'key', entityId: key.id, op: 'delete' });
    expect(changes).toContainEqual({ entity: 'upstream', entityId: upstreamId, op: 'delete' });

    // 端点侧看：上游 404、模型列表里不再有它
    const gone = await h.app.inject({ method: 'GET', url: `/api/upstreams/${upstreamId}`, headers: auth(h) });
    expect(gone.statusCode).toBe(404);
    const models = await h.app.inject({ method: 'GET', url: '/api/models', headers: auth(h) });
    expect(models.statusCode, models.body).toBe(200);
    expect((models.json() as { items: { id: string }[] }).items.some((m) => m.id === modelId)).toBe(false);
    await closeHarness(h);
  });

  it('只带 key 的路径：force=false 仍 409（modelCount 0），force=true 204', async () => {
    const h = await setup();
    const upstreamId = await createUpstream(h);
    await createKey(h, upstreamId, { key: probeSecret() });

    const guarded = await h.app.inject({
      method: 'DELETE',
      url: `/api/upstreams/${upstreamId}`,
      headers: auth(h),
    });
    expect(guarded.statusCode).toBe(409);
    expect((guarded.json() as { details?: { modelCount?: number } }).details?.modelCount).toBe(0);

    const forced = await h.app.inject({
      method: 'DELETE',
      url: `/api/upstreams/${upstreamId}?force=true`,
      headers: auth(h),
    });
    expect(forced.statusCode, forced.body).toBe(204);
    await closeHarness(h);
  });
});

describe('§2 / §15.6：supplier 能力位与新聚合字段（HTTP 面）', () => {
  it('POST 带 supplier=tierflow → 201 且回显；通用上游恒 null + 账号格全 0/null', async () => {
    const h = await setup();

    const generic = await h.app.inject({
      method: 'POST',
      url: '/api/upstreams',
      headers: auth(h),
      payload: { name: 'generic', baseUrl: 'https://generic.example.com' },
    });
    expect(generic.statusCode, generic.body).toBe(201);
    const g = generic.json() as UpstreamFields;
    // 省略 supplier == 通用上游，与加这一列之前逐字一致
    expect(g.supplier).toBeNull();
    expect(g.accountCount).toBe(0);
    expect(g.accountsBalance).toBeNull();
    expect(g.accountsBalanceUnknownCount).toBe(0);
    expect(g.unlimitedKeyCount).toBe(0);

    const tf = await h.app.inject({
      method: 'POST',
      url: '/api/upstreams',
      headers: auth(h),
      payload: { name: 'tf', baseUrl: 'https://tierflow.cn', supplier: 'tierflow' },
    });
    expect(tf.statusCode, tf.body).toBe(201);
    expect((tf.json() as UpstreamFields).supplier).toBe('tierflow');
    await closeHarness(h);
  });

  it('supplier 是枚举不是自由文本（写错一个字的后果是静默走错驱动器）', async () => {
    const h = await setup();
    const bad = await h.app.inject({
      method: 'POST',
      url: '/api/upstreams',
      headers: auth(h),
      payload: { name: 'oops', baseUrl: 'https://oops.example.com', supplier: 'tierflow-cn' },
    });
    expect(bad.statusCode).toBe(400);
    await closeHarness(h);
  });

  it('PATCH supplier 可置回 null（显式降级），且省略时不动它', async () => {
    const h = await setup();
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/upstreams',
      headers: auth(h),
      payload: { name: 'tf', baseUrl: 'https://tierflow.cn', supplier: 'tierflow' },
    });
    const { id, revision } = created.json() as { id: string; revision: number };

    // 只改名字：supplier 必须原封不动（省略 ≠ 清空）
    const renamed = await h.app.inject({
      method: 'PATCH',
      url: `/api/upstreams/${id}`,
      headers: auth(h),
      payload: { name: 'tf2', revision },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect((renamed.json() as UpstreamFields).supplier).toBe('tierflow');

    const downgraded = await h.app.inject({
      method: 'PATCH',
      url: `/api/upstreams/${id}`,
      headers: auth(h),
      payload: { supplier: null, revision: revision + 1 },
    });
    expect(downgraded.statusCode, downgraded.body).toBe(200);
    expect((downgraded.json() as UpstreamFields).supplier).toBeNull();
    await closeHarness(h);
  });

  it('§6 两个统计端点都带新字段，且 keysBalance 与 totalBalance 无账号时相等', async () => {
    const h = await setup();
    const upstreamId = await createUpstream(h);
    await createKey(h, upstreamId, { key: probeSecret(), balance: 2400 });

    const overview = await h.app.inject({ method: 'GET', url: '/api/stats/overview', headers: auth(h) });
    const og = (overview.json() as {
      balance: { global: { totalBalance: number | null; unlimitedKeyCount: number; accountsBalanceUnknownCount: number; byUpstream: UpstreamFields[] } };
    }).balance.global;
    expect(og.totalBalance).toBe(2400);
    expect(og.unlimitedKeyCount).toBe(0);
    expect(og.accountsBalanceUnknownCount).toBe(0);
    expect(og.byUpstream[0]?.keysBalance).toBe(2400);
    expect(og.byUpstream[0]?.accountCount).toBe(0);

    const balance = await h.app.inject({ method: 'GET', url: '/api/stats/balance', headers: auth(h) });
    const bg = (balance.json() as {
      global: { totalBalance: number | null; unlimitedKeyCount: number; accountsBalanceUnknownCount: number; byUpstream: UpstreamFields[] };
    }).global;
    expect(bg.totalBalance).toBe(2400);
    expect(bg.byUpstream[0]?.accountsBalance).toBeNull();
  });

  it('§3 KeyDto 出口带 unlimited（老 key 恒 false，且 balance 仍是数值）', async () => {
    const h = await setup();
    const upstreamId = await createUpstream(h);
    const key = await createKey(h, upstreamId, { key: probeSecret(), balance: 500 });

    const res = await h.app.inject({ method: 'GET', url: `/api/keys/${key.id}`, headers: auth(h) });
    const dto = res.json() as { unlimited: boolean; balance: number | null };
    expect(dto.unlimited).toBe(false);
    expect(dto.balance).toBe(500);
    await closeHarness(h);
  });
});

/** 只声明本组断言要用的字段，避免把整个 DTO 抄一遍后跟着漂。 */
interface UpstreamFields {
  supplier: string | null;
  accountCount: number;
  accountsBalance: number | null;
  accountsBalanceUnknownCount: number;
  unlimitedKeyCount: number;
  keysBalance: number | null;
}
