/**
 * 「工作区」—— 同一套产物、同一个会话下的两个并列界面（§19 / ADR-0034 决策 4）。
 *
 * 这份常量是**切换菜单的唯一事实源**：`AppLayout`（管理中心）与 `ConsoleLayout`
 * （用户中心）都从这里取条目，各自只决定"往哪渲染"。抄成两份的失败形状是
 * 菜单里写着一个路由表里不存在的路径 —— 点了跳 404，而不看两边源码看不出。
 *
 * 三个判据：
 * 1. **工作区 ≠ 授权**。切换只是换一套界面，真正的边界在服务端前缀闸门
 *    （§19.1：`role=user` 打 `/api/*` 一律 403）。所以「管理中心」这一项对
 *    `role=user` **不展示** —— 不是前端挡住他，是不给他指一条他每条请求都会 403 的路。
 * 2. **同一会话，不重新登录**。切换就是 `navigate(另一个首页)`，不碰 cookie。
 * 3. **不缓存**。当前工作区由 `location.pathname` 现算（见 `workspaceOf`），
 *    不存 state —— 存了就会在浏览器前进/后退后与地址栏对不上。
 */

/** 两个工作区的首页（也是切换菜单的目标路径）。 */
export const WORKSPACE_HOME = {
  admin: '/dashboard',
  console: '/console',
} as const;

/**
 * 判断当前路径属于哪个工作区。
 *
 * 判据只有一条前缀：`/console` 及其下钻都是用户中心，其余都是管理中心。
 * 这与 `router.tsx` 里 `Workspace()` 选 Layout 的判据**必须同源** ——
 * 两处各判一次、判据一旦漂移，就会出现"选中的菜单项说你在用户中心、
 * 渲染出来的却是管理面侧栏"这种自相矛盾的界面。
 */
export function workspaceOf(pathname: string): 'admin' | 'console' {
  return pathname === WORKSPACE_HOME.console || pathname.startsWith(`${WORKSPACE_HOME.console}/`)
    ? 'console'
    : 'admin';
}

/** 切换菜单里的一项。 */
export interface WorkspaceSwitchItem {
  /** 目标路径，同时也是 Menu 的 key */
  path: string;
  label: string;
}

/** 已构造好、可直接塞进 antd `Menu.items` 的一项（`key`/`label` 都非空）。 */
export interface WorkspaceSwitchMenuItem {
  key: string;
  label: string;
}

/**
 * 构造「切换工作区」子菜单。
 *
 * 只列出**当前账号真能去**的工作区，并**跳过当前所在的那个** ——
 * 菜单里留一条"点了不动"的项（1panel 是把它置灰）会让"我到底在哪个工作区"
 * 这个问题变成要试一次才知道。少列一条，答案就在菜单本身里。
 *
 * `role=user` 只会得到 `[]`（他本来就在用户中心、且进不去管理中心），
 * 调用方据此**整块不渲染**这个子菜单，而不是渲染一个空壳。
 */
export function workspaceSwitchItems(
  role: 'admin' | 'user',
  current: 'admin' | 'console',
): WorkspaceSwitchItem[] {
  const items: WorkspaceSwitchItem[] = [];
  if (role === 'admin' && current !== 'admin') {
    items.push({ path: WORKSPACE_HOME.admin, label: '管理中心' });
  }
  if (current !== 'console') {
    items.push({ path: WORKSPACE_HOME.console, label: '用户中心' });
  }
  return items;
}
