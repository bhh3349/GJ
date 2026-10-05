/**
 * 数据获取与写操作的两个基础 hook。
 *
 * 硬约束落地：
 * - **禁止假数据** —— 数据只来自真实端点；加载中不预先展示任何占位数字。
 * - **所有操作有 loading/成功/失败反馈** —— 读走 `useResource.loading/refreshing`，
 *   写走 `useAction.run`（自带成功/失败 message）。
 * - 请求失败后**保留上一次成功的数据**并附带错误，避免把已加载的表格整屏打成空白。
 */
import { App } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';

import { describeError, isApiError } from './http';

export interface Resource<T> {
  data: T | null;
  error: unknown;
  /** 首次加载（尚无数据）。 */
  loading: boolean;
  /** 已有数据时的重新拉取，UI 保留旧数据。 */
  refreshing: boolean;
  /** 重新拉取；用于错误重试与写操作后的刷新。 */
  reload: () => void;
  /** 写操作成功后就地更新本地数据，避免整表重拉。 */
  mutate: (updater: (prev: T | null) => T | null) => void;
}

/**
 * 读资源。
 * `deps` 变化即重新拉取；卸载/参数变化会 abort 掉在途请求，避免竞态写回。
 * 401（UNAUTHORIZED / SESSION_EXPIRED）由 http 层统一派发事件跳登录，这里不吞不拦。
 */
export function useResource<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): Resource<T> {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [nonce, setNonce] = useState(0);
  const loadedOnceRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    if (loadedOnceRef.current) setRefreshing(true);
    else setLoading(true);
    setError(null);

    loaderRef.current(controller.signal).then(
      (value) => {
        if (!active) return;
        loadedOnceRef.current = true;
        setData(value);
        setError(null);
        setLoading(false);
        setRefreshing(false);
      },
      (reason: unknown) => {
        if (!active || controller.signal.aborted) return;
        setError(reason);
        setLoading(false);
        setRefreshing(false);
      },
    );

    return () => {
      active = false;
      controller.abort();
    };
    // deps 由调用方保证长度稳定（参数元组）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  const mutate = useCallback((updater: (prev: T | null) => T | null) => {
    setData((prev) => updater(prev));
  }, []);

  return { data, error, loading, refreshing, reload, mutate };
}

export interface Action {
  /**
   * 执行写操作。成功给 `success` 提示，失败按契约错误码给可读提示并返回 `null`。
   * 返回 `null` 即表示失败——调用方据此决定是否关闭弹窗/刷新列表。
   */
  run: <T>(key: string, fn: () => Promise<T>, success?: string) => Promise<T | null>;
  /** 当前在途操作的 key（用于按钮 loading 与禁用）。 */
  pending: string | null;
  isPending: (key: string) => boolean;
}

/**
 * 写操作。`key` 用于区分同页并发的多个动作（如逐行「启用」按钮）。
 * 失败时**不吞错误**：除了 message 提示，还会返回 null 让调用方保持弹窗打开、保留用户输入。
 */
export function useAction(): Action {
  const { message } = App.useApp();
  const [pending, setPending] = useState<string | null>(null);

  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<T>, success?: string): Promise<T | null> => {
      setPending(key);
      try {
        const result = await fn();
        if (success) message.success(success);
        return result;
      } catch (error) {
        const { code, message: text } = describeError(error);
        // 401 会由 http 层跳登录，这里不再重复弹窗打扰。
        const isSessionIssue =
          isApiError(error) && (error.code === 'UNAUTHORIZED' || error.code === 'SESSION_EXPIRED');
        if (!isSessionIssue) {
          const detail =
            isApiError(error) && error.details && typeof error.details === 'object'
              ? `（${JSON.stringify(error.details)}）`
              : '';
          message.error(`${text}${detail} [${code}]`);
        }
        return null;
      } finally {
        setPending((current) => (current === key ? null : current));
      }
    },
    [message],
  );

  const isPending = useCallback((key: string) => pending === key, [pending]);

  return { run, pending, isPending };
}
