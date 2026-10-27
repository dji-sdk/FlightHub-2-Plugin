// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/** 去程派遣卡与沿路网返航面板共用的路线距离/时长展示文案。 */

/** 估计时长格式化：112.6 → 「1 分 53 秒」，45 → 「45 秒」，120 → 「2 分」。 */
export function formatDuration (seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  if (minutes > 0 && rest > 0) return `${minutes} 分 ${rest} 秒`
  if (minutes > 0) return `${minutes} 分`
  return `${rest} 秒`
}

/**
 * 距离文案与原生 measureBasicUnitTransfer(Length, floor, 1 位小数) 一致：
 * ≤10000m 显示 "xxxx.x m"，>10000m 转 "xx.x km"。
 */
export function formatDistance (meters: number): string {
  if (meters > 10000) return `${Math.floor((meters / 1000) * 10) / 10} km`
  return `${Math.floor(meters * 10) / 10} m`
}
