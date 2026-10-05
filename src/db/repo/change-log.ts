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

export type ChangeEntity = 'upstream' | 'key' | 'group' | 'gateway_key' | 'model' | 'balance';
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

/** 保留最近 N 条，防止表无限增长（它只是广播信道，不是审计）。 */
export function pruneChanges(db: Db, keep = 10_000): void {
  db.prepare(
    'DELETE FROM change_log WHERE seq <= (SELECT COALESCE(MAX(seq), 0) - ? FROM change_log)',
  ).run(keep);
}
