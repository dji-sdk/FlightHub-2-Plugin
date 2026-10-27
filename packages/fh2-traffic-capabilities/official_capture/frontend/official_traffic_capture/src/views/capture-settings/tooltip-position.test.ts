// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { resolveTooltipPosition } from './tooltip-position'

describe('capture settings tooltip position', () => {
  it('把 transformed Popover 内的视口坐标换算为 overlay 本地坐标', () => {
    expect(resolveTooltipPosition(
      { left: 920, top: 380, width: 14 },
      { left: 780, top: 260 },
      1440,
    )).toEqual({ left: 147, top: 112 })
  })

  it('按视口边缘约束 Tooltip 中心后再换算坐标', () => {
    expect(resolveTooltipPosition(
      { left: 20, top: 80, width: 14 },
      { left: 10, top: 30 },
      1000,
    )).toEqual({ left: 140, top: 42 })
  })
})
