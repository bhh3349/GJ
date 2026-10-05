/**
 * 会话守卫。
 *
 * 契约 §0.5：`/api/*` 除 `POST /api/auth/login` 外全量鉴权，没有白名单例外。
 * 所以受保护区域进来第一件事就是 `GET /api/auth/session`：
 * - 通过 → 把会话信息放进 Context，供顶栏显示账号；
 * - 401 `UNAUTHORIZED` → 跳登录页（带上来源路径，登录后回跳）；
 * - 其它错误（管理面未启动等）→ 全屏错态 + 重试，**不**把用户甩到登录页假装是密码问题。
 */
import { createContext, useContext, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { authApi } from '@/api/endpoints';
import { useResource } from '@/api/hooks';
import { isApiError } from '@/api/http';
import type { SessionInfo } from '@/api/types';
import { ErrorState, LoadingState } from '@/components/states/StateBlock';

const SessionContext = createContext<SessionInfo | null>(null);

/** 当前会话。仅在 `<AuthGate>` 内非空。 */
export function useSession(): SessionInfo | null {
  return useContext(SessionContext);
}

export function AuthGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { data, error, loading, reload } = useResource(() => authApi.session(), []);

  if (loading) {
    return <LoadingState tip="正在校验会话…" minHeight={420} />;
  }

  if (error) {
    if (isApiError(error) && (error.code === 'UNAUTHORIZED' || error.code === 'SESSION_EXPIRED')) {
      return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    }
    return <ErrorState error={error} onRetry={reload} variant="page" title="无法连接管理面" />;
  }

  return <SessionContext.Provider value={data}>{children}</SessionContext.Provider>;
}
