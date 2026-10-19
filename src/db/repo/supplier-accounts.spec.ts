// `supplier_accounts` 读面仓储（契约 §15.1 / §15.2 / ADR-0018）。
//
// 本文件钉住的都是**一旦破了不会报错、只会给出错数**的口径，所以每条断言都对着
// 一个具体的错法写：
//
//   1. **`credentialSource` 与 `hasSession` 正交** —— 前者答"会话过期后能不能自动重登"，
//      后者答"现在有没有会话"。用 `hasSession` 去推 `credentialSource` 一定推错
//      （有密码但当前无会话是合法过渡态，那恰恰是自动重登的触发条件）；
//   2. **两个凭据列全空的行进不来** —— `credentialSource` 由这两列**推导**，全空时它
//      无值可推，那种行在 DTO 里只能瞎猜一个，且它永远登不上。DDL 的 CHECK 兜住它；
//   3. **`autoRenew` 三态** —— `null`（上游没给这个字段）≠ `false`（上游明确说不续费）。
//      合成两态等于替供应商下结论；
//   4. **三个计数各有归属** —— `maskedKeyCount` **不得与 `keyCount` 相加**成"key 总数"；
//      `unlimitedKeyCount` 是 `keyCount` 的**子集**；已软删的池内 key 不进 `keyCount`；
//   5. **`subscriptions` 恒为数组** —— 没有套餐是 `[]`，不是 `null`、也不是缺键；
//   6. **无外键不是漏写**（ADR-0016）：删上游时不因为名下挂着账号而 500。
//      这条是**回归锁**，不是功能测试 —— 将来有人"顺手"给 `upstream_id` 补个
//      REFERENCES，这里会红。
//
// 凭据纪律另有一条**结构性**断言（第 3 组）：仓储从不 SELECT 那两个 BLOB。
// 它没法用行为断言，所以用"假密文照样读得出 DTO"来证 —— 那两列的内容对读面毫无影响。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../database.js';
import { newId } from '../ids.js';
import { createKey, deleteKey } from './keys.js';
import {
  backfillSubscriptionTokenPlan,
  findSupplierAccountByIdentifierHash,
  getSupplierAccount,
  listSupplierAccounts,
  replaceSupplierSubscriptions,
  requireSupplierAccount,
  setSupplierAccountEgress,
  upsertSupplierSubscription,
} from './supplier-accounts.js';
import { createEgressProxy, retireEgressProxy } from './egress.js';
import { createUpstream, deleteUpstream } from './upstreams.js';

const MASTER_KEY = Buffer.from('2a'.repeat(32), 'hex');

const dirs: string[] = [];
const open: Db[] = [];

afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close();
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

function setup(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'supplier-accounts-probe-'));
  dirs.push(dir);
  const db = openDatabase({ path: join(dir, 'gateway.db') });
  open.push(db);
  return db;
}

/** 本面还没有写路径（§15 的九个写端点等数据面协议收口），所以种数据一律走裸 SQL。 */
interface SeedAccount {
  id?: string;
  upstreamId: string;
  identifier?: string;
  identifierHash?: string;
  username?: string | null;
  uid?: string | null;
  hasPassword?: boolean;
  hasSession?: boolean;
  sessionExpiresAt?: string | null;
  status?: 'active' | 'login_failed' | 'session_expired' | 'unknown';
  statusMessage?: string | null;
  balanceCents?: number | null;
  balanceUpdatedAt?: string | null;
  createdAt?: string;
}

function seedAccount(db: Db, over: SeedAccount): string {
  const id = over.id ?? newId('supplierAccount');
  const at = over.createdAt ?? '2026-10-07T00:00:00.000Z';
  const identifier = over.identifier ?? '138****8000';
  // 密文用**假字节**：本仓储从不解密（也不 SELECT），所以它读得出 DTO 这件事本身就说明
  // 那两列的内容对读面没有影响 —— 这是"凭据面隔离"唯一能用行为证的那一半。
  const password = (over.hasPassword ?? true) ? Buffer.from('fake-ciphertext-password') : null;
  const session = (over.hasSession ?? false) ? Buffer.from('fake-ciphertext-session') : null;

  db.prepare(
    `INSERT INTO supplier_accounts (
       id, upstream_id, supplier, identifier, identifier_hash, username, uid,
       encrypted_password, encrypted_session, session_expires_at,
       status, status_message, balance_cents, balance_currency, balance_updated_at,
       egress_id, revision, created_at, updated_at
     ) VALUES (?, ?, 'tierflow', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
  ).run(
    id,
    over.upstreamId,
    identifier,
    over.identifierHash ?? `hash-${id}`,
    over.username ?? null,
    over.uid ?? null,
    password,
    session,
    over.sessionExpiresAt ?? null,
    over.status ?? 'unknown',
    over.statusMessage ?? null,
    over.balanceCents ?? null,
    over.balanceCents === null || over.balanceCents === undefined ? null : 'CNY',
    over.balanceUpdatedAt ?? null,
    at,
    at,
  );
  return id;
}

/** 子行 id 不进 DTO、也不进任何查询条件，所以用序号即可 —— 不必占用前缀表。 */
let rowSeq = 0;

function seedSubscription(
  db: Db,
  accountId: string,
  over: { subNo?: string; autoRenew?: number | null; planTitle?: string | null; updatedAt?: string } = {},
): void {
  db.prepare(
    `INSERT INTO supplier_account_subscriptions (
       id, account_id, sub_no, plan_title, plan_slug,
       amount_total_cents, amount_used_cents, paid_cents,
       basic_token_total, basic_token_used,
       status, source, start_at, end_at, auto_renew, has_key, key_masked, updated_at
     ) VALUES (?, ?, ?, ?, NULL, 2990, 1000, 2990, 1000000, 250000,
              'active', 'purchase', NULL, NULL, ?, 1, 'sk-****abcd', ?)`,
  ).run(
    `sub_seed_${++rowSeq}`,
    accountId,
    over.subNo ?? 'SB0001',
    over.planTitle ?? '基础套餐',
    over.autoRenew === undefined ? null : over.autoRenew,
    over.updatedAt ?? '2026-10-07T00:00:00.000Z',
  );
}

/** 池内 key：先按上游正规建，再按需要改 `unlimited`（写路径这块还没落）。 */
function seedPooledKey(
  db: Db,
  upstreamId: string,
  opts: { unlimited?: boolean; label?: string; balance?: number } = {},
): string {
  const key = createKey(
    db,
    { upstreamId, key: 'sk-probe-' + 'B'.repeat(24), category: 'balance', label: opts.label, balance: opts.balance },
    MASTER_KEY,
  );
  if (opts.unlimited === true) {
    // `unlimited = 1 ⇒ balance_cents 必须为 NULL`（§15.6 / ADR-0018 决策 8）：
    // 上游给的 remain_quota 是无意义负数，落库会变成"已欠费"。这条不变量属于写路径，
    // 这里的种数据也照它来 —— 否则测的是一个现实中不存在的行。
    db.prepare('UPDATE upstream_keys SET unlimited = 1, balance_cents = NULL WHERE id = ?').run(key.id);
  }
  return key.id;
}

function seedAccountKey(
  db: Db,
  accountId: string,
  over: { maskedKey?: string; pooledKeyId?: string | null; note?: string | null } = {},
): void {
  const at = '2026-10-07T00:00:00.000Z';
  db.prepare(
    `INSERT INTO supplier_account_keys (id, account_id, masked_key, pooled_key_id, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `sak_seed_${++rowSeq}`,
    accountId,
    over.maskedKey ?? 'sk-****0001',
    over.pooledKeyId ?? null,
    over.note ?? null,
    at,
    at,
  );
}

describe('凭据推导：credentialSource 与 hasSession 正交（§15.1）', () => {
  it('只有密码 → password / 无会话', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const id = seedAccount(db, { upstreamId: up.id, hasPassword: true, hasSession: false });

    const dto = requireSupplierAccount(db, id);
    expect(dto.credentialSource).toBe('password');
    expect(dto.hasSession).toBe(false);
    expect(dto.sessionExpiresAt).toBeNull();
  });

  it('只有会话 → session / 有会话（且 expiresAt 原样出来）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const id = seedAccount(db, {
      upstreamId: up.id,
      hasPassword: false,
      hasSession: true,
      sessionExpiresAt: '2026-11-01T00:00:00.000Z',
      status: 'active',
    });

    const dto = requireSupplierAccount(db, id);
    expect(dto.credentialSource).toBe('session');
    expect(dto.hasSession).toBe(true);
    expect(dto.sessionExpiresAt).toBe('2026-11-01T00:00:00.000Z');
  });

  it('两者都有 → password（密码是超集能力：有密码就一定能重登），且 hasSession 仍为 true', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const id = seedAccount(db, { upstreamId: up.id, hasPassword: true, hasSession: true });

    const dto = requireSupplierAccount(db, id);
    expect(dto.credentialSource).toBe('password');
    expect(dto.hasSession).toBe(true);
  });

  it('两列全空的行进不来（credentialSource 无值可推）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    expect(() =>
      seedAccount(db, { upstreamId: up.id, hasPassword: false, hasSession: false }),
    ).toThrow(/CHECK|constraint/i);
  });
});

describe('计数：三个数各有归属，不相加（§15.1 / §15.7）', () => {
  it('池内未软删计入 keyCount；其中 unlimited 是子集；只拿到掩码的另计', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const id = seedAccount(db, { upstreamId: up.id });

    const unlimitedKey = seedPooledKey(db, up.id, { unlimited: true });
    const normalKey = seedPooledKey(db, up.id);
    const revokedKey = seedPooledKey(db, up.id);
    deleteKey(db, revokedKey); // 软删：不进任何计数

    seedAccountKey(db, id, { pooledKeyId: unlimitedKey });
    seedAccountKey(db, id, { pooledKeyId: normalKey });
    seedAccountKey(db, id, { pooledKeyId: revokedKey });
    seedAccountKey(db, id, { pooledKeyId: null, maskedKey: 'sk-****9999' });

    const dto = requireSupplierAccount(db, id);
    expect(dto.keyCount).toBe(2); // 软删那把不算
    expect(dto.unlimitedKeyCount).toBe(1);
    expect(dto.unlimitedKeyCount).toBeLessThanOrEqual(dto.keyCount); // 子集，不相加
    expect(dto.maskedKeyCount).toBe(1);
  });

  it('没有 key 的账号三个计数都是 0', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const id = seedAccount(db, { upstreamId: up.id });
    const dto = requireSupplierAccount(db, id);
    expect([dto.keyCount, dto.unlimitedKeyCount, dto.maskedKeyCount]).toEqual([0, 0, 0]);
  });

  it('整页的计数一次算完，不互相串行（列表里两个账号各自独立）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const a = seedAccount(db, { upstreamId: up.id, identifier: 'acc-a', createdAt: '2026-10-07T00:00:02.000Z' });
    const b = seedAccount(db, { upstreamId: up.id, identifier: 'acc-b', createdAt: '2026-10-07T00:00:01.000Z' });
    seedAccountKey(db, a, { pooledKeyId: seedPooledKey(db, up.id) });
    seedAccountKey(db, a, { pooledKeyId: null, maskedKey: 'sk-****0002' });
    seedAccountKey(db, b, { pooledKeyId: null, maskedKey: 'sk-****0003' });

    const page = listSupplierAccounts(db, { page: 1, pageSize: 20 });
    const byId = new Map(page.items.map((it) => [it.id, it]));
    expect(byId.get(a)?.keyCount).toBe(1);
    expect(byId.get(a)?.maskedKeyCount).toBe(1);
    expect(byId.get(b)?.keyCount).toBe(0);
    expect(byId.get(b)?.maskedKeyCount).toBe(1);
  });
});

describe('套餐：恒为数组，autoRenew 三态（§15.1）', () => {
  it('没有套餐是 []，不是 null、也不是缺键', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const id = seedAccount(db, { upstreamId: up.id });
    const dto = requireSupplierAccount(db, id);
    expect(dto.subscriptions).toEqual([]);
    expect('subscriptions' in dto).toBe(true);
  });

  it('autoRenew：上游没给 → null；明确给了才转 bool', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const id = seedAccount(db, { upstreamId: up.id });
    seedSubscription(db, id, { subNo: 'SB-null', autoRenew: null });
    seedSubscription(db, id, { subNo: 'SB-on', autoRenew: 1 });
    seedSubscription(db, id, { subNo: 'SB-off', autoRenew: 0 });

    const dto = requireSupplierAccount(db, id);
    const byNo = new Map(dto.subscriptions.map((s) => [s.subNo, s]));
    expect(byNo.get('SB-null')?.autoRenew).toBeNull();
    expect(byNo.get('SB-on')?.autoRenew).toBe(true);
    expect(byNo.get('SB-off')?.autoRenew).toBe(false);
  });

  it('金额与 token 一律原样（分 / int），不做单位换算', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const id = seedAccount(db, { upstreamId: up.id });
    seedSubscription(db, id);
    const sub = requireSupplierAccount(db, id).subscriptions[0];
    expect(sub?.amountTotalCents).toBe(2990);
    expect(sub?.basicTokenTotal).toBe(1000000);
    expect(sub?.hasKey).toBe(true);
    expect(sub?.keyMasked).toBe('sk-****abcd');
  });

  it('列表与详情对同一账号给出**同序**的套餐（否则前端会以为数据变了）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const id = seedAccount(db, { upstreamId: up.id });
    seedSubscription(db, id, { subNo: 'SB-old', updatedAt: '2026-10-01T00:00:00.000Z' });
    seedSubscription(db, id, { subNo: 'SB-new', updatedAt: '2026-10-06T00:00:00.000Z' });

    const fromList = listSupplierAccounts(db, { page: 1, pageSize: 20 }).items[0]?.subscriptions;
    const fromDetail = requireSupplierAccount(db, id).subscriptions;
    expect(fromList?.map((s) => s.subNo)).toEqual(['SB-new', 'SB-old']);
    expect(fromDetail.map((s) => s.subNo)).toEqual(fromList?.map((s) => s.subNo));
  });
});

describe('筛选与分页（§15.2）', () => {
  function seedThree(db: Db): { upA: string; upB: string } {
    const upA = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' }).id;
    const upB = createUpstream(db, { name: 'up-b', baseUrl: 'https://b.example.com' }).id;
    seedAccount(db, {
      upstreamId: upA,
      identifier: '138****8001',
      username: 'alice',
      uid: 'u-1',
      status: 'active',
      createdAt: '2026-10-07T00:00:01.000Z',
    });
    seedAccount(db, {
      upstreamId: upA,
      identifier: '138****8002',
      username: 'bob',
      uid: 'u-2',
      status: 'login_failed',
      createdAt: '2026-10-07T00:00:02.000Z',
    });
    seedAccount(db, {
      upstreamId: upB,
      identifier: '139****8003',
      username: 'carol',
      uid: 'u-3',
      status: 'active',
      createdAt: '2026-10-07T00:00:03.000Z',
    });
    return { upA, upB };
  }

  it('按 upstreamId / status 过滤，total 是过滤后的总数', () => {
    const db = setup();
    const { upA, upB } = seedThree(db);

    expect(listSupplierAccounts(db, { page: 1, pageSize: 20 }).total).toBe(3);
    expect(listSupplierAccounts(db, { page: 1, pageSize: 20, upstreamId: upA }).total).toBe(2);
    expect(listSupplierAccounts(db, { page: 1, pageSize: 20, status: 'active' }).total).toBe(2);
    expect(listSupplierAccounts(db, { page: 1, pageSize: 20, upstreamId: upA, status: 'active' }).total).toBe(1);
    expect(listSupplierAccounts(db, { page: 1, pageSize: 20, upstreamId: upB }).items[0]?.username).toBe('carol');
  });

  it('排序固定 created_at DESC, id —— 翻页不会漏行也不会重复', () => {
    const db = setup();
    seedThree(db);

    const p1 = listSupplierAccounts(db, { page: 1, pageSize: 2 });
    const p2 = listSupplierAccounts(db, { page: 2, pageSize: 2 });
    expect(p1.items.map((i) => i.identifier)).toEqual(['139****8003', '138****8002']);
    expect(p2.items.map((i) => i.identifier)).toEqual(['138****8001']);
    expect(new Set([...p1.items, ...p2.items].map((i) => i.id)).size).toBe(3);
    expect(p1.total).toBe(3);
  });

  it('q 走 LIKE 且转义通配符：搜下划线不会匹配到任意单字符', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    seedAccount(db, { upstreamId: up.id, identifier: 'a_b', identifierHash: 'h1', createdAt: '2026-10-07T00:00:01.000Z' });
    seedAccount(db, { upstreamId: up.id, identifier: 'axb', identifierHash: 'h2', createdAt: '2026-10-07T00:00:02.000Z' });
    seedAccount(db, { upstreamId: up.id, identifier: 'a%b', identifierHash: 'h3', createdAt: '2026-10-07T00:00:03.000Z' });

    const underscore = listSupplierAccounts(db, { page: 1, pageSize: 20, q: 'a_b' });
    expect(underscore.items.map((i) => i.identifier)).toEqual(['a_b']);
    const percent = listSupplierAccounts(db, { page: 1, pageSize: 20, q: 'a%b' });
    expect(percent.items.map((i) => i.identifier)).toEqual(['a%b']);
  });

  it('q 也能搜 username / uid', () => {
    const db = setup();
    const { upA } = seedThree(db);
    expect(listSupplierAccounts(db, { page: 1, pageSize: 20, q: 'u-3' }).total).toBe(1);
    expect(listSupplierAccounts(db, { page: 1, pageSize: 20, q: 'ali' }).items[0]?.upstreamId).toBe(upA);
  });

  it('不存在的 id → NOT_FOUND（null 与"不存在"的二义性不留给调用方）', () => {
    const db = setup();
    expect(getSupplierAccount(db, 'acc_missing')).toBeNull();
    try {
      requireSupplierAccount(db, 'acc_missing');
      expect.unreachable('应当抛 NOT_FOUND');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('NOT_FOUND');
    }
  });
});

describe('无外键是决策，不是漏写（ADR-0016 / ADR-0018）', () => {
  it('删上游时名下挂着账号也不 500 —— 账号既不在 §2 守卫里，也不在删除里', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const id = seedAccount(db, { upstreamId: up.id });
    seedSubscription(db, id);
    seedAccountKey(db, id, { pooledKeyId: null });

    // 上游名下没有 key、没有模型 → 守卫放行。若 `upstream_id` 上被补了外键，这里会抛约束错。
    expect(() => deleteUpstream(db, up.id, false)).not.toThrow();

    // 账号行**仍然在**：契约缺口未定之前，不发明"静默级联删凭据"这种行为。
    // 这条断言是刻意写成"仍在"而不是"被删"的 —— 一旦有人改了主意，两处必须同时改。
    expect(getSupplierAccount(db, id)).not.toBeNull();
  });
});

describe('判重摘要（§15.9）', () => {
  it('同一上游内按 identifier_hash 命中；跨上游不命中', () => {
    const db = setup();
    const upA = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' }).id;
    const upB = createUpstream(db, { name: 'up-b', baseUrl: 'https://b.example.com' }).id;
    const id = seedAccount(db, { upstreamId: upA, identifierHash: 'sha-of-truth' });

    expect(findSupplierAccountByIdentifierHash(db, upA, 'sha-of-truth')?.id).toBe(id);
    expect(findSupplierAccountByIdentifierHash(db, upB, 'sha-of-truth')).toBeNull();
    expect(findSupplierAccountByIdentifierHash(db, upA, 'other')).toBeNull();
  });

  it('同一上游内不允许两行同摘要（两路凭据汇入同一行）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    seedAccount(db, { upstreamId: up.id, identifierHash: 'same' });
    expect(() => seedAccount(db, { upstreamId: up.id, identifierHash: 'same' })).toThrow(/UNIQUE|constraint/i);
  });
});


describe('账号绑出口（§16.7 Tier 2 写路径，v1.13.0 / ADR-0029）', () => {
  const AT = '2026-10-14T00:00:00.000Z';

  /** 建一个 active 出口。走仓储正门（`normalizeEgressUrl` 在里面）。 */
  function seedEgress(db: Db, name: string, url: string): string {
    return createEgressProxy(db, { name, url }, MASTER_KEY).id;
  }

  const changeCount = (db: Db, keyId: string): number =>
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'key' AND entity_id = ?")
        .get(keyId) as { n: number }
    ).n;

  it('绑定 active 出口：DTO 变、revision +1、**每把已入池 key 各收到一条 change_log**', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const acc = seedAccount(db, { upstreamId: up.id });
    const egressId = seedEgress(db, 'hk-1', 'https://proxy.example:8443');
    const k1 = seedPooledKey(db, up.id);
    const k2 = seedPooledKey(db, up.id);
    seedAccountKey(db, acc, { pooledKeyId: k1 });
    seedAccountKey(db, acc, { pooledKeyId: k2 });
    // 种数据本身就会发 change_log（建 key 时各一条），故判据一律用**差值**。
    const before = { k1: changeCount(db, k1), k2: changeCount(db, k2) };

    const dto = setSupplierAccountEgress(db, acc, egressId, 1);
    expect(dto.egressId).toBe(egressId);
    expect(dto.revision).toBe(2);

    // 池的**状态**不进 DTO（那仍只有 §7 帧）—— 这里只答"这个账号绑了谁"
    expect(JSON.stringify(dto)).not.toContain('proxy.example');

    // 广播是必需项：`supplier_accounts` 不在 `SNAPSHOT_ENTITIES` 里，漏发不会报错，
    // 只会让这些 key 的出口永远停在旧值（出口预算按 id 分桶 ⇒ 一根出口两个桶 ⇒ 放行量翻倍）。
    expect(changeCount(db, k1)).toBe(before.k1 + 1);
    expect(changeCount(db, k2)).toBe(before.k2 + 1);
  });

  it('解绑（null）合法：回宿主出口，且**照发广播**（归属也是变了）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const acc = seedAccount(db, { upstreamId: up.id });
    const egressId = seedEgress(db, 'hk-1', 'https://proxy.example:8443');
    const k1 = seedPooledKey(db, up.id);
    seedAccountKey(db, acc, { pooledKeyId: k1 });

    setSupplierAccountEgress(db, acc, egressId, 1);
    const afterBind = changeCount(db, k1);

    const dto = setSupplierAccountEgress(db, acc, null, 2);
    expect(dto.egressId).toBeNull();
    expect(dto.revision).toBe(3);
    expect(changeCount(db, k1)).toBe(afterBind + 1);
  });

  it('出口不存在 / 已退役 ⇒ 400 INVALID_PARAM(field=egressId)，**零副作用**', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const acc = seedAccount(db, { upstreamId: up.id });
    const retired = seedEgress(db, 'hk-old', 'https://old.example:8443');
    retireEgressProxy(db, retired, 'manual', AT);
    const before = (
      db.prepare("SELECT COUNT(*) AS n FROM change_log").get() as { n: number }
    ).n;

    for (const bad of ['eg_missing', retired]) {
      try {
        setSupplierAccountEgress(db, acc, bad, 1);
        expect.unreachable('应当抛 INVALID_PARAM');
      } catch (err) {
        const e = err as { code?: string; details?: { field?: string } };
        expect(e.code, bad).toBe('INVALID_PARAM');
        expect(e.details?.field, bad).toBe('egressId');
      }
    }
    // 不留"绑上去了但永远发不出去"的账号：拦下时这一行一个字节没动
    expect(getSupplierAccount(db, acc)?.egressId).toBeNull();
    expect(getSupplierAccount(db, acc)?.revision).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM change_log').get() as { n: number }).n).toBe(before);
  });

  it('revision 不符 ⇒ 409 REVISION_MISMATCH（带 expected / actual），零副作用', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const acc = seedAccount(db, { upstreamId: up.id });
    const egressId = seedEgress(db, 'hk-1', 'https://proxy.example:8443');

    try {
      setSupplierAccountEgress(db, acc, egressId, 7);
      expect.unreachable('应当抛 REVISION_MISMATCH');
    } catch (err) {
      const e = err as { code?: string; details?: { expected?: number; actual?: number } };
      expect(e.code).toBe('REVISION_MISMATCH');
      expect(e.details).toEqual({ expected: 7, actual: 1 });
    }
    expect(getSupplierAccount(db, acc)?.egressId).toBeNull();
  });

  it('值未变 = **空操作**：不推 revision、不发广播（连点两次不该白推一次快照重建）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const acc = seedAccount(db, { upstreamId: up.id });
    const egressId = seedEgress(db, 'hk-1', 'https://proxy.example:8443');
    const k1 = seedPooledKey(db, up.id);
    seedAccountKey(db, acc, { pooledKeyId: k1 });

    const first = setSupplierAccountEgress(db, acc, egressId, 1);
    const mark = changeCount(db, k1);
    const again = setSupplierAccountEgress(db, acc, egressId, first.revision);

    expect(again.revision).toBe(first.revision);
    expect(changeCount(db, k1)).toBe(mark);
    // 解绑到同一个 null（本来就 null）同样短路
    const other = seedAccount(db, { upstreamId: up.id, identifierHash: 'hash-other' });
    expect(setSupplierAccountEgress(db, other, null, 1).revision).toBe(1);
  });

  it('名下一把池内 key 都没有 → 写入照常成功、**不发任何广播**（没有受影响的行）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const acc = seedAccount(db, { upstreamId: up.id });
    const egressId = seedEgress(db, 'hk-1', 'https://proxy.example:8443');
    // 只有掩码的行不算池内 key（§15.1 `keyCount` 同口径）
    seedAccountKey(db, acc, { pooledKeyId: null });
    const before = (db.prepare('SELECT COUNT(*) AS n FROM change_log').get() as { n: number }).n;

    const dto = setSupplierAccountEgress(db, acc, egressId, 1);
    expect(dto.egressId).toBe(egressId);
    expect((db.prepare('SELECT COUNT(*) AS n FROM change_log').get() as { n: number }).n).toBe(before);
  });

  it('账号不存在 ⇒ NOT_FOUND（先于活性校验与乐观锁）', () => {
    const db = setup();
    try {
      setSupplierAccountEgress(db, 'acc_missing', null, 1);
      expect.unreachable('应当抛 NOT_FOUND');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('NOT_FOUND');
    }
  });
});

/**
 * 套餐余量回填（ADR-0022 承诺的"后续"腿 / 本次新增）。
 *
 * 本组钉的是**上游字段名与单位的翻译**，错一格不会报错、只会给出错数：
 *   · `basic_token_*` 是 **Token 个数**，除一次 500000 就从 800 万变成 16 分；
 *   · 上游没给 `basic_token_used` 时它是"用了 0"还是"不知道"？
 *     这里取前者（余量 = total），因为**总额给了而单项没给**在套餐语义里只能是没用过；
 *   · 余量只会递减，所以不能用 `COALESCE` 那套"只填空"的写法。
 */
describe('套餐余量回填 token_plan_remaining（ADR-0022 的"后续"腿）', () => {
  const END_AT = '2026-11-16T00:00:00.000Z';

  /**
   * 一把已入池的套餐 key（`token-plan`，池内无余额列 —— 见 keys.ts 的落库规则）。
   *
   * 返回**库内真实的 `masked_key`**，让每个用例都拿它去建台账行、当上游掩码。
   * 手写掩码是这条用例组里最肥的坑：`createKey({ key: 'sk-probe-a1b2' })` 落库的是
   * `****a1b2`（后 4 位，无 `sk-` 前缀），手写成 `sk-****a1b2` 就对不上 ——
   * 而"对不上"在这条路径上的表现是"什么都没写"，看起来像实现错了。
   */
  function seedTokenPlanKey(db: Db, upstreamId: string, tail: string): { keyId: string; masked: string } {
    const key = createKey(db, { upstreamId, key: `sk-probe-${tail}`, category: 'token-plan' }, MASTER_KEY);
    const masked = (db.prepare('SELECT masked_key AS m FROM upstream_keys WHERE id = ?').get(key.id) as { m: string }).m;
    return { keyId: key.id, masked };
  }

  /** 台账行：这把池内 key 属于这个账号（回填按 `masked_key` 定位它）。 */
  function seedLedgerRow(db: Db, accountId: string, pooledKeyId: string, maskedKey: string): void {
    const at = '2026-10-07T00:00:00.000Z';
    db.prepare(
      `INSERT INTO supplier_account_keys (id, account_id, masked_key, pooled_key_id, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(`sak_seed_${++rowSeq}`, accountId, maskedKey, pooledKeyId, null, at, at);
  }

  function tokenPlanOf(db: Db, keyId: string): { remaining: number | null; expiresAt: string | null } {
    const row = db
      .prepare('SELECT token_plan_remaining AS r, token_plan_expires_at AS e FROM upstream_keys WHERE id = ?')
      .get(keyId) as { r: number | null; e: string | null };
    return { remaining: row.r, expiresAt: row.e };
  }

  const balanceChangeCount = (db: Db, keyId: string): number =>
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'balance' AND entity_id = ?")
        .get(keyId) as { n: number }
    ).n;

  it('余量 = basic_token_total - basic_token_used，单位是 **Token 个数**（不是钱）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-tf', baseUrl: 'https://tf.example.com' });
    const acc = seedAccount(db, { upstreamId: up.id });
    const { keyId, masked } = seedTokenPlanKey(db, up.id, 'a1b2');
    seedLedgerRow(db, acc, keyId, masked);

    backfillSubscriptionTokenPlan(db, acc, [
      { subNo: 'SB1', basicTokenTotal: 8_000_000, basicTokenUsed: 2_666_169, endAt: END_AT, keyMasked: masked },
    ]);

    // 800 万 - 266 万 = 533 万 Token。若误走 quotaToCents（÷500000）会得到 10 ——
    // 那条错值在网关侧等于"这把 key 只剩 10 个 token"，一次请求就把它踢出选路。
    expect(tokenPlanOf(db, keyId)).toEqual({ remaining: 5_333_831, expiresAt: END_AT });
  });

  it('basic_token_used 缺失 ⇒ 整行跳过：不是"按 0 算"，NULL 保持未知', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-tf', baseUrl: 'https://tf.example.com' });
    const acc = seedAccount(db, { upstreamId: up.id });
    const { keyId, masked } = seedTokenPlanKey(db, up.id, 'c3d4');
    seedLedgerRow(db, acc, keyId, masked);
    const before = balanceChangeCount(db, keyId);

    // 只给了总额，没说用了多少。早先这里按 `?? 0` 算成"没用过"，
    // 于是写进去一个**全额**（800 万）—— 一个"上游没说"的值变成了"我们查过了"。
    backfillSubscriptionTokenPlan(db, acc, [{ subNo: 'SB1', basicTokenTotal: 8_000_000, endAt: END_AT, keyMasked: masked }]);

    expect(tokenPlanOf(db, keyId)).toEqual({ remaining: null, expiresAt: null });
    // 什么都没写 ⇒ 广播也不发（同"总额未知"那条：一次空转不该叫醒网关清零乐观扣减）。
    expect(balanceChangeCount(db, keyId)).toBe(before);
  });

  it('总额未知 ⇒ 一个字都不写：NULL 是"未知"，写 0 会让 key 被静默排除出选路', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-tf', baseUrl: 'https://tf.example.com' });
    const acc = seedAccount(db, { upstreamId: up.id });
    const { keyId, masked } = seedTokenPlanKey(db, up.id, 'e5f6');
    seedLedgerRow(db, acc, keyId, masked);
    const before = balanceChangeCount(db, keyId);

    backfillSubscriptionTokenPlan(db, acc, [
      { subNo: 'SB1', basicTokenTotal: null, basicTokenUsed: null, endAt: END_AT, keyMasked: masked },
    ]);

    expect(tokenPlanOf(db, keyId)).toEqual({ remaining: null, expiresAt: null });
    // 什么都没改 ⇒ 不发广播。`applySnapshot` 会把 token-plan 的乐观扣减清零，
    // 一次空转换来的是一次无意义的重置。
    expect(balanceChangeCount(db, keyId)).toBe(before);
  });

  it('余量可以递减：第二次同步写更小的数必须真的写进去（COALESCE 会静默失效）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-tf', baseUrl: 'https://tf.example.com' });
    const acc = seedAccount(db, { upstreamId: up.id });
    const { keyId, masked } = seedTokenPlanKey(db, up.id, 'a1b2');
    seedLedgerRow(db, acc, keyId, masked);

    backfillSubscriptionTokenPlan(db, acc, [
      { subNo: 'SB1', basicTokenTotal: 8_000_000, basicTokenUsed: 0, endAt: END_AT, keyMasked: masked },
    ]);
    expect(tokenPlanOf(db, keyId).remaining).toBe(8_000_000);

    // 用掉 500 万之后
    backfillSubscriptionTokenPlan(db, acc, [
      { subNo: 'SB1', basicTokenTotal: 8_000_000, basicTokenUsed: 5_000_000, endAt: END_AT, keyMasked: masked },
    ]);
    expect(tokenPlanOf(db, keyId).remaining).toBe(3_000_000);
  });

  it('每把命中的 key 各收到一条 change_log 广播（快照只认 SNAPSHOT_ENTITIES 里的实体）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-tf', baseUrl: 'https://tf.example.com' });
    const acc = seedAccount(db, { upstreamId: up.id });
    const a = seedTokenPlanKey(db, up.id, 'a1b2');
    const b = seedTokenPlanKey(db, up.id, 'c3d4');
    seedLedgerRow(db, acc, a.keyId, a.masked);
    seedLedgerRow(db, acc, b.keyId, b.masked);
    const before = { a: balanceChangeCount(db, a.keyId), b: balanceChangeCount(db, b.keyId) };

    backfillSubscriptionTokenPlan(db, acc, [
      { subNo: 'SB1', basicTokenTotal: 8_000_000, basicTokenUsed: 100, endAt: END_AT, keyMasked: a.masked },
      { subNo: 'SB2', basicTokenTotal: 8_000_000, basicTokenUsed: 200, endAt: END_AT, keyMasked: b.masked },
    ]);

    expect(balanceChangeCount(db, a.keyId)).toBe(before.a + 1);
    expect(balanceChangeCount(db, b.keyId)).toBe(before.b + 1);
  });

  it('掩码撞号 / 找不到 ⇒ 那一行不动（宁可留 NULL，也不把 A 套餐的余量写到 B 的 key 上）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-tf', baseUrl: 'https://tf.example.com' });
    const acc = seedAccount(db, { upstreamId: up.id });
    // 撞号 = **两把池内 key 的 masked_key 相同**（同尾部明文被 rotate 了两次）。
    // 注意掩码取自 key 行（`listLinkedPooledKeyMasks` 是 JOIN `upstream_keys` 取的），
    // 台账行里写什么掩码不影响判定 —— 这也是为什么下面两行用同一个 tail。
    const a = seedTokenPlanKey(db, up.id, 'a1b2');
    const b = seedTokenPlanKey(db, up.id, 'a1b2');
    expect(b.masked).toBe(a.masked);
    seedLedgerRow(db, acc, a.keyId, a.masked);
    seedLedgerRow(db, acc, b.keyId, b.masked);
    const before = balanceChangeCount(db, a.keyId);

    backfillSubscriptionTokenPlan(db, acc, [
      { subNo: 'SB1', basicTokenTotal: 8_000_000, basicTokenUsed: 100, endAt: END_AT, keyMasked: a.masked },
      // 这把不在台账里（没 rotate 过 / 换了掩码）
      { subNo: 'SB2', basicTokenTotal: 8_000_000, basicTokenUsed: 200, endAt: END_AT, keyMasked: '****zzzz' },
    ]);

    expect(tokenPlanOf(db, a.keyId).remaining).toBeNull();
    expect(tokenPlanOf(db, b.keyId).remaining).toBeNull();
    expect(balanceChangeCount(db, a.keyId)).toBe(before);
  });

  it('余额类 key 不被回填：套餐余量落到余额 key 上会让两套计费池混在一起', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-tf', baseUrl: 'https://tf.example.com' });
    const acc = seedAccount(db, { upstreamId: up.id });
    const keyId = seedPooledKey(db, up.id, { balance: 1000 });
    // 台账里的掩码与套餐行对得上，但 key 本身是 balance 类
    const masked = (db.prepare('SELECT masked_key AS m FROM upstream_keys WHERE id = ?').get(keyId) as { m: string }).m;
    seedLedgerRow(db, acc, keyId, masked);

    backfillSubscriptionTokenPlan(db, acc, [
      { subNo: 'SB1', basicTokenTotal: 8_000_000, basicTokenUsed: 100, endAt: END_AT, keyMasked: masked },
    ]);

    expect(tokenPlanOf(db, keyId).remaining).toBeNull();
    // 余额 key 的钱一分没动（也没被写成 7999900 这种 token 数）
    const row = db.prepare('SELECT balance_cents AS b FROM upstream_keys WHERE id = ?').get(keyId) as { b: number };
    expect(row.b).toBe(1000);
  });

  it('used > total 的瞬态夹到 0：库里不留负数（网关侧同样会归一成 0 = 不可用）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-tf', baseUrl: 'https://tf.example.com' });
    const acc = seedAccount(db, { upstreamId: up.id });
    const { keyId, masked } = seedTokenPlanKey(db, up.id, 'a1b2');
    seedLedgerRow(db, acc, keyId, masked);

    backfillSubscriptionTokenPlan(db, acc, [
      { subNo: 'SB1', basicTokenTotal: 8_000_000, basicTokenUsed: 8_000_500, endAt: END_AT, keyMasked: masked },
    ]);

    expect(tokenPlanOf(db, keyId).remaining).toBe(0);
  });

  it('账号名下没有池内 key / 没有套餐 ⇒ 直接返回，零写入零广播', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-tf', baseUrl: 'https://tf.example.com' });
    const acc = seedAccount(db, { upstreamId: up.id });
    const before = (db.prepare('SELECT COUNT(*) AS n FROM change_log').get() as { n: number }).n;

    backfillSubscriptionTokenPlan(db, acc, []);
    backfillSubscriptionTokenPlan(db, acc, [
      { subNo: 'SB1', basicTokenTotal: 8_000_000, basicTokenUsed: 1, endAt: END_AT, keyMasked: 'sk-****a1b2' },
    ]);

    expect((db.prepare('SELECT COUNT(*) AS n FROM change_log').get() as { n: number }).n).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// upsertSupplierSubscription 的写窄（审计项 C）
// ---------------------------------------------------------------------------

describe('upsertSupplierSubscription：只写 has_key / key_masked 两格（审计项 C）', () => {
  /**
   * 直读库内那一行的**全部业务列**。
   *
   * 为什么必须读库而不是读 DTO：DTO 的 `subscriptions[]` 是读面投影，
   * 而这里要证的是"写侧没有把上一轮的列抹掉" —— 那正是投影看不出来的那类破坏
   * （抹成 NULL 后前端显示"上游没给"，与真没给长得一样）。
   */
  function rowOf(db: Db, accountId: string, subNo: string): Record<string, unknown> {
    return db
      .prepare(
        `SELECT plan_title, plan_slug, amount_total_cents, amount_used_cents, paid_cents,
                basic_token_total, basic_token_used, status, source, start_at, end_at,
                auto_renew, has_key, key_masked
           FROM supplier_account_subscriptions WHERE account_id = ? AND sub_no = ?`,
      )
      .get(accountId, subNo) as Record<string, unknown>;
  }

  /** 上一轮 refresh 写进去的完整套餐行（金额 / 到期 / 三态 auto_renew 全都有值）。 */
  function seedFullRow(db: Db, accountId: string, subNo: string): void {
    replaceSupplierSubscriptions(db, accountId, [
      {
        subNo,
        planTitle: '轻享版',
        planSlug: 'light',
        amountTotalCents: 9900,
        amountUsedCents: 1200,
        paidCents: 9900,
        basicTokenTotal: 8_000_000,
        basicTokenUsed: 2_666_169,
        status: 'active',
        source: 'buy',
        startAt: '2026-10-01T00:00:00.000Z',
        endAt: '2026-11-16T00:00:00.000Z',
        autoRenew: true,
        hasKey: true,
        keyMasked: 'sk-****iHLd',
      },
    ]);
  }

  it('side-check 失败（手里没有套餐字段）⇒ 只更新 key 两格，其余列原样不动', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-tf', baseUrl: 'https://tf.example.com' });
    const acc = seedAccount(db, { upstreamId: up.id });
    seedFullRow(db, acc, 'SB1');
    const before = rowOf(db, acc, 'SB1');

    // `rotateOne` ④ 的真实形状：重置成功、顺带的 /api/subscription/self 失败 ⇒ `plan = null`，
    // 于是除了 subNo / hasKey / keyMasked 三格，其余字段一个值都没有。
    upsertSupplierSubscription(db, acc, {
      subNo: 'SB1',
      planTitle: null,
      planSlug: null,
      amountTotalCents: null,
      amountUsedCents: null,
      paidCents: null,
      basicTokenTotal: null,
      basicTokenUsed: null,
      status: null,
      source: null,
      startAt: null,
      endAt: null,
      autoRenew: null,
      hasKey: true,
      keyMasked: 'sk-****5w2l',
    });

    const after = rowOf(db, acc, 'SB1');
    // 两格**确实换了**（否则这条用例会因为"什么都没做"而恒绿）
    expect(after.key_masked).toBe('sk-****5w2l');
    expect(after.has_key).toBe(1);
    // 其余十一格**逐列原样**。早先这里是一条 `ON CONFLICT DO UPDATE SET <全部列>`，
    // 于是上一轮写实的金额 / 到期 / auto_renew 全被抹成 NULL —— 症状是
    // "重置了一次 key，套餐的金额与到期日凭空消失"，而前端看不出它是丢了。
    for (const col of [
      'plan_title',
      'plan_slug',
      'amount_total_cents',
      'amount_used_cents',
      'paid_cents',
      'basic_token_total',
      'basic_token_used',
      'status',
      'source',
      'start_at',
      'end_at',
      'auto_renew',
    ]) {
      expect(after[col], `列 ${col} 不该被这次 upsert 抹掉`).toBe(before[col]);
    }
  });

  it('行不存在 ⇒ 全量插入（新行没有旧值可保护，两个字段都要收下）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-tf', baseUrl: 'https://tf.example.com' });
    const acc = seedAccount(db, { upstreamId: up.id });

    upsertSupplierSubscription(db, acc, {
      subNo: 'SB9',
      planTitle: '新套餐',
      amountTotalCents: 1990,
      basicTokenTotal: 8_000_000,
      endAt: '2026-12-01T00:00:00.000Z',
      autoRenew: false,
      hasKey: true,
      keyMasked: 'sk-****zz99',
    });

    // INSERT 分支仍然是全量：把它写窄会让"上游第一次给套餐时"丢掉字段，
    // 而那一条路上根本没有旧行可以回退。
    expect(rowOf(db, acc, 'SB9')).toEqual({
      plan_title: '新套餐',
      plan_slug: null,
      amount_total_cents: 1990,
      amount_used_cents: null,
      paid_cents: null,
      basic_token_total: 8_000_000,
      basic_token_used: null,
      status: null,
      source: null,
      start_at: null,
      end_at: '2026-12-01T00:00:00.000Z',
      auto_renew: 0,
      has_key: 1,
      key_masked: 'sk-****zz99',
    });
  });

  it('连续两次 upsert 幂等：第二遍同样的入参不产生第二行，也不改业务列', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-tf', baseUrl: 'https://tf.example.com' });
    const acc = seedAccount(db, { upstreamId: up.id });
    seedFullRow(db, acc, 'SB1');

    const body = {
      subNo: 'SB1',
      planTitle: null,
      planSlug: null,
      amountTotalCents: null,
      amountUsedCents: null,
      paidCents: null,
      basicTokenTotal: null,
      basicTokenUsed: null,
      status: null,
      source: null,
      startAt: null,
      endAt: null,
      autoRenew: null,
      hasKey: true,
      keyMasked: 'sk-****5w2l',
    };
    upsertSupplierSubscription(db, acc, body);
    const once = rowOf(db, acc, 'SB1');
    upsertSupplierSubscription(db, acc, body);

    expect(rowOf(db, acc, 'SB1')).toEqual(once);
    expect((db.prepare('SELECT COUNT(*) AS n FROM supplier_account_subscriptions WHERE account_id = ?').get(acc) as { n: number }).n).toBe(1);
  });

  it('hasKey 缺省 ⇒ has_key 落 0，而不是把上一轮的 1 留着', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'up-tf', baseUrl: 'https://tf.example.com' });
    const acc = seedAccount(db, { upstreamId: up.id });
    seedFullRow(db, acc, 'SB1');

    upsertSupplierSubscription(db, acc, { subNo: 'SB1', keyMasked: null });

    expect(rowOf(db, acc, 'SB1').has_key).toBe(0);
    // 业务列照旧不动
    expect(rowOf(db, acc, 'SB1').amount_total_cents).toBe(9900);
  });
});
