import { App, Layout, Menu, Typography } from 'antd';
import type { MenuProps } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

import { authApi } from '@/api/endpoints';
import { SESSION_EXPIRED_EVENT } from '@/api/http';
import { useAction } from '@/api/hooks';
import { AccountMenu } from '@/components/AccountMenu';
import { ConnectionBadge } from '@/components/ConnectionBadge';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { SidebarCollapseButton } from '@/components/SidebarCollapseButton';
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
        // 关掉 antd 底部那条通栏把手（Bo 说的"一整条"），改用品牌行右侧的图标按钮 ——
        // 组件与理由见 `SidebarCollapseButton`。`trigger={null}` 同时让 `aside` 不再带
        // `padding-bottom = 把手高度`，所以左下角的账号格可以**贴着底边**，不再悬空一截。
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
        {/*
          侧栏内容排成**一列三格**：品牌 / 菜单（吃满剩余高度，自身可滚） / 用户按钮（钉死在底）。
          `height:'100%'` 是对 antd 的 `-children` 取的；把手已由 `trigger={null}` 关掉，
          aside 不再有那条 `padding-bottom`，所以账号格贴着底边、菜单的滚动区也多了把手那一截。
        */}
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              height: tokens.layout.headerHeight,
              flex: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: tokens.space.sm,
              // 折叠态只有 64px：品牌点 + 按钮一共 44px，左侧 24px 的展开态内边距会把按钮挤出去
              // （`overflow:hidden` 会把它**裁掉**而不是报错 —— 一个看不见的按钮）。
              padding: collapsed
                ? `0 ${tokens.space.xs}px`
                : `0 ${tokens.space.sm}px 0 ${tokens.space.lg}px`,
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
            {/*
              收起按钮挂品牌行右侧（agent web 端的通行位置，Bo 指定）：
              折叠态品牌名消失，它靠 `marginInlineStart:auto` 独占一行居中。
            */}
            <SidebarCollapseButton collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
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
            style={{ background: 'transparent', borderInlineEnd: 'none', flex: 1, minHeight: 0, overflowY: 'auto' }}
          />

          {/*
            用户按钮：从顶栏搬到**侧栏左下角**（1panel 那种，Bo 的要求）。
            它是**会话级**入口 —— 与"当前在看哪一页"无关，所以钉在侧栏上而不是放在某一页里。
            菜单项与顶栏那一版逐条相同（同一个 `AccountMenu`，只换长相），登出仍走本页
            `onLogout`：管理面退出要顺带断掉实时通道，那是外壳的结构职责。
            底部留白用 `paddingBottom` 而不是 `padding: '… 0'`：把手没了，这一格该贴底。
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
          {/*
            顶栏只留连接状态。**账号菜单已搬到侧栏左下角**（`AccountMenu`，见上面 Sider 里那一格）——
            这里刻意不再留一份："同一个入口在两个地方"会立刻带来"两份状态、两个漂移点"
            （改密码弹窗的开关就是其中一份），而 Bo 要的是 1panel 那种左下角。
          */}
          <div style={{ flex: 'none' }}>
            <ConnectionBadge />
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
