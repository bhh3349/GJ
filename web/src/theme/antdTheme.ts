import { theme, type ThemeConfig } from 'antd';

import { tokens } from './tokens';

/**
 * AntD 深色主题映射。所有色值来自 tokens，不在这里写裸色。
 * 组件级覆写只做「AntD 默认深色不好看」的部分，不做业务样式。
 */
export const antdTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: tokens.color.primary,
    colorInfo: tokens.color.info,
    colorSuccess: tokens.color.success,
    colorWarning: tokens.color.warning,
    colorError: tokens.color.error,

    colorBgBase: tokens.color.bgBase,
    colorBgContainer: tokens.color.bgContainer,
    colorBgElevated: tokens.color.bgContainerHover,
    colorBorder: tokens.color.border,
    colorBorderSecondary: tokens.color.border,

    colorText: tokens.color.textPrimary,
    colorTextSecondary: tokens.color.textSecondary,
    colorTextTertiary: tokens.color.textTertiary,

    fontFamily: tokens.font.sans,
    fontFamilyCode: tokens.font.mono,
    fontSize: 13,

    borderRadius: tokens.radius.md,
    borderRadiusLG: tokens.radius.lg,
    borderRadiusSM: tokens.radius.sm,

    controlHeight: 32,
    wireframe: false,
    motionDurationMid: tokens.motion.base,
  },
  components: {
    Layout: {
      headerBg: 'transparent',
      headerHeight: tokens.layout.headerHeight,
      headerPadding: `0 ${tokens.space.lg}px`,
      siderBg: tokens.color.bgSider,
      bodyBg: tokens.color.bgBase,
    },
    Menu: {
      itemBg: 'transparent',
      subMenuItemBg: 'transparent',
      itemSelectedBg: tokens.tint.info,
      itemSelectedColor: tokens.color.textPrimary,
      itemHoverBg: 'rgba(147, 163, 186, 0.08)',
      itemHeight: 38,
      itemMarginInline: tokens.space.sm,
      itemBorderRadius: tokens.radius.sm,
      iconSize: 15,
    },
    Card: {
      colorBgContainer: tokens.color.bgContainer,
      headerBg: 'transparent',
      paddingLG: tokens.space.lg,
    },
    Table: {
      headerBg: 'rgba(147, 163, 186, 0.06)',
      headerColor: tokens.color.textSecondary,
      rowHoverBg: tokens.color.bgContainerHover,
      borderColor: tokens.color.border,
    },
    Button: {
      primaryShadow: 'none',
      defaultShadow: 'none',
      dangerShadow: 'none',
    },
    Modal: {
      contentBg: tokens.color.bgContainer,
      headerBg: tokens.color.bgContainer,
    },
    Tabs: {
      itemColor: tokens.color.textSecondary,
      itemSelectedColor: tokens.color.textPrimary,
      inkBarColor: tokens.color.primary,
    },
    Tooltip: {
      colorBgSpotlight: tokens.color.bgContainerHover,
    },
    // 明确禁用「原生观感」：Select 走 AntD 壳，不使用浏览器默认下拉。
    Select: {
      optionSelectedBg: tokens.tint.info,
      optionActiveBg: 'rgba(147, 163, 186, 0.08)',
    },
  },
};
