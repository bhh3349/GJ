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
    logRetentionDays: 30,
    maxAttempts: 3,
    maxConcurrencyPerKey: 4,
    cooldownLadderSeconds: [0, 60, 300, 900, 1800],
  };
}

async function setup(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'api-probe-'));
  dirs.push(dir);
  const dbPath = join(dir, 'gateway.db');
  const db = openDatabase({ path: dbPath });
  const app = buildApp({ db, config: makeConfig(dbPath) });
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
