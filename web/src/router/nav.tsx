import {
  AppstoreOutlined,
  BarChartOutlined,
  CloudServerOutlined,
  DashboardOutlined,
  FileTextOutlined,
  KeyOutlined,
  RobotOutlined,
  TeamOutlined,
  UserSwitchOutlined,
  ApiOutlined,
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
    // 「上游管理」是个可展开的分组：子项 = 添加供应商（固定第一）+ 每个上游一条。
    // 子项由 `layouts/useSupplierNav` 按真实列表生成，这里只给分组头。
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
    // 「谁在用什么身份登录」。放在「用户组」后面：两页强相关（一个组下挂着
    // 若干用户），而这一页的多数操作都发生在刚建完组之后。
    path: '/users',
    label: '用户管理',
    icon: <UserSwitchOutlined />,
    description: '建普通用户账号、分配归属组',
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
    path: '/access',
    label: '接入信息',
    icon: <ApiOutlined />,
    description: 'Base URL、后台地址与调用密钥入口',
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
