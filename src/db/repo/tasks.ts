// 异步任务表。契约 §5。
//
// 存在的理由：模型同步、余额刷新要去打上游，可能慢到秒级。
// 契约明确「不许做假进度条」——所以进度必须是后端真实写入的数字，
// 前端只是把它读出来画。因此 progress 只由真正干活的任务体推进。

import type { TaskDto, TaskStatus } from '../../api/dto.js';
import { nowIso } from '../../util/time.js';
import type { Db } from '../database.js';
import { newId } from '../ids.js';

interface TaskRow {
  id: string;
  type: string;
  status: TaskStatus;
  progress_done: number;
  progress_total: number;
  message: string | null;
  result: string | null;
  started_at: string;
  finished_at: string | null;
}

function toDto(row: TaskRow): TaskDto {
  let result: unknown = null;
  if (row.result !== null) {
    try {
      result = JSON.parse(row.result) as unknown;
    } catch {
      result = null;
    }
  }
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    progress: { done: row.progress_done, total: row.progress_total },
    message: row.message,
    result,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function createTask(db: Db, type: string, total: number): TaskDto {
  const id = newId('task');
  const at = nowIso();
  db.prepare(
    `INSERT INTO tasks (id, type, status, progress_done, progress_total, message, result, started_at, finished_at)
     VALUES (?, ?, 'queued', 0, ?, NULL, NULL, ?, NULL)`,
  ).run(id, type, total, at);
  const task = getTask(db, id);
  if (!task) throw new Error('创建任务后读取失败');
  return task;
}

export function getTask(db: Db, id: string): TaskDto | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  return row ? toDto(row) : null;
}

/**
 * 实时通道用：在跑的 + 刚结束的任务。
 *
 * 为什么要带上"刚结束的"：契约 §7 的 `task` 帧是在**进度变化时**推的，
 * 只查 `queued/running` 的话，任务走到终态那一帧永远发不出去 ——
 * 前端会看到一个永远停在 87% 的进度条，而这正是"假进度"的另一种形态。
 * 窗口取 1 分钟：足够让在线客户端收到终态，又不至于让新连进来的客户端
 * 把十分钟前的老任务当新闻重放一遍。
 */
export function listLiveTasks(db: Db, finishedWithinSeconds = 60): TaskDto[] {
  const since = new Date(Date.now() - finishedWithinSeconds * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM tasks
       WHERE status IN ('queued','running')
          OR (finished_at IS NOT NULL AND finished_at >= ?)
       ORDER BY started_at, id`,
    )
    .all(since) as TaskRow[];
  return rows.map(toDto);
}

export function markRunning(db: Db, id: string, total?: number): void {
  if (total === undefined) {
    db.prepare(`UPDATE tasks SET status = 'running' WHERE id = ? AND status = 'queued'`).run(id);
  } else {
    db.prepare(`UPDATE tasks SET status = 'running', progress_total = ? WHERE id = ?`).run(total, id);
  }
}

export function setProgress(db: Db, id: string, done: number, total?: number): void {
  if (total === undefined) {
    db.prepare('UPDATE tasks SET progress_done = ? WHERE id = ?').run(done, id);
  } else {
    db.prepare('UPDATE tasks SET progress_done = ?, progress_total = ? WHERE id = ?').run(done, total, id);
  }
}

export function finishTask(
  db: Db,
  id: string,
  status: 'succeeded' | 'failed',
  opts: { message?: string | null; result?: unknown } = {},
): void {
  db.prepare(
    `UPDATE tasks SET status = ?, message = ?, result = ?, finished_at = ?,
                      progress_done = CASE WHEN ? = 'succeeded' THEN progress_total ELSE progress_done END
     WHERE id = ?`,
  ).run(
    status,
    opts.message ?? null,
    opts.result === undefined ? null : JSON.stringify(opts.result),
    nowIso(),
    status,
    id,
  );
}

/**
 * 保留策略：删掉**已终态**且 `finished_at` 早于 `retentionDays` 天前的任务行。
 *
 * 两个谓词都不能省：
 *
 * 1. **`finished_at IS NOT NULL`** —— 在跑的（`queued` / `running`）任务没有 `finished_at`，
 *    一个都没写。少了它，`finished_at < cutoff` 对它们恒为假（SQL 的 NULL 比较），
 *    所以这条**现在**恰好是安全的；但那是撞上的，不是设计出来的。
 *    2026-10-16 用变异验证把这句话钉死了：整条谓词删掉，`retention.spec.ts` 的那条
 *    "在跑的任务无论多老都不删"**依然绿**（NULL 比较兜住了）；但把谓词换成注释里点名的
 *    那次"优化"—— `COALESCE(finished_at, started_at)` —— 同一条**立刻红**。
 *    也就是说它拦的是"有人嫌 NULL 比较别扭、补一个 started_at 兜底"那一次改写，
 *    而那一次会让在跑的任务按开始时间被无声删掉，`getTask` 开始给轮询的前端回 404。
 *    显式写出来，是为了让"只删终态"成为判据而不是巧合。
 *
 * 2. **`< cutoff`**（不是 `<=`）：与 `pruneLogs` / `pruneAudit` / 三个快照 prune 逐字一致。
 *
 * 删了之后**没有级联**：`tasks` 没有子表，`GET /api/tasks/:id` 对已删的 id 回 404 ——
 * 那是正确语义（"这个作业记录已经不在保留期内了"），不是数据丢失。
 */
export function pruneTasks(db: Db, retentionDays: number, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  return db.prepare('DELETE FROM tasks WHERE finished_at IS NOT NULL AND finished_at < ?').run(cutoff).changes;
}
