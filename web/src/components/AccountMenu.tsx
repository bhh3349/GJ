/**
 * 账号菜单 —— 两个外壳（管理面 `AppLayout` / 消费面 `ConsoleLayout`）**共用同一份**。
 *
 * **为什么抽出来**：在 v1.15.11 之前这段 UI 在两个 Layout 里各抄了一份，而两份的内容
 * 是**同一条会话事实**（账号名 / 切换工作区 / 修改密码 / 退出登录）。位置一改就要改两处，
 * 改漏一处的失败形状是"管理面在左下角、消费面还在右上角"——看单边源码看不出来。
 * 放在 `components/` 而不是 `layouts/`：它不含任何管理面内容（只有 antd + `authApi`），
 * 所以消费面的 chunk 引它不会顺带拉进管理面代码（`ConsoleLayout` 头注那条分包纪律）。
 *
 * 两处**刻意留在外壳**、没有搬进来：
 * 1. **登出入口**（`onLogout`）。管理面的退出要顺带 `stopLive()` + `resetLiveData()`
 *    并弹确认框，消费面没有实时通道要断 —— 那是外壳的结构差异，不是 UI 差异。
 * 2. **挂载位置**。本组件只描述"按钮长什么样、菜单里有什么"，由外壳决定放在哪。
 *
 * 只有一个长相（侧栏左下角整块按钮，1panel 那种）：原先顶栏那版已随本次改动消失，
 * 所以这里**不留 `variant` 开关** —— 一个没有第二个调用方的变体是"将来可能会用"的代码，
 * 而它的真实代价是两条会长歪的渲染分支。
 *
 * 「切换工作区」只列出**当前账号真能去**的工作区，并由 `workspaceSwitchItems` 跳过当前所在
 * 的那一个 —— 那是 `router/workspaces.ts` 的判据，这里不重写一份（§19 / ADR-0034 决策 4）。
 */
import { DownOutlined, KeyOutlined, LogoutOutlined, SwapOutlined, UserOutlined } from '@ant-design/icons';
import { Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useSession } from '@/auth/AuthGate';
import { ChangePasswordModal } from '@/components/ChangePasswordModal';
import { workspaceOf, workspaceSwitchItems } from '@/router/workspaces';
import { tokens } from '@/theme/tokens';

type MenuItem = NonNullable<MenuProps['items']>[number];

export interface AccountMenuProps {
  /** 侧栏折叠态：只留头像，名字与箭头收起（名字改走原生 `title` 提示）。 */
  collapsed?: boolean;
  /** 登出动作由**外壳**给（管理面要顺带断实时通道），本组件只负责在菜单里点它。 */
  onLogout: () => void;
}

export function AccountMenu({ collapsed = false, onLogout }: AccountMenuProps) {
  const session = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  /** 「修改密码」弹窗开关。挂在菜单里而不是某一页里：它与"当前在看哪一页"无关。 */
  const [passwordOpen, setPasswordOpen] = useState(false);

  /**
   * 「切换工作区」。当前工作区由 `location.pathname` **现算**（见 `workspaceOf`），
   * 不存 state —— 存了会在浏览器前进/后退后与地址栏对不上。
   * `role=user` 恒得 `[]`（他进不去管理中心），于是菜单里连分隔线都不会多一条。
   */
  const switchTargets = useMemo(
    () => workspaceSwitchItems(session?.role === 'user' ? 'user' : 'admin', workspaceOf(location.pathname)),
    [session?.role, location.pathname],
  );
  const switchItems = useMemo<MenuItem[]>(
    () => switchTargets.map<MenuItem>((item) => ({ key: item.path, label: item.label, icon: <SwapOutlined /> })),
    [switchTargets],
  );
  /** 切换菜单的合法目标集合 —— `onClick` 用它区分"路由项"与"登出/改密"。 */
  const switchPaths = useMemo(() => new Set(switchTargets.map((item) => item.path)), [switchTargets]);

  const username = session?.username ?? '—';

  return (
    <>
      <Dropdown
        trigger={['click']}
        placement="topLeft"
        menu={{
          items: [
            {
              key: 'account',
              label: session?.username ?? '未知账号',
              disabled: true,
              icon: <UserOutlined />,
            },
            { type: 'divider' },
            // 「切换工作区」：只列另一个工作区，且只有管理员才可能有两项。
            // `role=user` 在消费面永远不会渲染到这里那条（他只有一个可去的地方），
            // 但判据仍按 `session?.role` 取，不靠"到不了这里"来保证正确。
            ...switchItems,
            // 「修改密码」（v1.15.9 / ADR-0038 决策 3）：两个外壳**共用同一个弹窗、同一个端点**，
            // 改的是会话本人那一行，与角色无关。
            { key: 'change-password', label: '修改密码', icon: <KeyOutlined /> },
            { key: 'logout', label: '退出登录', icon: <LogoutOutlined />, danger: true },
          ],
          onClick: ({ key }) => {
            if (key === 'logout') onLogout();
            else if (key === 'change-password') setPasswordOpen(true);
            else if (switchPaths.has(key)) {
              // 换工作区 = 换界面，**不是换会话**：cookie 不动、不重新登录。
              // 管理面的实时通道由外壳 Effect 在卸载时关掉，用户中心刻意不建这条连接。
              navigate(key);
            }
          },
        }}
      >
        <span
          className="account-trigger"
          // 折叠态只剩头像，名字改走原生 title —— 不为了"看得见名字"去撑宽 64px 的侧栏。
          title={collapsed ? username : undefined}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'flex-start',
            gap: tokens.space.sm,
            width: '100%',
            padding: `${tokens.space.sm}px ${collapsed ? 0 : tokens.space.sm}px`,
            borderRadius: tokens.radius.sm,
            cursor: 'pointer',
            fontSize: 12,
            color: tokens.color.textSecondary,
          }}
        >
          <UserOutlined style={{ flex: 'none' }} />
          {collapsed ? null : (
            <>
              {/* 名字过长时收尾，不换行撑高整块 —— 侧栏宽度是固定的 216px。 */}
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: tokens.color.textPrimary,
                }}
              >
                {username}
              </span>
              <DownOutlined style={{ fontSize: 10, flex: 'none' }} />
            </>
          )}
        </span>
      </Dropdown>

      {/* 弹窗挂在 Dropdown 之外：它是**会话**级的动作，切换菜单项不该重建它。 */}
      <ChangePasswordModal open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </>
  );
}
