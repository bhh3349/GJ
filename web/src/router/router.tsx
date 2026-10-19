import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router-dom';

import { AuthGate, useSession } from '@/auth/AuthGate';
import { AppLayout } from '@/layouts/AppLayout';
import { ConsoleLayout } from '@/layouts/ConsoleLayout';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { lazyPage } from '@/router/lazyPage';
import { RouteErrorPage } from '@/pages/RouteErrorPage';
import { workspaceOf } from '@/router/workspaces';

/**
 * 工作区外壳（§19 / ADR-0034 决策 4）。
 *
 * **两层判据，别把它们混成一层**：
 *
 * 1. **`role=user` 恒在用户中心**。他手打一个管理面路径（`/dashboard`）时
 *    不该看到管理面外壳 —— 那个外壳进来就打 `upstreamsApi.list()`，对他是 403，
 *    于是"输错一个 URL"变成一屏报错。路由把它送去 `/console`（由 `HomeRoute`
 *    / `NotFoundRoute` 兜底），这里则保证任何路径下渲染的都是用户中心外壳。
 *
 * 2. **`role=admin` 按路径**选外壳：`/console/*` 是用户中心，其余是管理中心。
 *    这条正是「切换工作区」的落点 —— 1panel 的切换换的是**整套侧栏**，
 *    不是只有一个内容区变色。管理员进用户中心看到的是普通用户眼中的样子
 *    （同一份只读数据、同一套导航），这既是观感等价物，也是**自查手段**：
 *    他能立刻看到"我的组成员到底能看到什么"。
 *
 * 这两层**都不是授面**。真正的边界在服务端（§19.1 的前缀闸门）：
 * `role=user` 打 `/api/upstreams` 照样 403，前端做得再好也挡不住 `fetch(...)`。
 * 这里只做"别把人送进一个他每条请求都会失败的界面"。
 *
 * 两个 Layout 各自渲染 `<Outlet />`（`ConsoleLayout` 收 children，故显式传），
 * 所以这里只负责**选哪个**，不重复渲染内容。
 */
function Workspace() {
  const session = useSession();
  const location = useLocation();
  const role = session?.role ?? 'admin';

  if (role === 'user' || workspaceOf(location.pathname) === 'console') {
    return (
      <ConsoleLayout>
        <Outlet />
      </ConsoleLayout>
    );
  }
  return <AppLayout />;
}

/** 管理面专属路径对 `role=user` 的重定向目标。 */
const CONSOLE_HOME = '/console';

/**
 * 兜底路由：管理面 404 页 / 消费面重定向。
 *
 * `role=user` 一律送去 `/console`，**不显示**管理面的 NotFoundPage ——
 * 那个页面的文案与链接全是管理面的，对普通用户是一屏废话。
 * 注意这不是授面（见 `Workspace` 的注释）：他真的打 `/api/upstreams`
 * 照样拿服务端的 403，这里只是不让他在自己的界面里迷路。
 */
function NotFoundRoute() {
  const session = useSession();
  if (session?.role === 'user') return <Navigate to={CONSOLE_HOME} replace />;
  return <NotFoundPage />;
}

/** 根路径按角色分流：管理员看仪表盘，普通用户看消费面首页。 */
function HomeRoute() {
  const session = useSession();
  return <Navigate to={session?.role === 'user' ? CONSOLE_HOME : '/dashboard'} replace />;
}

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
        <Workspace />
      </AuthGate>
    ),
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <HomeRoute /> },
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
      // 用户管理独立分包：管理面里最少被点开的一页（建号是一次性动作），
      // 而它引用的两个弹窗（口令一次性展示）不进任何公共 chunk。
      { path: 'users', element: lazyPage(() => import('@/pages/UsersPage')) },
      { path: 'models', element: lazyPage(() => import('@/pages/ModelsPage')) },
      { path: 'stats', element: lazyPage(() => import('@/pages/StatsPage')) },
      { path: 'logs', element: lazyPage(() => import('@/pages/LogsPage')) },
      // 接入信息独立分包：一屏读部署自报口径，不进 Dashboard 首屏。
      { path: 'access', element: lazyPage(() => import('@/pages/access/AccessInfoPage')) },
      // 助手页独立分包，不进 Dashboard 首屏、不加载 ECharts。
      { path: 'assistant', element: lazyPage(() => import('@/pages/assistant/AssistantPage')) },

      // ── §19 消费面（`role=user`）──────────────────────────────────────────
      /*
        四条路由全部**懒加载**：`role=admin` 的会话永远不会下载这四个 chunk。
        消费面与管理面共用一份产物（同源、同端口，ADR-0034 决策 4），
        所以分包是唯一的隔离手段 —— 不是性能优化，是别让管理面的代码
        进到普通用户的浏览器里。
      */
      { path: 'console', element: lazyPage(() => import('@/pages/console/ConsoleAccessPage')) },
      // v1.15.9 / ADR-0038：自助 key 管理独立分包 —— 它是消费面里唯一有写操作的一页，
      // 也是唯一会渲染明文弹窗的一页，不该让"只想看看地址"的用户下载它。
      { path: 'console/keys', element: lazyPage(() => import('@/pages/console/ConsoleKeysPage')) },
      { path: 'console/usage', element: lazyPage(() => import('@/pages/console/ConsoleUsagePage')) },
      { path: 'console/models', element: lazyPage(() => import('@/pages/console/ConsoleModelsPage')) },

      /*
        兜底路由按角色分开：`role=user` 输错管理面路径时，看到的应该是
        "去消费面"的引导，不是管理面那个 404（那个页面上没有任何他能点的东西）。
        管理员反之。两者都不该看到对方的界面空壳。
      */
      { path: '*', element: <NotFoundRoute /> },
    ],
  },
]);
