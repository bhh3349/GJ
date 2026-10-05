import { createBrowserRouter, Navigate } from 'react-router-dom';

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
    element: <AppLayout />,
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
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
