import { ApiOutlined, BarChartOutlined, AppstoreOutlined, KeyOutlined } from '@ant-design/icons';
import type { ReactNode } from 'react';

/**
 * 消费面侧边导航 —— **刻意不是 `router/nav.tsx` 的第二份**。
 *
 * 管理面那 9 项一条都不属于普通用户：仪表盘是全站聚合（QPS / 全站余额），
 * 上游管理是 Base URL 与凭据，Key 管理能看到**所有** key，用户组是配额设置。
 * 把它们做成"同一份 navItems 加个 filter"会在两处留下同一个判断
 * （哪几项对 user 可见），而那个判断一旦漂移，侧边栏就会出现
 * "点了就 403"的入口 —— 比没有入口更坏。
 *
 * 所以这里是独立的一份，只放 §19 那几页 + 一个登出口。
 * 页面数量由契约 §19 决定，不由"顺手再加点啥"决定。
 *
 * v1.15.9 加了第四项「我的 key」（ADR-0038）：它是**独立的一页**而不是塞进
 * 「接入与 key」里，因为那一页管的是"怎么连上来"（地址 + 抄走 key），
 * 这一页管的是"我手上有哪几把 key、哪把给谁用"（签发 / 改名 / 吊销）。
 * 挤在一起会让两件事都变成半件事 —— 而那正是 v1.15.9 要修的那个毛病。
 */
export interface ConsoleNavItem {
  /** 绝对路径，同时也是 Menu 的 key */
  path: string;
  label: string;
  icon: ReactNode;
  /** 侧边栏下方的副标题：这一页管什么 */
  description: string;
}

export const consoleNavItems: readonly ConsoleNavItem[] = [
  {
    path: '/console',
    label: '接入与 key',
    icon: <ApiOutlined />,
    description: 'API 地址与本组的 key 掩码',
  },
  {
    path: '/console/keys',
    label: '我的 key',
    icon: <KeyOutlined />,
    description: '签发 / 改名 / 吊销自己的 key',
  },
  {
    path: '/console/usage',
    label: '我的用量',
    icon: <BarChartOutlined />,
    description: '本组的请求数、tokens 与错误',
  },
  {
    path: '/console/models',
    label: '模型广场',
    icon: <AppstoreOutlined />,
    description: '可以调用的模型列表',
  },
] as const;

/**
 * 找出当前路径属于哪一项。
 *
 * **取最长匹配，不是第一个匹配**（v1.15.9 修）。先前这里是
 * `consoleNavItems.find(前缀命中)`，而 `/console` 是**每一个**消费面路径的前缀 ——
 * 于是 `/console/usage` 命中的是「接入与 key」，侧栏高亮与顶栏那一句说明
 * 在除首页以外的所有页面上都是错的。v1.15.0–v1.15.8 一直如此，
 * 加了第四项「我的 key」时才发现（四项之间两两互为前缀的机会多了一层）。
 *
 * 判据必须是"最具体的那一项赢"：`=== path` 与 `startsWith(path + '/')` 都收，
 * 但只在**最长**的那个上落定。这样新增子路径（`/console/keys/:id` 之类）
 * 不需要动这个函数，也不需要依赖数组的书写顺序 ——
 * 依赖顺序的写法会在下一个人调整菜单顺序时静默失效（而这正是原来的形状）。
 *
 * （管理面那一份 `router/nav.tsx` 的 `findNavItem` 有同一个问题：
 * `/upstreams` 与 `/upstreams/new` 并存，靠的是"静态段优先"这条**路由**规则的
 * 类比推理，而不是同一处字面判据。本文件不趁机去改它 —— 那是另一个面的一次
 * 独立改动，混进来会让这次 v1.15.9 的验收范围失焦。）
 */
export function findConsoleNavItem(pathname: string): ConsoleNavItem | undefined {
  let best: ConsoleNavItem | undefined;
  for (const item of consoleNavItems) {
    if (pathname !== item.path && !pathname.startsWith(`${item.path}/`)) continue;
    if (best === undefined || item.path.length > best.path.length) best = item;
  }
  return best;
}
