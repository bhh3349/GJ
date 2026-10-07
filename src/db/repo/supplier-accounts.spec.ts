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
  findSupplierAccountByIdentifierHash,
  getSupplierAccount,
  listSupplierAccounts,
  requireSupplierAccount,
} from './supplier-accounts.js';
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
  opts: { unlimited?: boolean; label?: string } = {},
): string {
  const key = createKey(
    db,
    { upstreamId, key: 'sk-probe-' + 'B'.repeat(24), category: 'balance', label: opts.label },
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
