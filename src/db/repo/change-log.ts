// change_log：管理端写入的广播出口。
//
// 网关进程在热路径上不查库，靠两种手段感知管理端改动（契约 §9）：
//   1. 本表新增行的 internal hook（同进程可即时唤醒）；
//   2. 1s 轮询兜底（跨进程时唯一可靠的那条）。
// 两条并存不是冗余：hook 负责"快"，轮询负责"一定到"。
//
// 注意：**热路径（/v1/*）绝不写本表**。它只由管理面写操作触发。

import { nowIso } from '../../util/time.js';
import type { Db } from '../database.js';

// 'egress'（§16.7）：出口配置的广播。出口不是 upstream —— 写 'upstream' 会让网关把
// "改了个出口"误当成"上游配置变了"而空转重载；两个广播面的读者不同，不共用实体名。
export type ChangeEntity = 'upstream' | 'key' | 'group' | 'gateway_key' | 'model' | 'balance' | 'egress';
export type ChangeOp = 'insert' | 'update' | 'delete';

export function appendChange(
  db: Db,
  entity: ChangeEntity,
  entityId: string,
  op: ChangeOp,
  revision: number | null,
): void {
  db.prepare(
    'INSERT INTO change_log (entity, entity_id, op, revision, at) VALUES (?, ?, ?, ?, ?)',
  ).run(entity, entityId, op, revision, nowIso());
}

/** 增量拉取，给网关轮询用。seq 单调递增，调用方记住上次的 seq 即可。 */
export function changesSince(db: Db, seq: number, limit = 500): unknown[] {
  return db
    .prepare(
      'SELECT seq, entity, entity_id AS entityId, op, revision, at FROM change_log WHERE seq > ? ORDER BY seq LIMIT ?',
    )
    .all(seq, limit);
}

/**
 * 保留最近 N 条，防止表无限增长（它只是广播信道，不是审计）。
 *
 * **为什么"删掉 seq 更小的行"不会让消费者漏变更** —— 这是本函数唯一需要论证的地方：
 *
 * 消费者（`src/wiring/store.ts` 的 `drainChanges`、`src/wiring/egress-proxy.ts` 的 `refresh`）
 * 每次排空都把自己的 `lastSeq` 推到**读到的最后一条**，而它们的节拍是 1s
 * （`SNAPSHOT_POLL_MS`）。所以"哪些行还被某个消费者需要"= `seq > 该消费者的 lastSeq`。
 * 只要 `keep` 远大于**一个节拍内可能产生的变更数**，裁剪线就永远追不上任何消费者的 `lastSeq`。
 *
 * 一个节拍内最多几条？`appendChange` 的写点全是管理面的批量动作，单次事务里最多的是
 * `backfillSubscriptionTokenPlan` 与 `replaceSupplierAccountKeyLedger` —— 它们按
 * "受影响的 key 数"逐条发，而上游的 key 池规模是**几十把**。也就是说一个节拍的上界在
 * 几十条量级，`keep = 10_000` 余量约两个数量级。
 *
 * **但这不是无条件的**，两个前提必须成立，所以裁掉的前提条件写在这里而不是藏在数字里：
 *   · 消费者进程**活着**。一个停了两周又启动的消费者，`lastSeq` 停在两周前 ——
 *     它会漏掉这两周的所有变更，**而且不会有任何报错**（`changesSince` 只是查不到行）。
 *     但那种情形下它本来就已经落后两周了（它的轮询也停了两周），裁剪只是让落后变成不可恢复。
 *     `store.refresh()` 的 `!built` 支把 `lastSeq` 对齐到当前水位，所以**重启不会**漏；
 *     会漏的只有"进程活着但轮询停了两周"，而那在 1s 定时器下意味着进程根本没在跑。
 *   · `keep` **不小于**任何一次暂停期间可能累积的变更数。暂停越久，这个数越大 ——
 *     所以它必须是配置（`CHANGE_LOG_KEEP_ROWS`），不是一个写死在代码里的"够大了"。
 *
 * 返回值是 `void` 而不是删除行数：调用方（维护定时器）只关心"跑没跑过"，
 * 而"删了多少"对这个表没有意义 —— 它随管理面的活跃度漂，不是健康指标。
 */
export function pruneChanges(db: Db, keep = 10_000): void {
  db.prepare(
    'DELETE FROM change_log WHERE seq <= (SELECT COALESCE(MAX(seq), 0) - ? FROM change_log)',
  ).run(keep);
}
