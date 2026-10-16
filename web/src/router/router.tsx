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
    // 受保护区域统一先过会话校验。
    element: (
      <AuthGate>
        <AppLayout />
      </AuthGate>
    ),
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: lazyPage(() => import('@/pages/DashboardPage')) },
      /*
        「上游管理」是一组页面，不是一页：
        - `/upstreams`           全部供应商（列表 + 就地增删改，老入口不动）
        - `/upstreams/new`       添加供应商（侧栏子菜单固定第一条；新增表单的唯一实现在这里打开）
        - `/upstreams/:id`       某个供应商的专属页（概览 / key 列表 / 套餐台账）
        - `/upstreams/:id/accounts` 账号池（供应商账号型才有内容，独立分包）

        `/upstreams/new` 与 `/upstreams/:id` 是**静态段 vs 动态段**：react-router 按段打分，
        静态 `new` 恒优先，所以两条同时命中时不会把 `new` 当成一个上游 id。
        `findNavItem` 按前缀命中 ⇒ 这四条都高亮侧栏的「上游管理」。
      */
      { path: 'upstreams', element: lazyPage(() => import('@/pages/UpstreamsPage')) },
      { path: 'upstreams/new', element: lazyPage(() => import('@/pages/upstreams/SupplierCreatePage')) },
      // 供应商专属页独立分包 —— 通用上游的用户只在列表页就地编辑，不进这里。
      {
        path: 'upstreams/:id',
        element: lazyPage(() => import('@/pages/upstreams/SupplierDetailPage')),
      },
      // 账号池再拆一层：只有供应商账号型的用户才会点进来。
      {
        path: 'upstreams/:id/accounts',
        element: lazyPage(() => import('@/pages/upstreams/SupplierAccountsPage')),
      },
      { path: 'keys', element: lazyPage(() => import('@/pages/KeysPage')) },
      { path: 'groups', element: lazyPage(() => import('@/pages/GroupsPage')) },
      { path: 'models', element: lazyPage(() => import('@/pages/ModelsPage')) },
      { path: 'stats', element: lazyPage(() => import('@/pages/StatsPage')) },
      { path: 'logs', element: lazyPage(() => import('@/pages/LogsPage')) },
      // 接入信息独立分包：一屏读部署自报口径，不进 Dashboard 首屏。
      { path: 'access', element: lazyPage(() => import('@/pages/access/AccessInfoPage')) },
      // 助手页独立分包，不进 Dashboard 首屏、不加载 ECharts。
      { path: 'assistant', element: lazyPage(() => import('@/pages/assistant/AssistantPage')) },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
