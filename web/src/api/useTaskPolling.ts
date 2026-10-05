/**
 * 异步任务轮询 —— 契约 §5「不许做假进度条」。
 *
 * `POST /api/models/sync`、余额刷新等返回 `202 {taskId}`，真实进度只能来自
 * `GET /api/tasks/:id`。本 hook 只做一件事：按真实 `progress.done/total` 上报，
 * `total` 为 `null` 时就显示不确定进度（antd 的 indeterminate），绝不编造百分比。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { tasksApi } from './endpoints';
import type { Task } from './types';

const TERMINAL: readonly Task['status'][] = ['succeeded', 'failed'];

export interface TaskTracker {
  task: Task | null;
  taskId: string | null;
  error: unknown;
  running: boolean;
  /** 兼容 `ErrorState` 的重试入口：手动立即拉一次。 */
  refresh: () => void;
  start: (taskId: string) => void;
  clear: () => void;
}

export function useTaskPolling(
  onSettled?: (task: Task) => void,
  intervalMs = 1000,
): TaskTracker {
  const [taskId, setTaskId] = useState<string | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const settledRef = useRef<((task: Task) => void) | undefined>(onSettled);
  settledRef.current = onSettled;

  useEffect(() => {
    if (taskId === null) {
      setTask(null);
      setError(null);
      return;
    }

    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      try {
        const next = await tasksApi.get(taskId);
        if (!active) return;
        setTask(next);
        setError(null);
        if (TERMINAL.includes(next.status)) {
          settledRef.current?.(next);
          return;
        }
      } catch (reason) {
        if (!active) return;
        // 任务查询失败不吞掉，但也不再继续轮询，避免把浏览器打成重试风暴。
        setError(reason);
        return;
      }
      timer = setTimeout(() => {
        void tick();
      }, intervalMs);
    };

    void tick();

    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [taskId, intervalMs, nonce]);

  const start = useCallback((id: string) => {
    setTaskId(id);
    setTask(null);
    setError(null);
  }, []);

  const clear = useCallback(() => {
    setTaskId(null);
    setTask(null);
    setError(null);
  }, []);

  const refresh = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  const running = task !== null && !TERMINAL.includes(task.status);

  return { task, taskId, error, running, refresh, start, clear };
}
