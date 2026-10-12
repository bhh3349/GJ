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
    /**
     * 第四档语义色（橙）。**不是** `warning` 的别名：`warning` 留给「还行但有风险」，
     * 橙留给「已经封顶/耗尽」这类比 warning 重、但**不是故障**的状态
     * （账号额度耗尽、套餐剩余 <10%）。红色只留给真出事（登录失败 / 会话过期）。
     */
    orange: '#FB923C',
    error: '#F87171',
    info: '#38BDF8',
  },
  /**
   * 图表分类序列色（**非语义**，只按深色底上的可辨识度排序）。
   * 同一指标在不同页面共用本序，所以「上游 A」在仪表盘与统计页是同一个色；
   * 语义（成功/失败/冷却）一律走上面 `color`，不要用本序表达状态。
   * 前四位**刻意与 `color.primary/success/warning/info` 同值**（图表主线与主题主色一致），
   * 改主题色时这里要一起改；后六位是图表专用扩展色，只在本序里存在。
   */
  chart: {
    series: [
      '#4C8DFF',
      '#34D399',
      '#FBBF24',
      '#38BDF8',
      '#A78BFA',
      '#F472B6',
      '#22D3EE',
      '#FB923C',
      '#4ADE80',
      '#818CF8',
    ],
  },
  /** 语义色在深色底上的淡背景，用于标签/状态点 */
  tint: {
    success: 'rgba(52, 211, 153, 0.14)',
    warning: 'rgba(251, 191, 36, 0.14)',
    /** 与 `color.orange` 配对（`warning` 的 tint 更黄，两者不可互换）。 */
    orange: 'rgba(251, 146, 60, 0.14)',
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
