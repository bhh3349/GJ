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
