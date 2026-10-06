// 余额聚合三/四口径（契约 §6 + §15.6 / ADR-0003 / ADR-0018 决策 3、8）。
//
// 这个文件守的是一组**一旦破了就静默出错**的规则 —— 它们不会抛异常，只会让界面上的
// 数字看起来还挺正常：
//   1. **同一份钱只数一次**：归属给账号的 key 不进 keysBalance（否则"一号多 key"数 N 遍）；
//   2. **未知 ≠ 0**：全未知时 totalBalance 是 `null`，不是 0（ADR-0003）；
//   3. **无限 ≠ 未知**：`unlimited = 1` 的 key 不进 balanceUnknownKeyCount（决策 8），
//      单独进 unlimitedKeyCount；
//   4. **通用上游零影响**：没有账号、没有台账行时，每一项都与加 §15 之前逐字相同；
//   5. **全局 = 各上游之和**（在 JS 里加总，不是另一条 SQL）。
//
// 记账方式（归属走 `supplier_account_keys.pooled_key_id` 台账，而不是 `upstream_keys` 上的
// 一列）见 `balance.ts` 的 UNOWNED_KEY 注释。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './database.js';
import { newId } from './ids.js';
import { createKey } from './repo/keys.js';
import { createUpstream } from './repo/upstreams.js';
import { computeGlobalBalance, computeUpstreamBalance } from './balance.js';

const dirs: string[] = [];
const open: Db[] = [];
const MASTER_KEY = Buffer.from('11'.repeat(32), 'hex');

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
      /* 临时目录删不掉不影响判据 */
    }
  }
});

function setup(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'balance-probe-'));
  dirs.push(dir);
  const db = openDatabase({ path: join(dir, 'gateway.db') });
  open.push(db);
  return db;
}

/** 桩 key 一律**运行时拼**：`sk-` 后接 ≥20 位字面量会被自己的 `check:secrets` 抓成疑似真 key。 */
let keySeq = 0;
function seedKey(db: Db, upstreamId: string, balance: number | null, unlimited = false): string {
  const dto = createKey(
    db,
    {
      upstreamId,
      key: 'sk-probe-' + String(++keySeq).padStart(3, '0') + 'X'.repeat(20),
      category: 'balance',
      ...(unlimited ? { unlimited: true, balance: -331119 } : { balance }),
    },
    MASTER_KEY,
  );
  return dto.id;
}

function seedAccount(db: Db, upstreamId: string, balanceCents: number | null): string {
  const id = newId('supplierAccount');
  const at = '2026-10-07T00:00:00.000Z';
  db.prepare(
    `INSERT INTO supplier_accounts (
       id, upstream_id, supplier, identifier, identifier_hash, username, uid,
       encrypted_password, encrypted_session, session_expires_at,
       status, status_message, balance_cents, balance_currency, balance_updated_at,
       egress_id, revision, created_at, updated_at
     ) VALUES (?, ?, 'tierflow', '138****8000', ?, NULL, 'u1', ?, NULL, NULL,
              'active', NULL, ?, ?, ?, NULL, 1, ?, ?)`,
  ).run(
    id,
    upstreamId,
    `hash-${id}`,
    Buffer.from('fake-ciphertext'),
    balanceCents,
    balanceCents === null ? null : 'CNY',
    balanceCents === null ? null : at,
    at,
    at,
  );
  return id;
}

/** 归属台账的一行：`pooled_key_id` 非空 = 这把池内 key 属于该账号。 */
function bindKey(db: Db, accountId: string, pooledKeyId: string): void {
  const at = '2026-10-07T00:00:00.000Z';
  db.prepare(
    `INSERT INTO supplier_account_keys (id, account_id, masked_key, pooled_key_id, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
  ).run(newId('supplierAccountKey'), accountId, '****abcd', pooledKeyId, at, at);
}

describe('口径 1/4：通用上游零影响（加 §15 之前的每一项都逐字不变）', () => {
  it('没有账号、没有台账行时 keys[] 与合计与加账号面之前一致', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'generic', baseUrl: 'https://generic.example.com' });
    const known = seedKey(db, up.id, 1280);
    const unknown = seedKey(db, up.id, null);

    const u = computeUpstreamBalance(db, up.id);
    expect(u?.totalBalance).toBe(1280);
    expect(u?.keysBalance).toBe(1280);
    expect(u?.balanceKeyCount).toBe(2);
    expect(u?.balanceUnknownKeyCount).toBe(1);
    expect(u?.unlimitedKeyCount).toBe(0);
    // **未知的那把也在 keys[] 里**：这张列表是余额页的数据源，"余额未知"必须能被人看见
    // （§6 规则 3 要求前端单独呈现它）。把它从列表里删掉，未知就从"可见的空白"变成"不存在"。
    expect(u?.keys.map((k) => k.keyId)).toEqual([known, unknown]);
    expect(u?.keys.map((k) => k.balance)).toEqual([1280, null]);
    expect(u?.keys[0]?.unlimited).toBe(false);
    expect(u?.accountCount).toBe(0);
    expect(u?.accountsBalance).toBeNull();
    // 左连接会为"没有账号"造出一行**幽灵行**，若未知计数写成 `COUNT(a.balance_cents IS NULL)`
    // 它就会被数成"1 个余额未知的账号"—— 通用上游的仪表盘从此挂一条假告警。
    expect(u?.accountsBalanceUnknownCount).toBe(0);
  });

  it('全部未知时 totalBalance 是 null 而不是 0（未知 ≠ 0）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'all-unknown', baseUrl: 'https://u.example.com' });
    seedKey(db, up.id, null);

    const u = computeUpstreamBalance(db, up.id);
    expect(u?.totalBalance).toBeNull();
    expect(u?.keysBalance).toBeNull();
    expect(u?.totalBalance).not.toBe(0);
  });
});

describe('口径 2：账号级第四口径 —— 同一份钱只数一次（ADR-0018 决策 3）', () => {
  it('归属账号的 key 不进 keysBalance，合计 = 账号那一格', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.cn', supplier: 'tierflow' });
    const account = seedAccount(db, up.id, 5000);
    // 故意给这把 key 也塞一个余额：真实写路径落库时无限额度 key 是 `NULL`，
    // 但"万一被写进去"正是本口径要防的那一类双算，所以这里用最坏情况构造。
    const pooled = seedKey(db, up.id, 5000);
    bindKey(db, account, pooled);

    const u = computeUpstreamBalance(db, up.id);
    expect(u?.accountCount).toBe(1);
    expect(u?.accountsBalance).toBe(5000);
    expect(u?.keysBalance).toBeNull();
    expect(u?.totalBalance).toBe(5000); // 不是 10000
    // keys[] 与 keysBalance 取同一集合：归属出去的 key 不在这里出现，
    // 否则前端把 keys[] 一加就得到双倍。
    expect(u?.keys).toHaveLength(0);
  });

  it('无账号归属的 key 才进 keysBalance，两份钱相加成上游合计', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.cn', supplier: 'tierflow' });
    const account = seedAccount(db, up.id, 5000);
    const owned = seedKey(db, up.id, 5000);
    const free = seedKey(db, up.id, 300);
    bindKey(db, account, owned);

    const u = computeUpstreamBalance(db, up.id);
    expect(u?.keysBalance).toBe(300);
    expect(u?.totalBalance).toBe(5300);
    expect(u?.keys.map((k) => k.keyId)).toEqual([free]);
  });

  it('账号余额全未知时，key 那一半照样算出来（一边未知不吞掉另一边）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.cn', supplier: 'tierflow' });
    seedAccount(db, up.id, null);
    seedKey(db, up.id, 300);

    const u = computeUpstreamBalance(db, up.id);
    expect(u?.accountsBalance).toBeNull();
    expect(u?.accountsBalanceUnknownCount).toBe(1);
    expect(u?.keysBalance).toBe(300);
    expect(u?.totalBalance).toBe(300);
  });

  it('两边都未知才是 null', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.cn', supplier: 'tierflow' });
    const account = seedAccount(db, up.id, null);
    const pooled = seedKey(db, up.id, null);
    bindKey(db, account, pooled);

    const u = computeUpstreamBalance(db, up.id);
    expect(u?.totalBalance).toBeNull();
    // 未知计数**不看归属**：§2 的口径逐字是 `category='balance' AND unlimited=0 AND
    // balance_cents IS NULL`，没有"必须无账号归属"这一条。所以这把被归属出去的 key
    // 仍进未知计数 —— 它的余额对我们而言确实是查不到的。
    // 它不会造成双算：`keysBalance` 里没有它，`totalBalance` 仍由"账号那格 + key 那格"合成，
    // 两格都是未知，结果仍是 null，没有任何一个数字被替上游下结论。
    expect(u?.balanceUnknownKeyCount).toBe(1);
    expect(u?.keysBalance).toBeNull();
  });
});

describe('口径 3：无限额度 ≠ 未知（ADR-0018 决策 8）', () => {
  it('unlimited 的 key 不进未知计数，单独计一格，且落库余额是 NULL', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.cn', supplier: 'tierflow' });
    const unlim = seedKey(db, up.id, null, true);
    seedKey(db, up.id, null);

    const u = computeUpstreamBalance(db, up.id);
    expect(u?.balanceKeyCount).toBe(2);
    expect(u?.unlimitedKeyCount).toBe(1);
    expect(u?.balanceUnknownKeyCount).toBe(1); // 只有那把真未知的
    // 上游给的是 -331119 这种无意义负数；落进库就成了一把"已欠费"的 key，
    // 而网关的可用性过滤是 balance_cents <= 0 → 排除，于是它被**静默**踢出选路。
    const entry = u?.keys.find((k) => k.keyId === unlim);
    expect(entry?.balance).toBeNull();
    expect(entry?.unlimited).toBe(true);
    // 不变量（§15.6）：两格在 balanceKeyCount 内互不重叠
    expect((u?.unlimitedKeyCount ?? 0) + (u?.balanceUnknownKeyCount ?? 0)).toBeLessThanOrEqual(
      u?.balanceKeyCount ?? 0,
    );
  });
});

describe('口径 5：全局 = 各上游之和（结构上不可能漂移）', () => {
  it('逐项相加，且统计量按上游累加', () => {
    const db = setup();
    const a = createUpstream(db, { name: 'a', baseUrl: 'https://a.example.com' });
    const b = createUpstream(db, { name: 'b', baseUrl: 'https://b.example.com', supplier: 'tierflow' });
    seedKey(db, a.id, 1000);
    seedKey(db, a.id, null);
    const account = seedAccount(db, b.id, 250);
    const pooled = seedKey(db, b.id, null, true);
    bindKey(db, account, pooled);

    const g = computeGlobalBalance(db);
    const sum = g.byUpstream.reduce<number | null>((acc, u) => (u.totalBalance === null ? acc : (acc ?? 0) + u.totalBalance), null);
    expect(g.totalBalance).toBe(sum);
    expect(g.totalBalance).toBe(1250);
    expect(g.balanceKeyCount).toBe(3);
    expect(g.balanceUnknownKeyCount).toBe(1);
    expect(g.unlimitedKeyCount).toBe(1);
    expect(g.accountsBalanceUnknownCount).toBe(0);
  });

  it('全部未知时全局也是 null（不是 0）', () => {
    const db = setup();
    const a = createUpstream(db, { name: 'a', baseUrl: 'https://a.example.com' });
    seedKey(db, a.id, null);

    expect(computeGlobalBalance(db).totalBalance).toBeNull();
  });
});

describe('已软删的 key 不进任何格子', () => {
  it('软删后 key 从计数、合计、keys[] 三处同时消失', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'generic', baseUrl: 'https://generic.example.com' });
    const id = seedKey(db, up.id, 900);
    expect(computeUpstreamBalance(db, up.id)?.totalBalance).toBe(900);

    db.prepare('UPDATE upstream_keys SET deleted_at = ? WHERE id = ?').run('2026-10-07T01:00:00.000Z', id);

    const u = computeUpstreamBalance(db, up.id);
    expect(u?.totalBalance).toBeNull();
    expect(u?.balanceKeyCount).toBe(0);
    expect(u?.keys).toHaveLength(0);
  });
});
