// 废号池的**落库腿**（契约 §21.3 / ADR-0043）。
//
// 与 `repo/depletion-latch.ts` 的关系写得最清楚的一句：**两者不是同一件事**。
//   - `depletion-latch` = 「这钱包付不起账」→ 只置锁存，**绝不碰 `enabled`**（§20.5 纪律 2：
//     混在一起的话，一次批量启用会把整池透支 key 放回去）；
//   - 本文件 = 「这个号没价值了」→ 除锁存外**还要 `enabled = 0`**（业主原话「该账号的
//     key 也全部停用」）。
//
// 所以解除时的行为也跟着分叉：解透支只清锁（`clearKeyDepletedAndEnable` 是"清锁 + 启用"，
// 那是业主对"重新启用"的诉求）；**解废号池还要把 enabled 恢复** —— 停用的原因（号废了）
// 消失了，留着停用会让操作员以为解除没生效。
//
// 三条纪律与 `depletion-latch` 逐字相同，因为踩过的坑是同一批：
//   1. **只置位、从不自动清除**：`WHERE scrapped_at IS NULL`。恢复只有人工 `unscrap`。
//   2. **每次 key 变更都广播**：`appendChange('key', …)` ⇒ 网关 ≤1s 重建快照。
//      漏发的表现不是报错，是"管理面停用了、网关照旧转发"。
//   3. **账号行不广播**：网关快照里没有 `supplier_accounts` 这个实体，发了只是白重建一次。

import { nowIso } from '../../util/time.js';
import type { Db } from '../database.js';
import type { ScrapReason } from '../scrap.js';
import { appendChange } from './change-log.js';

/** 该账号**名下已入池、未软删**的 key id（级联与停用共用这一条 SQL）。 */
function pooledKeyIdsOf(db: Db, accountId: string): string[] {
  const rows = db
    .prepare(
      `SELECT uk.id AS id
         FROM supplier_account_keys sak
         JOIN upstream_keys uk ON uk.id = sak.pooled_key_id
        WHERE sak.account_id = ? AND uk.deleted_at IS NULL`,
    )
    .all(accountId) as { id: string }[];
  return rows.map((row) => row.id);
}

/**
 * 账号进废号池。**粘性**：已在池中就不再写（返回 `false`，不推时间戳、零写）。
 *
 * 调用方负责先判（`decideAccountScrap`），再调这里 —— 本文件不判"该不该废"。
 */
export function latchAccountScrapped(db: Db, accountId: string, reason: ScrapReason): boolean {
  const at = nowIso();
  const info = db
    .prepare(
      `UPDATE supplier_accounts
       SET scrapped_at = ?, scrap_reason = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND scrapped_at IS NULL`,
    )
    .run(at, reason, at, accountId);
  return info.changes > 0;
}

/**
 * 停用该账号名下所有 key（`enabled = 0`），返回真正改动的把数。
 *
 * 与 `latchAccountCascade`（标锁存）**分开两个函数、但必须一起调**：
 * 锁存让网关**不选**它（`isUsable` 的 depleted 判据），`enabled = 0` 让管理面**看着是停用**，
 * 且让"批量启用"也不会把它悄悄放回去（批量启用不动 `depleted_at`，所以锁还在 —— 两道闸）。
 *
 * 不要求 `enabled = 1` 才更新：已经手工停用的也一起走一遍没坏处（幂等），
 * 但**不重复广播**已被别的腿改过的行（`changes === 0` 就跳过）。
 */
export function disableKeysOfAccount(db: Db, accountId: string): number {
  const ids = pooledKeyIdsOf(db, accountId);
  if (ids.length === 0) return 0;
  const at = nowIso();
  const update = db.prepare(
    `UPDATE upstream_keys
     SET enabled = 0, revision = revision + 1, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL AND enabled = 1`,
  );
  let disabled = 0;
  db.transaction(() => {
    for (const id of ids) {
      if (update.run(at, id).changes === 0) continue;
      appendChange(db, 'key', id, 'update', null);
      disabled += 1;
    }
  })();
  return disabled;
}

/**
 * 账号出废号池（人工）：清那两个 scrap 列，**并**把为它停用的 key 恢复。
 *
 * 恢复范围只到「因它而停用」的粒度做不到（`enabled` 只有 0/1 两态，没有"谁停的"这一列），
 * 所以口径是**全量恢复**：该账号名下、未软删的 key 一律 `enabled = 1`。
 * 这比 §20 的账号解除（只清 `depleted_reason = 'account'` 的那批）更宽，理由是这里多了一个
 * 事实：进废池时我们把 `enabled` 也动了，那一步没有留痕可回放，只能整体还原。
 *
 * `depleted_at` 一并清：进废池时标的那把锁，原因与 enabled 同源（都因号废），不该留下。
 * 一把**自己**余额不足的 key 会被下一轮刷新重新锁上（判据没变），那是正确的。
 */
export function clearAccountScrapped(db: Db, accountId: string): { account: boolean; keys: number } {
  const at = nowIso();
  return db.transaction(() => {
    const account = db
      .prepare(
        `UPDATE supplier_accounts
         SET scrapped_at = NULL, scrap_reason = NULL, revision = revision + 1, updated_at = ?
         WHERE id = ? AND scrapped_at IS NOT NULL`,
      )
      .run(at, accountId);

    const rows = db
      .prepare(
        `SELECT uk.id AS id
           FROM supplier_account_keys sak
           JOIN upstream_keys uk ON uk.id = sak.pooled_key_id
          WHERE sak.account_id = ? AND uk.deleted_at IS NULL`,
      )
      .all(accountId) as { id: string }[];
    const update = db.prepare(
      `UPDATE upstream_keys
       SET enabled = 1, depleted_at = NULL, depleted_reason = NULL,
           revision = revision + 1, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND (enabled = 0 OR depleted_at IS NOT NULL)`,
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
