/**
 * 消费面外壳 —— 管理面 `AppLayout` 的**对偶件，不是它的配置版**。
 *
 * 为什么不是一个 `<AppLayout role="user" />`：两者的差异不是"少几个菜单项"，
 * 而是三件结构性的事，塞进同一个组件就会变成满屏的条件分支：
 *
 * 1. **不订阅实时通道**（v1.15.2）。`WS /api/stats/live` 是管理面全局面通道，
 *    服务端对 `role=user` 一律回 4401（§19.1 / §7）。管理面的 `AppLayout`
 *    进来就 `startLive()`，消费面如果照做，用户每次进 `/console`
 *    都会撞一次 4401、被 `live.ts` 派发成"会话失效"弹回登录页 ——
 *    而他的会话好得很。**正解是别开这条连接**，不是开了再处理它的错误。
 * 2. **没有 `useSupplierNav`**。那个 hook 打 `upstreamsApi.list()`，
 *    对 `role=user` 是 403 —— 它会把侧边栏变成一条常驻的错误提示。
 * 3. **顶栏不显示管理面专有项**（余额总览之类的入口在管理面页里，这里没有）。
 *    顶栏右侧也**不再有账号菜单** —— 两个外壳都把它搬到了侧栏左下角（`AccountMenu`）。
 *
 * 另外：登出在两侧是同一个动作（同一个会话 cookie），但**壳层清理**不同
 * （管理面要断实时通道），所以 `onLogout` 仍各写一份传给 `AccountMenu` ——
 * 菜单本体（账号 / 切换工作区 / 修改密码 / 退出登录）是共享的同一份。
 */
import { Layout, Menu, Typography } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import { useMemo, useState } from 'react';

import { useAction } from '@/api/hooks';
import { authApi } from '@/api/endpoints';
import { AccountMenu } from '@/components/AccountMenu';
import { SidebarCollapseButton } from '@/components/SidebarCollapseButton';
import { findConsoleNavItem, consoleNavItems } from '@/pages/console/consoleNav';
import { tokens } from '@/theme/tokens';

const { Text } = Typography;

export function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { run } = useAction();
  const [collapsed, setCollapsed] = useState(false);

  const current = useMemo(() => findConsoleNavItem(location.pathname), [location.pathname]);

  const onLogout = () => {
    void run('logout', async () => {
      await authApi.logout();
      navigate('/login', { replace: true });
    });
  };

  return (
    <Layout style={{ minHeight: '100vh', background: 'transparent' }}>
      <Layout.Sider
        theme="dark"
        collapsible
        // 关掉 antd 底部那条通栏把手（与 `AppLayout` 同一条理由，见 `SidebarCollapseButton`），
        // 改用品牌行右侧的图标按钮；aside 不再带 `padding-bottom = 把手高度`，
        // 所以左下角的账号格可以**贴着底边**。
        trigger={null}
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
        {/* 侧栏一列三格：品牌（含收起按钮） / 菜单（吃剩余高度） / 用户按钮（贴底）。 */}
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              height: tokens.layout.headerHeight,
              flex: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: tokens.space.sm,
              // 折叠态只有 64px：一个「控」字 + 一个 28px 按钮，展开态那 24px 左内边距
              // 会把按钮挤出可视区（`overflow:hidden` 只裁不报错）。与 `AppLayout` 同一处理。
              padding: collapsed
                ? `0 ${tokens.space.xs}px`
                : `0 ${tokens.space.sm}px 0 ${tokens.space.lg}px`,
              color: tokens.color.textPrimary,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
            }}
          >
            <span>{collapsed ? '控' : '控制台'}</span>
            <SidebarCollapseButton collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
          </div>
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={current ? [current.path] : []}
            items={consoleNavItems.map((item) => ({
              key: item.path,
              icon: item.icon,
              label: item.label,
            }))}
            onClick={({ key }) => navigate(key)}
            style={{ background: 'transparent', borderInlineEnd: 'none', flex: 1, minHeight: 0, overflowY: 'auto' }}
          />
          {/*
            用户按钮：与 `AppLayout` 侧栏左下角**同一个组件**（Bo 的 1panel 观感要求两侧一致），
            菜单内容自动按角色收敛 —— 普通用户的"切换工作区"一块天然为空（见 `AccountMenu` 头注）。
            退出登出**不走这里**的 `onLogout`：消费面没有实时通道要断，与管理面外壳的
            结构差异留在各自文件里，`AccountMenu` 不替任何一边猜。
            把手没了，这一格该贴底（`padding` 四边同值，不再留 `0` 的底边）。
          */}
          <div
            style={{
              flex: 'none',
              borderTop: `1px solid ${tokens.color.border}`,
              padding: `${tokens.space.sm}px`,
            }}
          >
            <AccountMenu collapsed={collapsed} onLogout={onLogout} />
          </div>
        </div>
      </Layout.Sider>

      <Layout>
        <Layout.Header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: tokens.color.bgContainer,
            borderBottom: `1px solid ${tokens.color.border}`,
            paddingInline: tokens.space.lg,
            height: tokens.layout.headerHeight,
            position: 'sticky',
            top: 0,
            zIndex: 1,
          }}
        >
          <div>
            <Text strong style={{ fontSize: 14, color: tokens.color.textPrimary }}>
              {current?.label ?? '控制台'}
            </Text>
            {current ? (
              <Text type="secondary" style={{ fontSize: 12, marginInlineStart: tokens.space.md }}>
                {current.description}
              </Text>
            ) : null}
          </div>
          {/*
            **顶栏右侧空着是刻意的**：账号菜单已搬到侧栏左下角（`AccountMenu`，
            与 `AppLayout` 同一份）。这里不再放任何东西 —— 顶栏只回答"我在哪一页"。
          */}
        </Layout.Header>

        <Layout.Content
          style={{
            padding: tokens.space.lg,
            background: tokens.color.bgBase,
            minHeight: `calc(100vh - ${tokens.layout.headerHeight}px)`,
          }}
        >
          {children}
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
