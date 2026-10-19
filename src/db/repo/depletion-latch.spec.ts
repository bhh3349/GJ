// 透支锁存的**落库腿**（契约 §20.3–§20.6 / ADR-0041）。
//
// `src/db/depletion.spec.ts` 钉的是"该不该锁"（纯判据），这里钉的是**锁下去之后库里长什么样**
// —— 而这一层的错误全部是静默的，所以每条断言都对着一个具体的错法：
//
//   1. **粘性破功**：第二次置位若再写一次，`depletedAt` 被推新，"最早发现它付不起账的时刻"
//      这条审计事实就没了（§20.3）。而且**不报错** —— 只有去比对两次时间戳才看得出来。
//   2. **忘了广播**：`revision + 1` 而不发 `'key'`，网关那一轮快照不重建 ——
//      管理面显示红标、网关照旧选它，直到下一次别的改动把它顺手唤醒。这条是"库里对了、
//      线上不对"的最短路径。
//   3. **清锁顺手清了不该清的**：账号解除只该清 `reason='account'` 的 key。
//      连带放回一把**自己**余额不足（`'balance'`）的 key，下一轮刷新会当场把它再锁上，
//      用户看到的是"点了解除、过一会儿又红了"，而两次动作各自都"成功"。
//   4. **`enable` 顺手清锁**：一次批量启用就能把整池透支 key 放回池子 ——
//      业主那句"不会再回到正常的池"当场作废（§20.5 决策 6）。
//   5. **软删的行被锁/被清**：`deleted_at IS NOT NULL` 的行既不该进级联，也不该被解除
//      （解除会把它 `enabled = 1`，而软删行的语义是已删）。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../database.js';
import { createSupplierAccount } from './supplier-accounts.js';
import { createKey, deleteKey, listKeys, setKeyBalance, updateKey } from './keys.js';
import {
  clearAccountDepletedCascade,
  clearKeyDepletedAndEnable,
  latchAccountCascade,
  latchAccountDepleted,
  latchKeyDepleted,
} from './depletion-latch.js';
import { createUpstream } from './upstreams.js';

const MASTER_KEY = Buffer.from('2b'.repeat(32), 'hex');

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
      /* 临时目录删不掉不影响判据 */
    }
  }
});

function setup(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'depletion-latch-probe-'));
  dirs.push(dir);
  const db = openDatabase({ path: join(dir, 'gateway.db') });
  open.push(db);
  return db;
}

let seq = 0;
/** 池内 key 的明文**运行时拼**：`check:secrets` 会抓源码里硬编码的 `sk-…` 字面量。 */
function seedKey(db: Db, upstreamId: string, over: { category?: 'balance' | 'token-plan'; unlimited?: boolean } = {}): string {
  const dto = createKey(
    db,
    {
      upstreamId,
      key: 'sk-probe-' + 'D'.repeat(16) + String(++seq).padStart(4, '0'),
      category: over.category ?? 'balance',
      ...(over.unlimited === true ? { unlimited: true } : { balance: 1280 }),
    },
    MASTER_KEY,
  );
  return dto.id;
}

function seedAccount(db: Db, upstreamId: string): string {
  const id = 'acc_' + String(++seq).padStart(10, '0');
  createSupplierAccount(db, id, {
    upstreamId,
    supplier: 'tierflow',
    identifier: '138****8000',
    identifierHash: `hash-${id}`,
    status: 'active',
    // 凭据列必须有一路非空（DDL 的 CHECK）；这里只要一个占位密文，本文件不读它。
    encryptedPassword: Buffer.from('fake-ciphertext'),
  });
  return id;
}

/** 台账行：把这把池内 key 挂到账号名下（级联的入口）。 */
function bind(db: Db, accountId: string, pooledKeyId: string): void {
  const at = '2026-10-07T00:00:00.000Z';
  db.prepare(
    `INSERT INTO supplier_account_keys (id, account_id, masked_key, pooled_key_id, note, created_at, updated_at)
     VALUES (?, ?, '****probe', ?, NULL, ?, ?)`,
  ).run(`sak_${++seq}`, accountId, pooledKeyId, at, at);
}

/** 库里那一行的锁存三列 + 启用位（读面 DTO 会拦一道，真实落库结果只有这里看得见）。 */
function latchOf(db: Db, keyId: string, table = 'upstream_keys'): {
  at: string | null;
  reason: string | null;
  enabled: number | null;
  revision: number;
} {
  const row = db
    .prepare(
      `SELECT depleted_at AS at, depleted_reason AS reason, revision AS revision
              ${table === 'upstream_keys' ? ', enabled AS enabled' : ', NULL AS enabled'}
         FROM ${table} WHERE id = ?`,
    )
    .get(keyId) as { at: string | null; reason: string | null; enabled: number | null; revision: number };
  return row;
}

/**
 * 这把 key 收到的 `'key'` **更新**广播条数。
 *
 * 只数 `op = 'update'`：`createKey` 那条 `'insert'` 也是 `entity = 'key'` 且 `entity_id` 是同一个 id，
 * 不滤掉的话每条断言都被垫高一格，"漏发广播"就永远看不出来（这正是本文件要抓的错法之一）。
 */
const keyBroadcasts = (db: Db, keyId: string): number =>
  (
    db
      .prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'key' AND entity_id = ? AND op = 'update'")
      .get(keyId) as { n: number }
  ).n;

/** 该 id 收到的**任意实体**的广播条数 —— 用来断言"一条都没发"（账号行那条）。 */
const changeCountFor = (db: Db, entityId: string): number =>
  (
    db.prepare('SELECT COUNT(*) AS n FROM change_log WHERE entity_id = ?').get(entityId) as { n: number }
  ).n;

/** 一条把 id 串起来的广播（`clearKeyDepletedAndEnable` 的形状，与 `batchSetEnabled` 同形）。 */
const joinedBroadcasts = (db: Db, ids: readonly string[]): number =>
  (
    db
      .prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'key' AND entity_id = ? AND op = 'update'")
      .get(ids.join(',')) as { n: number }
  ).n;

describe('§20.3 粘性：只置位，二次置位零写', () => {
  it('第二次置位不改时间戳、不推 revision、不广播', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.example', supplier: 'tierflow' });
    const keyId = seedKey(db, up.id);

    expect(latchKeyDepleted(db, keyId, 'balance')).toBe(true);
    const first = latchOf(db, keyId);
    expect(first.at).not.toBeNull();
    expect(first.reason).toBe('balance');
    const before = { at: first.at, revision: first.revision, broadcasts: keyBroadcasts(db, keyId) };
    expect(before.broadcasts).toBe(1);

    // 下一轮刷新又看到余额 <10 —— 这正是线上每 30 分钟会发生一次的事。
    expect(latchKeyDepleted(db, keyId, 'balance')).toBe(false);
    const second = latchOf(db, keyId);
    expect(second.at).toBe(before.at);
    expect(second.revision).toBe(before.revision);
    expect(keyBroadcasts(db, keyId)).toBe(before.broadcasts);
  });

  it('锁存**不碰** `enabled`：库里仍是启用态，排除靠的是锁存标记（§20.5 决策 6）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.example', supplier: 'tierflow' });
    const keyId = seedKey(db, up.id);

    latchKeyDepleted(db, keyId, 'balance');
    expect(latchOf(db, keyId).enabled).toBe(1);
    // 读面也看得见这个组合（DTO 的三列与 §20.8 同源）
    const dto = listKeys(db, { includeDeleted: false, page: 1, pageSize: 10 }).items.find((k) => k.id === keyId);
    expect(dto).toMatchObject({ depleted: true, enabled: true });
  });

  it('已软删的行锁不上（`deleted_at IS NOT NULL` 直接排除）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.example', supplier: 'tierflow' });
    const keyId = seedKey(db, up.id);
    deleteKey(db, keyId);

    expect(latchKeyDepleted(db, keyId, 'balance')).toBe(false);
    expect(latchOf(db, keyId).at).toBeNull();
  });

  it('判定腿在**手动录入余额**那条路上真的挂上了：录一个 0 当场锁（§20.4）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.example', supplier: 'tierflow' });
    const keyId = seedKey(db, up.id);
    expect(latchOf(db, keyId).at).toBeNull();

    // "人工核实"是把值写得更准，不是把判据关掉 —— 认真核查后填入真实余额反而逃过锁存是荒谬的。
    setKeyBalance(db, keyId, { balance: 0 });
    expect(latchOf(db, keyId)).toMatchObject({ reason: 'balance' });

    // 反向：录回一个够用的余额**不**解锁（§20.3 只置位）—— 回池只有人工那一个入口。
    setKeyBalance(db, keyId, { balance: 5000 });
    expect(latchOf(db, keyId).at).not.toBeNull();
  });

  it('判定腿在**手动改套餐余量**那条路上：PATCH 一个 0 当场锁，返回的 DTO 就带标（§20.4）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.example', supplier: 'tierflow' });
    const keyId = seedKey(db, up.id, { category: 'token-plan' });

    // 编辑弹窗对套餐 key 走的正是 updateKey 的 tokenPlan 分支 —— 它与 setKeyBalance
    // 录 0 是同一个动作的两张脸；缺这条腿，"所有落库处都判"就是没兑现的话。
    const dto = updateKey(db, keyId, { tokenPlan: { remainingTokens: 0, expiresAt: null }, revision: 1 });
    expect(latchOf(db, keyId)).toMatchObject({ reason: 'balance' });
    // 判完再读：响应必须带上刚打的标，且 revision 与实际落库一致
    // （少读一次的后果是调用方拿着旧 revision 下一次 PATCH 当场 REVISION_MISMATCH）。
    expect(dto).toMatchObject({ depleted: true, depletedReason: 'balance' });
    expect(dto.revision).toBe(latchOf(db, keyId).revision);

    // 粘性：再 PATCH 一次 0，时间戳不推新（第二次置位零写）。
    const first = latchOf(db, keyId).at;
    updateKey(db, keyId, { tokenPlan: { remainingTokens: 0, expiresAt: null }, revision: dto.revision });
    expect(latchOf(db, keyId).at).toBe(first);

    // **门控**：这条腿只挂在 tokenPlan 写分支上。改个 label 不该重开资金判据 ——
    // 否则一次改名就能把一把「解除后余量仍是 0」的 key 静默重新锁上，
    // 而那不是这次 PATCH 做的事。
    clearKeyDepletedAndEnable(db, [keyId]);
    const renamed = updateKey(db, keyId, { label: '只是改了个名', revision: latchOf(db, keyId).revision });
    expect(renamed.depleted).toBe(false);
    expect(latchOf(db, keyId).at).toBeNull();
  });

  it('判定腿在**建 key 就带 0**那条路上：生而为 0 当场锁，不等下一轮刷新（§20.4）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.example', supplier: 'tierflow' });

    const born0 = createKey(
      db,
      { upstreamId: up.id, key: 'sk-probe-' + 'E'.repeat(16) + '0001', category: 'balance', balance: 0 },
      MASTER_KEY,
    );
    expect(born0).toMatchObject({ depleted: true, depletedReason: 'balance' });
    // 建 key 发的是 'insert'，锁存自己再发一条 'update' —— 少了后者，
    // 网关首次快照就把这把 0 余额的 key 当可用（§20.7 的漏发形状）。
    expect(keyBroadcasts(db, born0.id)).toBe(1);

    const bornPlan0 = createKey(
      db,
      {
        upstreamId: up.id,
        key: 'sk-probe-' + 'E'.repeat(16) + '0002',
        category: 'token-plan',
        tokenPlan: { remainingTokens: 0, expiresAt: null },
      },
      MASTER_KEY,
    );
    expect(bornPlan0.depleted).toBe(true);

    // 反向对照：`unlimited` 在 INSERT 处把 balance_cents 强制成 NULL（§15.7），
    // 结构上够不着这条判据 —— 但必须由这条用例钉住，否则哪天有人把那个强制去掉，
    // 沉默的后果是"一整批无限额度 key 集体锁存"。
    const unlimited = createKey(
      db,
      { upstreamId: up.id, key: 'sk-probe-' + 'E'.repeat(16) + '0003', category: 'balance', unlimited: true },
      MASTER_KEY,
    );
    expect(unlimited.depleted).toBe(false);
    expect(keyBroadcasts(db, unlimited.id)).toBe(0);
  });
});

describe('§20.6 账号级联：名下池内 key 全部置位（含 unlimited）', () => {
  it('级联给每把 key 置 `reason = account`，软删的与未入池的不在其中', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.example', supplier: 'tierflow' });
    const acc = seedAccount(db, up.id);

    const plain = seedKey(db, up.id);
    const unlimited = seedKey(db, up.id, { unlimited: true });
    const plan = seedKey(db, up.id, { category: 'token-plan' });
    const deleted = seedKey(db, up.id);
    const orphan = seedKey(db, up.id); // 池内但**没有**台账行 = 不属于这个账号
    bind(db, acc, plain);
    bind(db, acc, unlimited);
    bind(db, acc, plan);
    bind(db, acc, deleted);
    deleteKey(db, deleted);

    const latched = latchAccountCascade(db, acc);
    expect(latched).toBe(3);
    for (const id of [plain, unlimited, plan]) {
      expect(latchOf(db, id), id).toMatchObject({ reason: 'account' });
    }
    expect(latchOf(db, deleted).at).toBeNull();
    expect(latchOf(db, orphan).at).toBeNull();

    // 幂等：再跑一次零写（`depleted_at IS NULL` 的过滤同时出现在 SELECT 与 UPDATE 里）。
    expect(latchAccountCascade(db, acc)).toBe(0);
  });

  it('账号行自身的 `reason` 恒 `balance` —— 账号没有"所属账号欠费"这种东西', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.example', supplier: 'tierflow' });
    const acc = seedAccount(db, up.id);

    expect(latchAccountDepleted(db, acc)).toBe(true);
    expect(latchOf(db, acc, 'supplier_accounts')).toMatchObject({ reason: 'balance' });
    // 粘性同 key：二次置位不改时间戳。
    const first = latchOf(db, acc, 'supplier_accounts').at;
    expect(latchAccountDepleted(db, acc)).toBe(false);
    expect(latchOf(db, acc, 'supplier_accounts').at).toBe(first);
  });
});

describe('§20.5 解除：清锁 + `enabled = 1`，两个动作绑在一起', () => {
  it('批量解除：清锁、启用、`revision + 1`，并发一条把 id 串起来的 `key` 广播', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.example', supplier: 'tierflow' });
    const a = seedKey(db, up.id);
    const b = seedKey(db, up.id);
    latchKeyDepleted(db, a, 'balance');
    latchKeyDepleted(db, b, 'balance');
    db.prepare('UPDATE upstream_keys SET enabled = 0 WHERE id IN (?, ?)').run(a, b);
    const before = keyBroadcasts(db, a);
    expect(before).toBe(1); // 每把各自那一条置位广播

    expect(clearKeyDepletedAndEnable(db, [a, b])).toBe(2);
    for (const id of [a, b]) {
      expect(latchOf(db, id)).toMatchObject({ at: null, reason: null, enabled: 1 });
    }
    // 广播是**一条**（`entity_id` 是 id 串），不是每把一条 —— 与 `batchSetEnabled` 同形。
    // 所以这里既断言"串那条多了一条"，也断言"单把那条没多" —— 少了后者，
    // 把实现改成逐把广播也照样绿。
    expect(joinedBroadcasts(db, [a, b])).toBe(1);
    expect(keyBroadcasts(db, a)).toBe(before);
    expect(keyBroadcasts(db, b)).toBe(before);

    // 不存在的 id 静默不计入（幂等可重放，同 `batchSetEnabled` 的语义）。
    expect(clearKeyDepletedAndEnable(db, ['key_does_not_exist'])).toBe(0);
    expect(clearKeyDepletedAndEnable(db, [])).toBe(0);
  });

  it('账号解除只清 `reason = account` 的 key —— 自己余额不足的那把留在池外', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.example', supplier: 'tierflow' });
    const acc = seedAccount(db, up.id);

    const cascaded = seedKey(db, up.id);
    const ownBroke = seedKey(db, up.id);
    bind(db, acc, cascaded);
    bind(db, acc, ownBroke);
    // 顺序是关键：**先**让 `ownBroke` 因自己余额不足锁上（`reason='balance'`），
    // **再**跑账号级联。级联的 SELECT 与 UPDATE 都带 `depleted_at IS NULL`，
    // 所以它跳过这把 —— 于是库里留下的是 `'balance'` 这个更早、更具体的原因。
    //
    // 反过来（级联先跑）也是一条**真实**路径，但那时 `depleted_at` 已非空，
    // 后面那笔余额落库的置位是**零写**，`reason` 会停在 `'account'`，
    // 账号解除会把它放回池、下一轮刷新再以 `'balance'` 重新锁上（§20.3 粘性使然，
    // 不是漏判）。两条路径都合规；本条钉的是"账户解除**够不着** `'balance'`"那一条不变量。
    latchKeyDepleted(db, ownBroke, 'balance');
    latchAccountDepleted(db, acc);
    latchAccountCascade(db, acc);
    expect(latchOf(db, ownBroke)).toMatchObject({ reason: 'balance' });
    expect(latchOf(db, cascaded)).toMatchObject({ reason: 'account' });
    // 粘性顺带的后果：对一把已锁的行再置一次位，`reason` **不**被覆写（零写）。
    expect(latchKeyDepleted(db, ownBroke, 'account')).toBe(false);
    expect(latchOf(db, ownBroke)).toMatchObject({ reason: 'balance' });

    const ownBrokeRevision = latchOf(db, ownBroke).revision;
    const cleared = clearAccountDepletedCascade(db, acc);
    expect(cleared).toEqual({ account: true, keys: 1 });
    expect(latchOf(db, acc, 'supplier_accounts')).toMatchObject({ at: null, reason: null });
    expect(latchOf(db, cascaded)).toMatchObject({ at: null, reason: null, enabled: 1 });
    // 关键那一行：它没被连带放回池 —— 它没钱这件事没变，下一轮刷新照样会重新锁。
    // 而且它这一行**一个字节都没动**（`revision` 不动）：账号解除没碰它，
    // 不是"碰了又恰好写回同一个值"。
    expect(latchOf(db, ownBroke)).toMatchObject({ reason: 'balance' });
    expect(latchOf(db, ownBroke).revision).toBe(ownBrokeRevision);

    // 幂等：账号本来就没锁时，第二次是"0 清 0"而不是报错。
    expect(clearAccountDepletedCascade(db, acc)).toEqual({ account: false, keys: 0 });
  });

  it('账号解除不碰软删的 key（解除会把它 `enabled = 1`，而软删行不该被启用）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.example', supplier: 'tierflow' });
    const acc = seedAccount(db, up.id);
    const live = seedKey(db, up.id);
    const gone = seedKey(db, up.id);
    bind(db, acc, live);
    bind(db, acc, gone);
    latchAccountCascade(db, acc);
    deleteKey(db, gone);
    const goneRevision = latchOf(db, gone).revision;

    expect(clearAccountDepletedCascade(db, acc).keys).toBe(1);
    expect(latchOf(db, live).at).toBeNull();
    expect(latchOf(db, gone).revision).toBe(goneRevision); // 一个字节都没动
  });
});

describe('§20.5 / §20.7 广播：置位必须叫醒网关', () => {
  it('级联与解除各给**每把**受影响的 key 发一条 `key` 广播', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.example', supplier: 'tierflow' });
    const acc = seedAccount(db, up.id);
    const a = seedKey(db, up.id);
    const b = seedKey(db, up.id);
    bind(db, acc, a);
    bind(db, acc, b);

    latchAccountCascade(db, acc);
    expect(keyBroadcasts(db, a)).toBe(1);
    expect(keyBroadcasts(db, b)).toBe(1);

    clearAccountDepletedCascade(db, acc);
    expect(keyBroadcasts(db, a)).toBe(2);
    expect(keyBroadcasts(db, b)).toBe(2);
    // 两条腿都是**逐把**广播（`entity_id` 是单个 key id），不是像批量解除那样合成一条 ——
    // 级联 / 解除的受影响集合是由 SQL 选出来的，逐把发才能与"到底哪些 key 动了"一致。
    expect(joinedBroadcasts(db, [a, b])).toBe(0);
  });

  it('账号行自己不广播 —— 快照里没有 `supplier_accounts` 这个实体', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.example', supplier: 'tierflow' });
    const acc = seedAccount(db, up.id);
    expect(changeCountFor(db, acc)).toBe(0);
    const revisionBefore = latchOf(db, acc, 'supplier_accounts').revision;

    expect(latchAccountDepleted(db, acc)).toBe(true);
    // 发一条只会让网关白重建一次（`supplier_accounts` 不在 `SNAPSHOT_ENTITIES` 里，
    // 而快照里也没有这个实体）—— 有意义的是"哪些 key 回池了"，账号行自己不发。
    expect(changeCountFor(db, acc)).toBe(0);

    // 反向钉：同一次调用里**确实**发生了写（`revision` 推了一格）——
    // 否则上面的 0 可能只是因为什么都没做，而不是"做了但不广播"。
    expect(latchOf(db, acc, 'supplier_accounts').revision).toBe(revisionBefore + 1);
  });
});
