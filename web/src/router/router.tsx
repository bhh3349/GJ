import { createBrowserRouter, Navigate } from 'react-router-dom';

import { AuthGate } from '@/auth/AuthGate';
import { AppLayout } from '@/layouts/AppLayout';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { lazyPage } from '@/router/lazyPage';
import { RouteErrorPage } from '@/pages/RouteErrorPage';

export const router = createBrowserRouter([
  {
    path: '/login',
    element: lazyPage(() => import('@/pages/LoginPage')),
  },
  {
    path: '/',
    // 契约 §0.5：/api/* 全量鉴权、无白名单例外 → 受保护区域统一先过会话校验。
    element: (
      <AuthGate>
        <AppLayout />
      </AuthGate>
    ),
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: lazyPage(() => import('@/pages/DashboardPage')) },
      { path: 'upstreams', element: lazyPage(() => import('@/pages/UpstreamsPage')) },
      { path: 'keys', element: lazyPage(() => import('@/pages/KeysPage')) },
      { path: 'groups', element: lazyPage(() => import('@/pages/GroupsPage')) },
      { path: 'models', element: lazyPage(() => import('@/pages/ModelsPage')) },
      { path: 'stats', element: lazyPage(() => import('@/pages/StatsPage')) },
      { path: 'logs', element: lazyPage(() => import('@/pages/LogsPage')) },
      // 契约 §13：助手页独立分包，不进 Dashboard 首屏、不加载 ECharts。
      { path: 'assistant', element: lazyPage(() => import('@/pages/assistant/AssistantPage')) },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
