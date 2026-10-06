import {
  AppstoreOutlined,
  BarChartOutlined,
  CloudServerOutlined,
  DashboardOutlined,
  FileTextOutlined,
  KeyOutlined,
  RobotOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import type { ReactNode } from 'react';

export interface NavItem {
  /** 绝对路径，同时也是 Menu 的 key */
  path: string;
  label: string;
  icon: ReactNode;
  /** 顶栏副标题，说明这页管什么 */
  description: string;
}

/** 侧边导航 = 路由表的唯一来源，新增页面只改这里 + pages/ 下一个文件。 */
export const navItems: readonly NavItem[] = [
  {
    path: '/dashboard',
    label: '仪表盘',
    icon: <DashboardOutlined />,
    description: 'QPS、成功率、余额总览、key 健康状态',
  },
  {
    path: '/upstreams',
    label: '上游管理',
    icon: <CloudServerOutlined />,
    description: 'Base URL 与上游凭据的增删改',
  },
  {
    path: '/keys',
    label: 'Key 管理',
    icon: <KeyOutlined />,
    description: '分类标签、余额显示、启用与禁用',
  },
  {
    path: '/groups',
    label: '用户组',
    icon: <TeamOutlined />,
    description: '建组、发 key、配额设置',
  },
  {
    path: '/models',
    label: '模型档案',
    icon: <AppstoreOutlined />,
    description: '模型类型、支持能力、价格、可用 key',
  },
  {
    path: '/stats',
    label: '统计',
    icon: <BarChartOutlined />,
    description: '按 key / 上游 / 用户组 / 时间的用量聚合',
  },
  {
    path: '/logs',
    label: '日志',
    icon: <FileTextOutlined />,
    description: '调用记录查询（保留 30 天）',
  },
  {
    path: '/assistant',
    label: '内置助手',
    icon: <RobotOutlined />,
    description: '读观测面数据定位故障，对话不保存',
  },
] as const;

export function findNavItem(pathname: string): NavItem | undefined {
  return navItems.find((item) => pathname === item.path || pathname.startsWith(`${item.path}/`));
}
