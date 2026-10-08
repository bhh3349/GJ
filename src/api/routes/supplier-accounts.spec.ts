// `GET /api/supplier-accounts` 与 `GET /api/supplier-accounts/:id`（契约 §15.2）的路由层验收。
//
// 与 `src/db/repo/supplier-accounts.spec.ts` 分工**不重叠**：那边测口径（凭据推导、三个计数、
// 三态 autoRenew、判重摘要），这边只测**线上路径**上会被看到的东西：
//
//   1. **鉴权闸门覆盖** —— 这些路由没在 handler 里写守卫（`app.ts` 的 onRequest 全量覆盖），
//      所以"忘了写守卫"这种漏法在这里会被抓成 200；
//   2. **`status` 打错当场 400**，不是静默返回空列表 —— "筛出来是空的"和"筛的那个值
//      根本不存在"在前端看起来一模一样，且都没有报错可追；
//   3. **不发任何上游请求** —— 这是本期只落这五个端点的全部理由：§15 其余六个都要打
//      上游管理接口，而 §16.1.1 的数据面协议还没收口；
//   4. **空表也是真数据** —— 零账号时回的是 `{items: [], total: 0}`，不是 404、不是 null。
//      前端据此建表格，不必对着 mock 建完再返工；
//   5. **删账号只解绑、不删 key**（§15.2）—— 这条是本节最贵的一条：搞反了，
//      删除账号的动作会**打穿流量**（网关下一轮快照里少一批可用 key），而删除本身是成功的。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config.js';
import { openDatabase, type Db } from '../../db/database.js';
import { newId } from '../../db/ids.js';
import { createKey } from '../../db/repo/keys.js';
import { createUpstream } from '../../db/repo/upstreams.js';
import { buildApp } from '../app.js';
import { bootstrapAdmin } from '../auth.js';
import { SUPPLIER_ACCOUNT_CSV_HEADERS } from '../services/supplier-accounts-export.js';
import type { Page, SupplierAccountDto, SupplierSubscriptionRowDto } from '../dto.js';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'acc-probe-pass-1';
// 桩令牌**运行时拼**：`TOKEN = '<25 个字面量>'` 会被自己的 `check:secrets` 抓成"硬编码凭据"。
const READONLY_TOKEN = 'readonly-acc-' + 'probe-token';
/** 与 `makeConfig` 里那把是同一把：种 key 要用它加密，路由读到的才是同一份数据。 */
const MASTER_KEY = Buffer.from('2a'.repeat(32), 'hex');

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

/** 套餐行。`end_at` 是本面排序的键，所以它是这里唯一必填的语义字段。 */
function seedSubscription(
  db: Db,
  accountId: string,
  over: { subNo: string; endAt?: string | null; planTitle?: string | null },
): void {
  const id = 'sub_' + Math.random().toString(16).slice(2, 14);
  db.prepare(
    `INSERT INTO supplier_account_subscriptions (
       id, account_id, sub_no, plan_title, plan_slug, amount_total_cents, amount_used_cents,
       paid_cents, basic_token_total, basic_token_used, status, source, start_at, end_at,
       auto_renew, has_key, key_masked, updated_at
     ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 'active', 'tierflow', NULL, ?, NULL, 0, NULL, ?)`,
  ).run(id, accountId, over.subNo, over.planTitle ?? null, over.endAt ?? null, '2026-10-07T00:00:00.000Z');
}

/** 台账行：`pooledKeyId` 非空 = 这把池内 key 属于该账号（§15.1 `keyCount` 的判据）。 */
function bindKey(db: Db, accountId: string, pooledKeyId: string | null): void {
  const at = '2026-10-07T00:00:00.000Z';
  db.prepare(
    `INSERT INTO supplier_account_keys (id, account_id, masked_key, pooled_key_id, note, created_at, updated_at)
     VALUES (?, ?, '****abcd', ?, NULL, ?, ?)`,
  ).run(newId('supplierAccountKey'), accountId, pooledKeyId, at, at);
}

/** 真在池里的 key（`upstream_keys` 有行）—— 桩 key 运行时拼，别被 `check:secrets` 抓。 */
let keySeq = 0;
function seedPooledKey(db: Db, upstreamId: string, balance: number | null = 100): string {
  const dto = createKey(
    db,
    {
      upstreamId,
      key: 'sk-probe-' + String(++keySeq).padStart(3, '0') + 'X'.repeat(20),
      category: 'balance',
      balance,
    },
    MASTER_KEY,
  );
  return dto.id;
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

// ─────────────────────────────────────────────────────────────────────────────

async function getSubscriptions(
  h: Harness,
  query = '',
): Promise<{ status: number; body: Page<SupplierSubscriptionRowDto> }> {
  const res = await h.app.inject({
    method: 'GET',
    url: `/api/supplier-accounts/subscriptions${query}`,
    headers: { cookie: h.cookie, 'x-requested-with': 'fetch' },
  });
  return { status: res.statusCode, body: res.json() };
}

describe('扁平套餐列表（§15.2）', () => {
  it('零套餐时是 200 + 空页（空表也是真数据）', async () => {
    const h = await setup();
    const { status, body } = await getSubscriptions(h);
    expect(status).toBe(200);
    expect(body).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('每一行都带归属（accountId / 掩码 identifier / upstreamId）—— 没有主语的 subNo 对不了账', async () => {
    const h = await setup();
    const up = createUpstream(h.db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const acc = seedAccount(h.db, up.id, { identifier: '138****8000' });
    seedSubscription(h.db, acc, { subNo: 'SB-1', endAt: '2026-11-01T00:00:00.000Z' });

    const { body } = await getSubscriptions(h);
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      subNo: 'SB-1',
      accountId: acc,
      accountIdentifier: '138****8000',
      upstreamId: up.id,
    });
    // 形状是 `SupplierSubscriptionDto` **加**三个归属字段：详情里那一份有的，这里一个不少
    expect(body.items[0]).toHaveProperty('autoRenew', null);
    expect(body.items[0]).toHaveProperty('hasKey', false);
  });

  it('按 end_at 升序、**没有到期时间的排最后** —— 这个端点的用途就是"接下来谁到期"', async () => {
    const h = await setup();
    const up = createUpstream(h.db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const acc = seedAccount(h.db, up.id);
    // 插入顺序刻意打乱；SQLite 把 NULL 当最小值，不专门处理的话它会挤到**最前**，
    // 把真正快到期的那几条挤出首页 —— 而那正是管理员打开这一页要找的东西。
    seedSubscription(h.db, acc, { subNo: 'SB-late', endAt: '2026-12-01T00:00:00.000Z' });
    seedSubscription(h.db, acc, { subNo: 'SB-null', endAt: null });
    seedSubscription(h.db, acc, { subNo: 'SB-early', endAt: '2026-10-20T00:00:00.000Z' });

    const { body } = await getSubscriptions(h);
    expect(body.items.map((s) => s.subNo)).toEqual(['SB-early', 'SB-late', 'SB-null']);
  });

  it('upstreamId 过滤：只出那一个上游的套餐', async () => {
    const h = await setup();
    const upA = createUpstream(h.db, { name: 'up-a', baseUrl: 'https://a.example.com' }).id;
    const upB = createUpstream(h.db, { name: 'up-b', baseUrl: 'https://b.example.com' }).id;
    seedSubscription(h.db, seedAccount(h.db, upA), { subNo: 'SB-a', endAt: null });
    seedSubscription(h.db, seedAccount(h.db, upB), { subNo: 'SB-b', endAt: null });

    expect((await getSubscriptions(h, `?upstreamId=${upA}`)).body.items.map((s) => s.subNo)).toEqual([
      'SB-a',
    ]);
    expect((await getSubscriptions(h, '?upstreamId=up_nope')).body.total).toBe(0);
  });

  it('pageSize 超上限 200 → 400（与列表同一个分页信封口径）', async () => {
    const h = await setup();
    const { status, body } = await getSubscriptions(h, '?pageSize=201');
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'INVALID_PARAM', details: { field: 'pageSize' } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

async function getExport(
  h: Harness,
  query = '',
): Promise<{ status: number; text: string; headers: Record<string, unknown> }> {
  const res = await h.app.inject({
    method: 'GET',
    url: `/api/supplier-accounts/export${query}`,
    headers: { cookie: h.cookie, 'x-requested-with': 'fetch' },
  });
  return { status: res.statusCode, text: res.body, headers: res.headers as Record<string, unknown> };
}

/** 切表体成行（末尾那个空串是 CRLF 收尾的产物，不是一行）。 */
const csvLines = (csv: string): string[] => csv.replace(/^﻿/, '').split('\r\n').slice(0, -1);

describe('对账表导出（§15.2）', () => {
  it('产物是 CSV 文件本身：content-type / 附件文件名 / UTF-8 BOM', async () => {
    const h = await setup();
    const { status, text, headers } = await getExport(h);
    expect(status).toBe(200);
    expect(headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
    expect(String(headers['content-disposition'])).toMatch(
      /^attachment; filename="supplier-accounts-\d{8}\.csv"$/,
    );
    // 没有 BOM 时 Windows Excel 按 GBK 解，打开就是乱码 —— 而"导出打开是乱码"
    // 会被当成数据损坏去查一遍后端。
    expect(text.startsWith('﻿')).toBe(true);
  });

  it('表头 + 每账号一行；零账号也仍有表头（不是零字节文件）', async () => {
    const h = await setup();
    const up = createUpstream(h.db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    seedAccount(h.db, up.id);
    seedAccount(h.db, up.id);

    const { text } = await getExport(h);
    expect(csvLines(text)[0]).toBe(SUPPLIER_ACCOUNT_CSV_HEADERS.join(','));
    expect(csvLines(text)).toHaveLength(3);

    const empty = await getExport(h, '?upstreamId=up_nope');
    expect(csvLines(empty.text)).toEqual([SUPPLIER_ACCOUNT_CSV_HEADERS.join(',')]);
  });

  it('导出里只有掩码：账号的密文列一个字节都不进响应', async () => {
    const h = await setup();
    const up = createUpstream(h.db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const id = seedAccount(h.db, up.id);
    // 给密文列塞一个可辨认的标记：整份 CSV 里出现它 = 凭据漏出去了
    h.db
      .prepare('UPDATE supplier_accounts SET encrypted_password = ? WHERE id = ?')
      .run(Buffer.from('CIPHERTEXT-MARKER-aaa'), id);

    const { text } = await getExport(h);
    expect(text).not.toContain('CIPHERTEXT-MARKER');
    expect(text).not.toMatch(/encrypted|password|session/i);
    expect(text).toContain('138****8000');
  });

  it('upstreamId 过滤：只导那一个上游的账号', async () => {
    const h = await setup();
    const upA = createUpstream(h.db, { name: 'up-a', baseUrl: 'https://a.example.com' }).id;
    const upB = createUpstream(h.db, { name: 'up-b', baseUrl: 'https://b.example.com' }).id;
    seedAccount(h.db, upA, { identifier: 'a****1' });
    seedAccount(h.db, upB, { identifier: 'b****1' });

    const all = await getExport(h);
    expect(csvLines(all.text)).toHaveLength(3);

    const one = await getExport(h, `?upstreamId=${upA}`);
    expect(csvLines(one.text)).toHaveLength(2);
    expect(one.text).toContain('a****1');
    expect(one.text).not.toContain('b****1');
  });

  it('供应商侧文本以 `=` 开头 → 单元格被前缀单引号（Excel 不会执行它）', async () => {
    const h = await setup();
    const up = createUpstream(h.db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    seedAccount(h.db, up.id, { identifier: '=HYPERLINK("http://evil.example/")' });

    const { text } = await getExport(h);
    // 前缀单引号（防执行）+ 外层引号与内部引号翻倍（RFC 4180）—— 两层各自成立
    expect(text).toContain(`"'=HYPERLINK(""http://evil.example/"")"`);
  });

  it('**GET 也写一条审计** —— 批量带走全部账号清单是这面上最该留痕的动作', async () => {
    const h = await setup();
    const up = createUpstream(h.db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    seedAccount(h.db, up.id);

    expect(await getExport(h)).toBeTruthy();
    const row = h.db
      .prepare("SELECT action, target_type, detail FROM audit_log WHERE action = 'supplier.export'")
      .get() as { action: string; target_type: string; detail: string } | undefined;
    expect(row).toMatchObject({ action: 'supplier.export', target_type: 'supplier_account' });
    // detail 只放行数：identifier 列表正是这次要带出去的东西，写进审计等于又抄一份到别处
    expect(row?.detail).toBe('rows=1');
    expect(row?.detail).not.toMatch(/138/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

async function del(
  h: Harness,
  id: string,
  query = '',
): Promise<{ status: number; body: { code?: string; details?: { keyCount?: number } } }> {
  const res = await h.app.inject({
    method: 'DELETE',
    url: `/api/supplier-accounts/${id}${query}`,
    headers: { cookie: h.cookie, 'x-requested-with': 'fetch' },
  });
  return { status: res.statusCode, body: res.body === '' ? {} : res.json() };
}

const countOf = (h: Harness, sql: string, ...params: string[]): number =>
  (h.db.prepare(sql).get(...params) as { n: number }).n;

describe('删账号（§15.2：`force` 的语义与删上游**不同**）', () => {
  it('名下有已入池 key 且未带 force → 409 ACCOUNT_HAS_KEYS，且**零副作用**', async () => {
    const h = await setup();
    const up = createUpstream(h.db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const acc = seedAccount(h.db, up.id);
    bindKey(h.db, acc, seedPooledKey(h.db, up.id));
    seedSubscription(h.db, acc, { subNo: 'SB-1', endAt: null });

    const { status, body } = await del(h, acc);
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'ACCOUNT_HAS_KEYS', details: { keyCount: 1 } });
    // 拦下时零副作用：先判定、后开事务。账号、套餐、台账、key 全在原地
    expect(countOf(h, 'SELECT COUNT(*) AS n FROM supplier_accounts')).toBe(1);
    expect(countOf(h, 'SELECT COUNT(*) AS n FROM supplier_account_subscriptions')).toBe(1);
    expect(countOf(h, 'SELECT COUNT(*) AS n FROM supplier_account_keys')).toBe(1);
    expect(countOf(h, 'SELECT COUNT(*) AS n FROM upstream_keys')).toBe(1);
    // 被拦下的动作不写"成功"审计 —— 审计里有一条 ok 会让人以为删成了
    expect(countOf(h, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'supplier.account.delete'")).toBe(0);
  });

  it('force=true → 204：账号/套餐/台账行消失，**池内 key 一行不动**', async () => {
    const h = await setup();
    const up = createUpstream(h.db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const acc = seedAccount(h.db, up.id);
    const keyId = seedPooledKey(h.db, up.id, 5000);
    bindKey(h.db, acc, keyId);
    seedSubscription(h.db, acc, { subNo: 'SB-1', endAt: null });
    // 种数据本身就会写 change_log（建上游、建 key 各一条），所以判据是**差值**而不是绝对值：
    // 断言 0 等于在断言"库里从没建过任何东西"，那是另一件事，且会随 fixture 变化而误报。
    const before = countOf(h, 'SELECT COUNT(*) AS n FROM change_log');
    // 「这把 key 的归属变更」同样按**差值**判：bindKey 自己就发过一条，绝对值会跟着 fixture 漂。
    const beforeKeyChanges = countOf(
      h,
      "SELECT COUNT(*) AS n FROM change_log WHERE entity = 'key' AND entity_id = ?",
      keyId,
    );

    const { status } = await del(h, acc, '?force=true');
    expect(status).toBe(204);

    expect(countOf(h, 'SELECT COUNT(*) AS n FROM supplier_accounts')).toBe(0);
    expect(countOf(h, 'SELECT COUNT(*) AS n FROM supplier_account_subscriptions')).toBe(0);
    expect(countOf(h, 'SELECT COUNT(*) AS n FROM supplier_account_keys')).toBe(0);
    // 这条是本节的判据：key 还在池里、还没软删。删了它，网关下一轮快照就少一把可用 key，
    // 客户端开始报"没有可用 key"——**删除账号的动作打穿了流量**。
    expect(countOf(h, 'SELECT COUNT(*) AS n FROM upstream_keys WHERE id = ? AND deleted_at IS NULL', keyId)).toBe(1);

    // 解绑要发 change_log（ADR-0021 决策 5）：解绑不改 upstream_keys 的列，但改的是网关快照里的
    // **归属** —— 那把 key 从"账号代表其余额"变回"自己就是一份钱"，出口也从账号的变回宿主的。
    // 快照只认 change_log，漏发不会报错，只会让网关那边这笔归属永远不更新。绑着一把 key ⇒ 多一条。
    expect(countOf(h, 'SELECT COUNT(*) AS n FROM change_log')).toBe(before + 1);
    expect(
      countOf(h, "SELECT COUNT(*) AS n FROM change_log WHERE entity = 'key' AND entity_id = ?", keyId),
    ).toBe(beforeKeyChanges + 1);

    const audit = h.db
      .prepare("SELECT target_id, detail FROM audit_log WHERE action = 'supplier.account.delete'")
      .get() as { target_id: string; detail: string } | undefined;
    expect(audit).toMatchObject({ target_id: acc, detail: 'force' });
  });

  it('只有掩码行（`pooled_key_id IS NULL`）→ 不算"名下有 key"，无需 force 直接删', async () => {
    const h = await setup();
    const up = createUpstream(h.db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const acc = seedAccount(h.db, up.id);
    bindKey(h.db, acc, null); // 只拿到掩码、进不了池（§15.1 maskedKeyCount 那一格）

    expect((await del(h, acc)).status).toBe(204);
    expect(countOf(h, 'SELECT COUNT(*) AS n FROM supplier_accounts')).toBe(0);
  });

  it('台账悬空（key 已被删上游物理删掉）→ **不拦**，不是拿幻觉拦人', async () => {
    const h = await setup();
    const up = createUpstream(h.db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const acc = seedAccount(h.db, up.id);
    const keyId = seedPooledKey(h.db, up.id);
    bindKey(h.db, acc, keyId);
    // 模拟 ADR-0016 的删上游：key 行被物理删掉，台账行留下（pooled_key_id 无外键）
    h.db.prepare('DELETE FROM upstream_keys WHERE id = ?').run(keyId);

    // 直接 COUNT 台账行会把这把**早已不存在**的 key 数进来，于是弹窗警告"将解绑 1 把 key"、
    // 而 force=true 也解绑不出任何东西 —— 账号被一个幻觉永久拦住。
    const { status } = await del(h, acc);
    expect(status).toBe(204);
    expect(countOf(h, 'SELECT COUNT(*) AS n FROM supplier_accounts')).toBe(0);
    expect(countOf(h, 'SELECT COUNT(*) AS n FROM supplier_account_keys')).toBe(0);
  });

  it('不存在的账号 → 404；删两次第二次也是 404（不静默当成功）', async () => {
    const h = await setup();
    const up = createUpstream(h.db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const acc = seedAccount(h.db, up.id);

    expect((await del(h, 'acc_missing')).body).toMatchObject({
      code: 'NOT_FOUND',
      details: { id: 'acc_missing' },
    });
    expect((await del(h, acc)).status).toBe(204);
    expect((await del(h, acc)).status).toBe(404);
  });

  it('删完之后 key 回到"自己就是一份钱"那一格（解绑而不是删除的全部意义）', async () => {
    const h = await setup();
    const up = createUpstream(h.db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const acc = seedAccount(h.db, up.id);
    const keyId = seedPooledKey(h.db, up.id, 5000);
    bindKey(h.db, acc, keyId);

    // 上游那一格的口径：`/api/stats/balance` 的 `global` 只有全局合计，
    // 拆解（keysBalance）在 `byUpstream[]` 上 —— 断言要按它真实的形状取。
    const upstreamOf = async (): Promise<{ keysBalance: number | null; totalBalance: number | null }> => {
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/stats/balance',
        headers: { cookie: h.cookie, 'x-requested-with': 'fetch' },
      });
      const body = res.json() as {
        global: {
          totalBalance: number | null;
          byUpstream: {
            upstreamId: string;
            keysBalance: number | null;
            totalBalance: number | null;
          }[];
        };
      };
      const row = body.global.byUpstream.find((u) => u.upstreamId === up.id);
      // 找不到就抛，而不是 `?? {…: null}` —— 后者会让"上游根本没出现在 byUpstream 里"
      // 这条真故障，伪装成下面那两个 `toBeNull()` 断言**通过**。
      if (!row) throw new Error('上游不在 byUpstream 里');
      return row;
    };

    // 归属期间：这把 key 的 5000 分由**账号**代表（账号余额未知 → key 那一半为 null，
    // 它不算"无账号归属的 key"）—— 这份钱只数一次的地方就在这里。
    expect((await upstreamOf()).keysBalance).toBeNull();
    expect((await upstreamOf()).totalBalance).toBeNull();

    await del(h, acc, '?force=true');

    // 解绑后它带着**已有的** balance 回到 keysBalance —— 钱没有消失，只是换了归属口径
    expect((await upstreamOf()).keysBalance).toBe(5000);
    expect((await upstreamOf()).totalBalance).toBe(5000);
  });
});

