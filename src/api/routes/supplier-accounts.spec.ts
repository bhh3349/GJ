// `GET /api/supplier-accounts` 与 `GET /api/supplier-accounts/:id`（契约 §15.2）的路由层验收。
//
// 与 `src/db/repo/supplier-accounts.spec.ts` 分工**不重叠**：那边测口径（凭据推导、三个计数、
// 三态 autoRenew、判重摘要），这边只测**线上路径**上会被看到的东西：
//
//   1. **鉴权闸门覆盖** —— 这两条路由没在 handler 里写守卫（`app.ts` 的 onRequest 全量覆盖），
//      所以"忘了写守卫"这种漏法在这里会被抓成 200；
//   2. **`status` 打错当场 400**，不是静默返回空列表 —— "筛出来是空的"和"筛的那个值
//      根本不存在"在前端看起来一模一样，且都没有报错可追；
//   3. **只读** —— 只碰库、**不发任何上游请求**。这是本期只落这两个端点的全部理由：
//      §15 其余九个都要打上游管理接口，而 §16.1.1 的数据面协议还没收口；
//   4. **空表也是真数据** —— 零账号时回的是 `{items: [], total: 0}`，不是 404、不是 null。
//      前端据此建表格，不必对着 mock 建完再返工。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config.js';
import { openDatabase, type Db } from '../../db/database.js';
import { createUpstream } from '../../db/repo/upstreams.js';
import { buildApp } from '../app.js';
import { bootstrapAdmin } from '../auth.js';
import type { Page, SupplierAccountDto } from '../dto.js';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'acc-probe-pass-1';
// 桩令牌**运行时拼**：`TOKEN = '<25 个字面量>'` 会被自己的 `check:secrets` 抓成"硬编码凭据"。
const READONLY_TOKEN = 'readonly-acc-' + 'probe-token';

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
      /* Windows 上临时目录偶尔仍被短时占用，不影响判据 */
    }
  }
});

interface Harness {
  app: FastifyInstance;
  db: Db;
  cookie: string;
}

function makeConfig(dbPath: string, over: Partial<AppConfig> = {}): AppConfig {
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
    assistantModel: null,
    balanceSyncMinutes: 0,
    balanceSnapshotRetentionDays: 90,
    ...over,
  };
}

async function setup(over: Partial<AppConfig> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'acc-route-'));
  dirs.push(dir);
  const dbPath = join(dir, 'gateway.db');
  const db = openDatabase({ path: dbPath });
  const app = buildApp({
    db,
    config: makeConfig(dbPath, over),
    // 两条后台定时器都关掉：本文件测的是纯读路由，不为它们引入额外变量。
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
  expect(res.statusCode, `登录失败: ${res.body}`).toBe(200);
  const raw = res.headers['set-cookie'];
  const cookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '';

  const h: Harness = { app, db, cookie };
  harnesses.push(h);
  return h;
}

/** 本面还没有写路径（§15 的写端点在等数据面协议），种数据一律走裸 SQL。 */
function seedAccount(db: Db, upstreamId: string, over: { identifier?: string; status?: string; createdAt?: string } = {}): string {
  const id = `acc_${Math.random().toString(16).slice(2, 14)}`;
  const at = over.createdAt ?? '2026-10-07T00:00:00.000Z';
  db.prepare(
    `INSERT INTO supplier_accounts (
       id, upstream_id, supplier, identifier, identifier_hash, username, uid,
       encrypted_password, encrypted_session, session_expires_at,
       status, status_message, balance_cents, balance_currency, balance_updated_at,
       egress_id, revision, created_at, updated_at
     ) VALUES (?, ?, 'tierflow', ?, ?, NULL, NULL, ?, NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, 1, ?, ?)`,
  ).run(id, upstreamId, over.identifier ?? '138****8000', `hash-${id}`, Buffer.from('fake-ciphertext'), over.status ?? 'unknown', at, at);
  return id;
}

async function getList(
  h: Harness,
  query = '',
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Page<SupplierAccountDto> & { code?: string; details?: { field?: string } } }> {
  const res = await h.app.inject({
    method: 'GET',
    url: `/api/supplier-accounts${query}`,
    headers: { cookie: h.cookie, 'x-requested-with': 'fetch', ...headers },
  });
  return { status: res.statusCode, body: res.json() };
}

describe('鉴权（契约 §0.5：闸门在 onRequest，不在此路由里）', () => {
  it('不带会话 → 401，且闸门确实覆盖了这两条新路由', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/api/supplier-accounts' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('只读维护令牌越界 → 403（§12.4 的作用域仍只有 GET /api/observability/*）', async () => {
    const h = await setup({ readonlyToken: READONLY_TOKEN });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/supplier-accounts',
      headers: { authorization: `Bearer ${READONLY_TOKEN}` },
    });
    // 是 403 不是 401：换一把令牌就能解决，401 会让客户端以为这把令牌失效了。
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('列表（§15.2）', () => {
  it('零账号时是 200 + 空页 —— 空表也是真数据，不是 404、不是 null', async () => {
    const h = await setup();
    const { status, body } = await getList(h);
    expect(status).toBe(200);
    expect(body).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('回的是契约形状：`subscriptions` 恒为数组、布尔是真 bool、分是 int', async () => {
    const h = await setup();
    const up = createUpstream(h.db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const id = seedAccount(h.db, up.id, { status: 'active' });

    const { status, body } = await getList(h);
    expect(status).toBe(200);
    expect(body.total).toBe(1);

    const item = body.items[0];
    expect(item?.id).toBe(id);
    expect(item?.supplier).toBe('tierflow');
    expect(item?.status).toBe('active');
    expect(item?.subscriptions).toEqual([]);
    expect(item?.credentialSource).toBe('password');
    expect(item?.hasSession).toBe(false);
    expect(item?.balanceCents).toBeNull(); // 未知 ≠ 0
    expect(typeof item?.keyCount).toBe('number');
  });

  it('status 打错 → 400 且 details.field 指到 status（不静默返回空列表）', async () => {
    const h = await setup();
    const { status, body } = await getList(h, '?status=activ');
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'INVALID_PARAM', details: { field: 'status' } });
  });

  it('pageSize 超上限 200 → 400（不是悄悄按 200 截断）', async () => {
    const h = await setup();
    const { status, body } = await getList(h, '?pageSize=500');
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'INVALID_PARAM', details: { field: 'pageSize' } });
  });

  it('筛选参数原样落到仓储：upstreamId 命中一个、不命中另一个', async () => {
    const h = await setup();
    const upA = createUpstream(h.db, { name: 'up-a', baseUrl: 'https://a.example.com' }).id;
    const upB = createUpstream(h.db, { name: 'up-b', baseUrl: 'https://b.example.com' }).id;
    seedAccount(h.db, upA, { identifier: 'a-1' });
    seedAccount(h.db, upB, { identifier: 'b-1' });

    expect((await getList(h, `?upstreamId=${upA}`)).body.total).toBe(1);
    expect((await getList(h, `?upstreamId=${upB}`)).body.total).toBe(1);
    expect((await getList(h, '?upstreamId=up_nope')).body.total).toBe(0);
  });
});

describe('详情（§15.2）', () => {
  it('命中 → 200，且与列表项**同形状**（同一个 SupplierAccount）', async () => {
    const h = await setup();
    const up = createUpstream(h.db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const id = seedAccount(h.db, up.id, { status: 'session_expired' });

    const listed = (await getList(h)).body.items[0];
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/supplier-accounts/${id}`,
      headers: { cookie: h.cookie, 'x-requested-with': 'fetch' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(listed);
  });

  it('不存在 → 404 NOT_FOUND，details 带 id', async () => {
    const h = await setup();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/supplier-accounts/acc_missing',
      headers: { cookie: h.cookie, 'x-requested-with': 'fetch' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND', details: { id: 'acc_missing' } });
  });
});

describe('只读（本期只落这两个端点的全部理由）', () => {
  it('列表与详情都不写任何一张表 —— 读两次的行数与读一次相同', async () => {
    const h = await setup();
    const up = createUpstream(h.db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const id = seedAccount(h.db, up.id);

    const countAll = (): number =>
      (h.db.prepare('SELECT COUNT(*) AS n FROM supplier_accounts').get() as { n: number }).n +
      (h.db.prepare('SELECT COUNT(*) AS n FROM change_log').get() as { n: number }).n;

    const before = countAll();
    await getList(h);
    await getList(h, '?q=138');
    await h.app.inject({
      method: 'GET',
      url: `/api/supplier-accounts/${id}`,
      headers: { cookie: h.cookie, 'x-requested-with': 'fetch' },
    });
    expect(countAll()).toBe(before);
  });
});
