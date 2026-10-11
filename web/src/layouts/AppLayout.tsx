import { DownOutlined, LogoutOutlined, UserOutlined } from '@ant-design/icons';
import { App, Dropdown, Layout, Menu, Typography } from 'antd';
import type { MenuProps } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

import { authApi } from '@/api/endpoints';
import { SESSION_EXPIRED_EVENT } from '@/api/http';
import { useAction } from '@/api/hooks';
import { useSession } from '@/auth/AuthGate';
import { ConnectionBadge } from '@/components/ConnectionBadge';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useSupplierNav } from '@/layouts/useSupplierNav';
import { resetLiveData, startLive, stopLive } from '@/realtime/live';
import { findNavItem, navItems } from '@/router/nav';
import { tokens } from '@/theme/tokens';

const { Sider, Header, Content } = Layout;
const { Text } = Typography;

type MenuItem = NonNullable<MenuProps['items']>[number];

/**
 * 侧栏当前选中项。
 *
 * 「上游管理」是个子菜单，所以选中态要在**两级**之间决定：
 * - `/upstreams` → 选中分组头本身（全部供应商）；
 * - `/upstreams/new`、`/upstreams/:id` → 选中对应的子项（**供应商列表里的那一条**）；
 * - `/upstreams/:id/accounts` → 选中它所属的那个供应商子项（账号池是它的下钻，不是另一个上游）；
 * - 子项 key 对不上（上游刚被删、id 不在列表里）→ 退回分组头，不选一个不存在的项。
 *
 * 子项 key 由 `useSupplierNav` 从**真实列表**生成，所以这里只做纯字符串匹配，不猜。
 */
function resolveSelection(pathname: string, suppliers: readonly string[]): string {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'upstreams') return pathname;
  if (segments.length === 1) return '/upstreams';
  const child = segments[1] ?? '';
  if (child === 'new') return '/upstreams/new';
  // 账号池 `/upstreams/:id/accounts` 与详情同属一个供应商，高亮到它那一格。
  if (suppliers.includes(child)) return `/upstreams/${child}`;
  return '/upstreams';
}

export function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const session = useSession();
  const { modal } = App.useApp();
  const { run } = useAction();
  const suppliers = useSupplierNav();

  const current = useMemo(() => findNavItem(location.pathname), [location.pathname]);
  const selectedKey = useMemo(
    () => resolveSelection(location.pathname, suppliers.ids),
    [location.pathname, suppliers.ids],
  );

  /**
   * 子菜单展开态由我们控制：默认收起（Bo 要的是「点击下拉」），
   * 但一旦选中项落在「上游管理」里就自动展开 —— 否则直接打开 `/upstreams/:id`
   * 或刷新页面时，选中的那一条藏在收起的分组里，看起来像没选中。
   */
  const [openKeys, setOpenKeys] = useState<string[]>([]);
  useEffect(() => {
    if (!selectedKey.startsWith('/upstreams')) return;
    setOpenKeys((prev) => (prev.includes('/upstreams') ? prev : [...prev, '/upstreams']));
  }, [selectedKey]);

  // 实时通道只在受保护区域内开启：登录页不建连，退出登录立即断开并清帧。
  useEffect(() => {
    startLive();
    return () => {
      stopLive();
      resetLiveData();
    };
  }, []);

  // 会话失效（401 UNAUTHORIZED / SESSION_EXPIRED，含 WS 4401）统一跳登录。
  useEffect(() => {
    const onExpired = () => {
      stopLive();
      resetLiveData();
      navigate('/login', { replace: true, state: { from: location.pathname } });
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
    };
  }, [navigate, location.pathname]);

  const onLogout = () => {
    modal.confirm({
      title: '退出登录',
      content: '将清除当前会话并断开实时通道，需要重新登录。',
      okText: '退出',
      cancelText: '取消',
      onOk: async () => {
        await run('logout', () => authApi.logout());
        stopLive();
        resetLiveData();
        navigate('/login', { replace: true });
      },
    });
  };

  /**
   * 「上游管理」的子菜单：**添加供应商固定第一**，其后每个上游一条。
   * 加载中 / 失败只在末尾各占一行**置灰**说明，不伪造一个空列表。
   */
  const menuItems = useMemo<MenuItem[]>(
    () =>
      navItems.map((item) =>
        item.path === '/upstreams'
          ? {
              key: item.path,
              icon: item.icon,
              label: item.label,
              children: suppliers.children,
            }
          : { key: item.path, icon: item.icon, label: item.label },
      ),
    [suppliers.children],
  );

  return (
    <Layout style={{ minHeight: '100vh', background: 'transparent' }}>
      <Sider
        theme="dark"
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        width={tokens.layout.siderWidth}
        collapsedWidth={tokens.layout.siderCollapsedWidth}
        style={{
          background: tokens.color.bgSider,
          borderRight: `1px solid ${tokens.color.border}`,
          position: 'sticky',
          top: 0,
          height: '100vh',
          zIndex: 1,
        }}
      >
        <div
          style={{
            height: tokens.layout.headerHeight,
            display: 'flex',
            alignItems: 'center',
            gap: tokens.space.sm,
            padding: `0 ${tokens.space.lg}px`,
            color: tokens.color.textPrimary,
            fontWeight: 600,
            letterSpacing: '0.02em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          }}
        >
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: 2,
              background: tokens.color.primary,
              boxShadow: `0 0 12px ${tokens.color.primary}`,
              flex: 'none',
            }}
          />
          {collapsed ? null : <span>Gateway Console</span>}
        </div>

        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          openKeys={openKeys}
          onOpenChange={(keys) => setOpenKeys(keys as string[])}
          items={menuItems}
          onClick={({ key }) => {
            // 置灰的占位行（加载中 / 加载失败）不是路由，点了不跳。
            if (key.startsWith('/')) navigate(key);
          }}
          style={{ background: 'transparent', borderInlineEnd: 'none' }}
        />
      </Sider>

      <Layout style={{ background: 'transparent' }}>
        <Header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: tokens.space.md,
            borderBottom: `1px solid ${tokens.color.border}`,
            backdropFilter: 'blur(8px)',
            position: 'sticky',
            top: 0,
            zIndex: 2,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <Text strong style={{ fontSize: 14 }}>
              {current?.label ?? 'Gateway Console'}
            </Text>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.space.lg,
              flex: 'none',
            }}
          >
            <ConnectionBadge />
            <Dropdown
              trigger={['click']}
              menu={{
                items: [
                  {
                    key: 'account',
                    label: session?.username ?? '未知账号',
                    disabled: true,
                    icon: <UserOutlined />,
                  },
                  { type: 'divider' },
                  { key: 'logout', label: '退出登录', icon: <LogoutOutlined />, danger: true },
                ],
                onClick: ({ key }) => {
                  if (key === 'logout') onLogout();
                },
              }}
            >
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: tokens.space.sm,
                  cursor: 'pointer',
                  fontSize: 12,
                  color: tokens.color.textSecondary,
                  padding: '4px 8px',
                  borderRadius: tokens.radius.sm,
                }}
              >
                <UserOutlined />
                {session?.username ?? '—'}
                <DownOutlined style={{ fontSize: 10 }} />
              </span>
            </Dropdown>
          </div>
        </Header>

        <Content
          style={{
            padding: tokens.space.lg,
            position: 'relative',
            zIndex: 1,
          }}
        >
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </Content>
      </Layout>
    </Layout>
  );
}
