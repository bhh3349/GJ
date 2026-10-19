// 透支锁存的**落库腿**（契约 §20.3–§20.6 / ADR-0041）。
//
// 为什么单独一个文件而不是把 SQL 散在七个落库点：判据只有一份（`src/db/depletion.ts`），
// 落库也必须只有一份。散开写的失败形状不是"要改七处"，而是**七处会不一致** ——
// 一处忘了 `AND depleted_at IS NULL`（粘性破功，`depletedAt` 被反复推新，
// "最早发现它付不起账的时刻"这条审计事实就此消失）、一处忘了 `revision + 1`
// （网关快照永远不重建，库里有标记而池里那把 key 照跑）。
//
// 三条纪律写在这里，七个落库点共用：
//   1. **只置位、从不自动清除**（§20.3）：`WHERE depleted_at IS NULL`。恢复只有一个入口 ——
//      人工 `undeplete`（本文件的两个 clear 函数）。
//   2. **只碰 `depleted_at` / `depleted_reason`**（§20.5）：锁存**绝不**碰 `enabled`。
//      `enabled` 是管理员的配置意图，透支是系统按钱算出来的结论，两者混在一起，
//      批量启用会把整池透支 key 一次性放回去（"不会再回到正常的池"当场作废）。
//   3. **每次置位/清除都广播**（§20.7）：`appendChange('key', …)`。`'key'` 在
//      `SNAPSHOT_ENTITIES` 里 ⇒ 网关 ≤1s 重建快照，**不需要任何新机制**。
//      漏发的表现不是报错，是"管理面上有红标、网关照旧选它"。
//
// 本文件不判"该不该锁" —— 判在 `depletion.ts`，调用方先判再调这里。

import { nowIso } from '../../util/time.js';
import type { Db } from '../database.js';
import type { DepletedReason } from '../depletion.js';
import { appendChange } from './change-log.js';

/**
 * 给一把 key 置位。**粘性**：已锁存的不再写（返回 `false`，不推时间戳、不广播、零写）。
 *
 * 返回"这次是不是真的新锁了" —— 调用方一般忽略它，但它让"反复刷新零写"这条
 * 可被测试直接断言，而不是靠读 SQL 确认。
 */
export function latchKeyDepleted(db: Db, keyId: string, reason: DepletedReason): boolean {
  const at = nowIso();
  const info = db
    .prepare(
      `UPDATE upstream_keys
       SET depleted_at = ?, depleted_reason = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL AND depleted_at IS NULL`,
    )
    .run(at, reason, at, keyId);
  if (info.changes === 0) return false;
  appendChange(db, 'key', keyId, 'update', null);
  return true;
}

/**
 * 账号欠费级联（§20.6）：给该账号**名下所有已入池、未软删**的 key 置位。
 *
 * 一条 SQL 选出待锁 id 再逐行 UPDATE（不是 `UPDATE … WHERE id IN (SELECT …)`）：
 * 广播需要**具体 id**，而 `changes` 只回条数。选出的每一行只做一次写，
 * 因为 `depleted_at IS NULL` 的过滤同时出现在 SELECT 与 UPDATE 里（重复不会发生）。
 *
 * **`unlimited` 不排除**（有意，与 §20.2 那句不冲突）：§20.2 判的是"这把 key 自己的钱"，
 * 而这里是**账号级的资金事实** —— 账号钱包空了是它自己的结论，与这把 key 在上游
 * 是无限额度无关。业主原话是"关联 key 全部"，本版按全量级联（宁可少一把候选，
 * 也不要"看起来能跑、打出去就 402"）。若实测证明账号欠费不影响无限额度 key，
 * 收窄只需在这里加一句 `AND uk.unlimited = 0`。
 */
export function latchAccountCascade(db: Db, accountId: string): number {
  const rows = db
    .prepare(
      `SELECT uk.id AS id
         FROM supplier_account_keys sak
         JOIN upstream_keys uk ON uk.id = sak.pooled_key_id
        WHERE sak.account_id = ? AND uk.deleted_at IS NULL AND uk.depleted_at IS NULL`,
    )
    .all(accountId) as { id: string }[];
  const at = nowIso();
  const update = db.prepare(
    `UPDATE upstream_keys
     SET depleted_at = ?, depleted_reason = 'account', revision = revision + 1, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL AND depleted_at IS NULL`,
  );
  let latched = 0;
  db.transaction(() => {
    for (const row of rows) {
      const info = update.run(at, at, row.id);
      if (info.changes === 0) continue; // 并发下已被别的腿锁了 —— 不重复广播
      appendChange(db, 'key', row.id, 'update', null);
      latched += 1;
    }
  })();
  return latched;
}

/** 账号自身置位。**粘性**同 key；`reason` 恒 `'balance'`（账号没有"所属账号欠费"这种东西）。 */
export function latchAccountDepleted(db: Db, accountId: string): boolean {
  const at = nowIso();
  const info = db
    .prepare(
      `UPDATE supplier_accounts
       SET depleted_at = ?, depleted_reason = 'balance', revision = revision + 1, updated_at = ?
       WHERE id = ? AND depleted_at IS NULL`,
    )
    .run(at, at, accountId);
  return info.changes > 0;
}

/**
 * key 批量解除（§20.5）：**清锁 + `enabled = 1`**，返回 `updated`（= 匹配到的未软删行数）。
 *
 * 两个动作绑在一起是业主的诉求（"重新启用"）—— 做成两步会让用户点一次以为完成了。
 * 语义与既有 `batchSetEnabled` 一致：不存在的 id 静默不计入，幂等可重放。
 *
 * **`enable` 不清锁**（`batchSetEnabled` 一行不动）：两条路分得很清，
 * 否则一次批量启用就能把整池透支 key 放回去。
 */
export function clearKeyDepletedAndEnable(db: Db, ids: readonly string[]): number {
  if (ids.length === 0) return 0;
  const at = nowIso();
  const placeholders = ids.map(() => '?').join(', ');
  const info = db
    .prepare(
      `UPDATE upstream_keys
       SET depleted_at = NULL, depleted_reason = NULL, enabled = 1,
           revision = revision + 1, updated_at = ?
       WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
    )
    .run(at, ...ids);
  if (info.changes > 0) appendChange(db, 'key', ids.join(','), 'update', null);
  return info.changes;
}

/**
 * 账号解除（§20.5）：清账号锁 + 清该账号名下 `depleted_reason = 'account'` 的 key 锁。
 *
 * **只清 `'account'` 那一种**：一把**自己**余额不足（`'balance'`）的 key，
 * 解账号的锁不能连带放它回池 —— 它没钱这件事没变，下一轮刷新照样会重新锁
 * （而"人工核查过了"这个签名只对账号那一条事实成立）。
 */
export function clearAccountDepletedCascade(db: Db, accountId: string): { account: boolean; keys: number } {
  const at = nowIso();
  return db.transaction(() => {
    const account = db
      .prepare(
        `UPDATE supplier_accounts
         SET depleted_at = NULL, depleted_reason = NULL, revision = revision + 1, updated_at = ?
         WHERE id = ? AND depleted_at IS NOT NULL`,
      )
      .run(at, accountId);

    // 先选出 id 再逐行清：广播要具体 id，而 `changes` 只回条数（同 `latchAccountCascade`）。
    // 账号行自己**不广播** —— 网关快照里没有 `supplier_accounts` 这个实体，
    // 发一条只会让它白重建一次；有意义的是"哪些 key 回池了"。
    const rows = db
      .prepare(
        `SELECT uk.id AS id
           FROM supplier_account_keys sak
           JOIN upstream_keys uk ON uk.id = sak.pooled_key_id
          WHERE sak.account_id = ? AND uk.deleted_at IS NULL
            AND uk.depleted_reason = 'account'`,
      )
      .all(accountId) as { id: string }[];
    const update = db.prepare(
      `UPDATE upstream_keys
       SET depleted_at = NULL, depleted_reason = NULL, enabled = 1,
           revision = revision + 1, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL AND depleted_reason = 'account'`,
    );
    let keys = 0;
    for (const row of rows) {
      if (update.run(at, row.id).changes === 0) continue;
      appendChange(db, 'key', row.id, 'update', null);
      keys += 1;
    }
    return { account: account.changes > 0, keys };
  })();
}
