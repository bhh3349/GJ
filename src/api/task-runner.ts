// 异步任务执行器。契约 §5：模型同步 / 余额刷新不阻塞 HTTP，前端轮询 /api/tasks/:id。
//
// 它只做一件事：把"建任务 → 跑 → 推进度 → 收尾"这条容易写漏的流程固化下来。
// 所有分支（成功、抛错、抛非 Error）都必须落到一个终态 ——
// 一个永远停在 running 的任务，在前端就是一个永远转的圈。
//
// 进度**只由真正干活的代码推进**（契约明令"不许做假进度条"），
// 这里给的 step() 是给调用方在每处理完一项后调用的，不提供定时器式假进度。

import type { Db } from '../db/database.js';
import type { TaskDto } from './dto.js';
import { createTask, finishTask, markRunning, setProgress } from '../db/repo/tasks.js';

export interface TaskReporter {
  readonly id: string;
  setTotal(total: number): void;
  /** 推进已完成数；省略则 +1 */
  step(done?: number): void;
  note(message: string | null): void;
}

export function startTask<T>(
  db: Db,
  type: string,
  total: number,
  work: (reporter: TaskReporter) => Promise<T>,
): TaskDto {
  const task = createTask(db, type, total);

  const reporter: TaskReporter = {
    id: task.id,
    setTotal: (n) => setProgress(db, task.id, 0, n),
    step: (done) => {
      if (done === undefined) {
        const row = db.prepare('SELECT progress_done FROM tasks WHERE id = ?').get(task.id) as
          | { progress_done: number }
          | undefined;
        setProgress(db, task.id, (row?.progress_done ?? 0) + 1);
      } else {
        setProgress(db, task.id, done);
      }
    },
    note: () => {
      /* message 只在终态写入：任务中途的消息没人能读到（前端 1s 轮询才拿得到），
         写进去只会让 tasks 表多出一堆无人消费的中间态字符串。 */
    },
  };

  // 让出当前 tick：先把 202 {taskId} 回给客户端，再开始干活。
  // 否则同步部分的工作会拖慢响应，异步任务的意义就没了。
  setImmediate(() => {
    markRunning(db, task.id);
    void work(reporter)
      .then((result) => {
        finishTask(db, task.id, 'succeeded', { result: result ?? null });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        finishTask(db, task.id, 'failed', { message });
      });
  });

  return task;
}
