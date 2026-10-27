// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { FH2_COLORS, pluginThemeOverrides } from './theme'

describe('plugin theme', () => {
  it('与司空宿主设计系统配色保持一致', () => {
    expect(FH2_COLORS.primary).toBe('rgba(0, 117, 255, 1)')
    expect(FH2_COLORS.error).toBe('rgba(228, 31, 41, 1)')
    expect(FH2_COLORS.cardBg).toBe('#2A2A2A')
    expect(pluginThemeOverrides.common?.primaryColor).toBe(FH2_COLORS.primary)
    expect(pluginThemeOverrides.common?.errorColor).toBe(FH2_COLORS.error)
    expect(pluginThemeOverrides.common?.textColorBase).toBe(FH2_COLORS.textPrimary)
    expect(pluginThemeOverrides.common?.cardColor).toBe(FH2_COLORS.cardBg)
    expect(pluginThemeOverrides.Button?.textColorPrimary).toBe(FH2_COLORS.textPrimary)
    expect(pluginThemeOverrides.Button?.textColorHoverPrimary).toBe(FH2_COLORS.textPrimary)
    expect(pluginThemeOverrides.Button?.textColorPressedPrimary).toBe(FH2_COLORS.textPrimary)
    expect(pluginThemeOverrides.Button?.textColorFocusPrimary).toBe(FH2_COLORS.textPrimary)
    expect(pluginThemeOverrides.Button?.textColorDisabledPrimary).toBe(FH2_COLORS.textPrimary)
  })
})
