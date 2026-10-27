// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { GlobalThemeOverrides } from 'naive-ui'

/**
 * 司空宿主设计系统配色 token（手动复制自宿主设计 token 定义文件）。
 * 插件 View 运行在 ShadowRoot / 独立 Realm，无法读取宿主 document.body 上的 CSS 变量，
 * 因此这里把主题值硬编码进插件产物，与司空宿主保持一致。
 */
export const FH2_COLORS = {
  primary: 'rgba(0, 117, 255, 1)',
  primaryHover: 'rgba(38, 138, 255, 1)',
  primaryPressed: 'rgba(76, 158, 255, 1)',
  primarySelected: 'rgba(115, 179, 255, 1)',
  warning: 'rgba(217, 123, 0, 1)',
  warningHover: 'rgba(255, 159, 10, 1)',
  warningPressed: 'rgba(255, 180, 51, 1)',
  error: 'rgba(228, 31, 41, 1)',
  errorHover: 'rgba(240, 72, 75, 1)',
  errorPressed: 'rgba(252, 118, 116, 1)',
  success: 'rgba(52, 222, 93, 1)',
  successHover: 'rgba(91, 235, 120, 1)',
  successPressed: 'rgba(136, 247, 155, 1)',
  bgPrimary: 'rgba(16, 16, 16, 1)',
  bgSecondary: 'rgba(31, 31, 31, 1)',
  bgTertiary: 'rgba(42, 42, 42, 1)',
  textPrimary: 'rgba(255, 255, 255, 1)',
  textSecondary: 'rgba(255, 255, 255, 0.7)',
  textTertiary: 'rgba(255, 255, 255, 0.5)',
  borderPrimary: 'rgba(255, 255, 255, 1)',
  borderSecondary: 'rgba(255, 255, 255, 0.15)',
  borderTertiary: 'rgba(255, 255, 255, 0.08)',
  cardBg: '#2A2A2A',
  cardBgHover: '#323232',
  priorityHigh: '#E70102',
  priorityNormal: '#FF9F0A',
  priorityDemand: '#268AFF',
  priorityLow: '#8C8C8C',
} as const

/** naive-ui 主题覆盖：与宿主设计系统 index.ts 的 definedTheme('common') 保持一致。 */
export const pluginThemeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: FH2_COLORS.primary,
    primaryColorHover: FH2_COLORS.primaryHover,
    primaryColorPressed: FH2_COLORS.primaryPressed,
    primaryColorSuppl: FH2_COLORS.primaryHover,
    warningColor: FH2_COLORS.warning,
    warningColorHover: FH2_COLORS.warningHover,
    warningColorPressed: FH2_COLORS.warningPressed,
    errorColor: FH2_COLORS.error,
    errorColorHover: FH2_COLORS.errorHover,
    errorColorPressed: FH2_COLORS.errorPressed,
    successColor: FH2_COLORS.success,
    successColorHover: FH2_COLORS.successHover,
    successColorPressed: FH2_COLORS.successPressed,
    textColorBase: FH2_COLORS.textPrimary,
    textColor1: FH2_COLORS.textPrimary,
    textColor2: FH2_COLORS.textSecondary,
    textColor3: FH2_COLORS.textTertiary,
    bodyColor: FH2_COLORS.bgPrimary,
    cardColor: FH2_COLORS.cardBg,
    modalColor: FH2_COLORS.cardBg,
    popoverColor: FH2_COLORS.cardBg,
    borderColor: FH2_COLORS.borderSecondary,
    dividerColor: FH2_COLORS.borderTertiary,
  },
  Button: {
    textColorPrimary: FH2_COLORS.textPrimary,
    textColorHoverPrimary: FH2_COLORS.textPrimary,
    textColorPressedPrimary: FH2_COLORS.textPrimary,
    textColorFocusPrimary: FH2_COLORS.textPrimary,
    textColorDisabledPrimary: FH2_COLORS.textPrimary,
  },
}
