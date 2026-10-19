/**
 * 侧栏收起/展开按钮 —— 两个外壳（管理面 `AppLayout` / 消费面 `ConsoleLayout`）**共用同一份**，
 * 挂在品牌行右侧（现代 agent web 端的通行位置）。
 *
 * **为什么不用 antd 自带的那个把手**：`Sider` 的 `collapsible` 默认在**底部**渲染一条
 * 通栏的 `.ant-layout-sider-trigger`（`position:fixed` + 满宽 + 自己的底色），也就是 Bo 说的
 * "一整条"。它有三个毛病：① 通栏色块与侧栏内容不成一套，看起来像系统贴上去的；
 * ② 它占住了左下角——为了不被它盖住，`aside` 被强制 `padding-bottom = 把手高度`，
 * 于是账号按钮必须悬空一截；③ 位置在**底部**，而底部现在是账号的地盘。
 * 所以这里传 `trigger={null}` 关掉它（`has-trigger` 类不再加、那条 padding 也一并没了），
 * 自己把切换做成一个**图标按钮**。
 *
 * 与 `AccountMenu` 同一条抽件理由：两个外壳都要同一个控件，各写一份就会漂移
 * （一边换了位置、一边没换）。放 `src/components/` 也是同一条分包纪律。
 */
import { MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons';

import { tokens } from '@/theme/tokens';

export interface SidebarCollapseButtonProps {
  /** 当前侧栏是否已收起 —— 只决定图标方向与提示文案，不决定渲染与否。 */
  collapsed: boolean;
  /** 切换动作由外壳给（`collapsed` 的 state 在外壳手里，这里是无状态的表现件）。 */
  onToggle: () => void;
}

export function SidebarCollapseButton({ collapsed, onToggle }: SidebarCollapseButtonProps) {
  return (
    <button
      type="button"
      className="sider-collapse"
      // 折叠态只有这一个按钮，名字与它挤在 64px 里放不下 —— 靠 title 说话。
      title={collapsed ? '展开侧栏' : '收起侧栏'}
      aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
      aria-expanded={!collapsed}
      onClick={onToggle}
      style={{
        flex: 'none',
        // 顶到品牌行最右：展开态本来就被品牌名撑开，折叠态靠这一条自己贴边，
        // 不靠 `justifyContent:'space-between'`（那会在折叠态把两个图标拉成两端对齐）。
        marginInlineStart: 'auto',
        width: 28,
        height: 28,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        border: 'none',
        borderRadius: tokens.radius.sm,
        fontSize: 15,
        cursor: 'pointer',
        // `background` / `color` **不在这里写**：内联样式压得住样式表，写在这里
        // `.sider-collapse:hover` 就永远不生效（实测：悬停前后都是 transparent）。
        // 它们与悬停/按下态一起放在 `global.css` 的同一条规则组里。
      }}
    >
      {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
    </button>
  );
}
