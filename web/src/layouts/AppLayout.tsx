import { Layout, Menu, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

import { SESSION_EXPIRED_EVENT } from '@/api/http';
import { ConnectionBadge } from '@/components/ConnectionBadge';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { findNavItem, navItems } from '@/router/nav';
import { tokens } from '@/theme/tokens';

const { Sider, Header, Content } = Layout;
const { Text } = Typography;

export function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  const current = useMemo(() => findNavItem(location.pathname), [location.pathname]);

  // 会话失效（401 UNAUTHORIZED / SESSION_EXPIRED）统一跳登录。
  useEffect(() => {
    const onExpired = () => {
      navigate('/login', { replace: true, state: { from: location.pathname } });
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
    };
  }, [navigate, location.pathname]);

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
          <ConnectionBadge />
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
