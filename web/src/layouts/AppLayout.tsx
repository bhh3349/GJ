import { DownOutlined, LogoutOutlined, UserOutlined } from '@ant-design/icons';
import { App, Dropdown, Layout, Menu, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

import { authApi } from '@/api/endpoints';
import { SESSION_EXPIRED_EVENT } from '@/api/http';
import { useAction } from '@/api/hooks';
import { useSession } from '@/auth/AuthGate';
import { ConnectionBadge } from '@/components/ConnectionBadge';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { resetLiveData, startLive, stopLive } from '@/realtime/live';
import { findNavItem, navItems } from '@/router/nav';
import { tokens } from '@/theme/tokens';

const { Sider, Header, Content } = Layout;
const { Text } = Typography;

export function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const session = useSession();
  const { modal } = App.useApp();
  const { run } = useAction();

  const current = useMemo(() => findNavItem(location.pathname), [location.pathname]);

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

  const selectedKey = current?.path ?? location.pathname;

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
          items={navItems.map((item) => ({
            key: item.path,
            icon: item.icon,
            label: item.label,
          }))}
          onClick={({ key }) => navigate(key)}
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
            {current ? (
              <Text type="secondary" style={{ marginLeft: tokens.space.sm, fontSize: 12 }}>
                {current.description}
              </Text>
            ) : null}
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
