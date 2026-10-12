/**
 * 区块外壳（Panel）—— 全站「一块带边框的容器」的唯一实现。
 *
 * 为什么要收这一层：2026-10-12 Bo 要求巡检排版与间距。此前站内有 **19 处**各自手写的
 * `border + borderRadius: radius.md + background: bgContainer + padding`，四处标题各自手写
 * `fontSize: 13, fontWeight: 600`。后果不是"不好看"，是**同一种东西在不同页长得不一样**：
 * 有的 padding 用 `space.lg`、有的用 `space.md`、有的标题下间距是 `md`、有的是 `sm`，
 * 改一处规范要翻 19 个文件，漏掉的那几个就永远不一致。
 *
 * 三条约定：
 * - **尺寸两档**：`md`（默认，`padding: space.lg`）与 `sm`（密集区，`padding: space.md`）。
 *   只留两档，不开放任意 padding —— 一旦能传数字，这里就会重新长出 19 种。
 * - **标题走 `title` / `extra`**，不在 children 里手拼一行 div + 一个按钮。
 * - 不套 AntD `Card`：`Card` 自带 header 分隔线与内边距，深色主题下那条线是多余的视觉噪声，
 *   而本站的区块**多数没有分隔线**，用 `Card` 反而要先把它关掉。
 */
import { Tooltip, Typography } from 'antd';
import type { ReactNode } from 'react';

import { tokens } from '@/theme/tokens';

const { Text } = Typography;

export interface PanelProps {
  /** 区块标题（13px / 600，全站同一档）。 */
  title?: ReactNode;
  /** 标题右侧的操作区（按钮 / 分段器 / 刷新）。 */
  extra?: ReactNode;
  /** 标题下方的一句口径说明。次要色、12px，与标题的间距固定。 */
  description?: ReactNode;
  /** 标题悬浮说明（口径、来源、代价）。 */
  hint?: string;
  /** `md` = 常规区块；`sm` = 密集区（资金池、筛选条这类）。 */
  size?: 'md' | 'sm';
  /** 内容区上方是否留标题与内容之间的间距。需要内容自己贴边时关掉。 */
  gap?: boolean;
  /** 覆盖外壳样式（只用于"这块要贴满容器"这类结构差异，不用于改间距）。 */
  style?: React.CSSProperties;
  children: ReactNode;
}

const PADDING: Record<NonNullable<PanelProps['size']>, number> = {
  md: tokens.space.lg,
  sm: tokens.space.md,
};

export function Panel({
  title,
  extra,
  description = null,
  hint,
  size = 'md',
  gap = true,
  style,
  children,
}: PanelProps) {
  const hasHeader = title !== undefined || extra !== undefined || description !== null;

  return (
    <section
      style={{
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
        background: tokens.color.bgContainer,
        padding: PADDING[size],
        minWidth: 0,
        ...style,
      }}
    >
      {hasHeader ? (
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: tokens.space.md,
            flexWrap: 'wrap',
            marginBottom: gap ? PADDING[size] : 0,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            {title !== undefined ? (
              hint ? (
                <Tooltip title={hint}>
                  <Text style={{ fontSize: 13, fontWeight: 600 }}>{title}</Text>
                </Tooltip>
              ) : (
                <Text style={{ fontSize: 13, fontWeight: 600 }}>{title}</Text>
              )
            ) : null}
            {description ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {description}
              </Text>
            ) : null}
          </div>
          {extra ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.sm, flex: 'none' }}>
              {extra}
            </div>
          ) : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}
