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
