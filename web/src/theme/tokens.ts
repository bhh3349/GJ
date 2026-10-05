/**
 * 设计 token 单一事实源。
 * 组件里禁止硬编码色值/间距，一律从这里取，保证深色主题改版只需动一处。
 */
export const tokens = {
  color: {
    /** 页面底色（也是 html/body 的首屏底色，见 index.html 内联样式） */
    bgBase: '#0A0E14',
    /** 卡片/容器底色 */
    bgContainer: '#111823',
    /** 悬浮态容器底色 */
    bgContainerHover: '#16202E',
    /** 侧边栏底色 */
    bgSider: '#080B11',
    /** 分割线 / 边框 */
    border: '#1E2A3A',
    borderStrong: '#2A3A50',
    textPrimary: '#E6EDF7',
    textSecondary: '#93A3BA',
    textTertiary: '#5F7089',
    primary: '#4C8DFF',
    primaryHover: '#6DA3FF',
    success: '#34D399',
    warning: '#FBBF24',
    error: '#F87171',
    info: '#38BDF8',
  },
  /** 语义色在深色底上的淡背景，用于标签/状态点 */
  tint: {
    success: 'rgba(52, 211, 153, 0.14)',
    warning: 'rgba(251, 191, 36, 0.14)',
    error: 'rgba(248, 113, 113, 0.14)',
    info: 'rgba(56, 189, 248, 0.14)',
    neutral: 'rgba(147, 163, 186, 0.12)',
  },
  radius: {
    sm: 6,
    md: 10,
    lg: 14,
  },
  space: {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32,
  },
  font: {
    sans: "'Inter', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, -apple-system, sans-serif",
    mono: "'JetBrains Mono', 'Cascadia Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },
  /** 侧边栏/顶栏尺寸 */
  layout: {
    siderWidth: 216,
    siderCollapsedWidth: 64,
    headerHeight: 56,
  },
  motion: {
    fast: '120ms',
    base: '200ms',
    easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
} as const;

export type Tokens = typeof tokens;
