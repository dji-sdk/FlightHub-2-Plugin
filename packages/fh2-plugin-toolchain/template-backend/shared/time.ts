// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// shared/time.ts —— 毫秒时间戳的存取口径。
//
// ★★ 为什么不直接存数字:平台的 store 现阶段按字符串读写全部业务字段(见
//   schema.sql 头部注释)。毫秒时间戳存【定宽 13 位】字符串 —— 字符串比较只在
//   定宽时等价于数值比较,列表排序与时间窗筛选都靠这一点。
//   存 1699999999999 与 12345 两种宽度,排序就会乱(12 开头排在 16 开头前面)。

// msText 把毫秒时间戳(数字或数字串)规整成 13 位定宽字符串。
// ⚠️ 非法输入(0 / NaN / 负数)不在这里抛 —— "0 = 上游没解出来"是合法取值,
//   要不要当错误由调用方判(这是 msNum 的存在理由:拿回数字才能判)。
export function msText (value: string | number): string {
  const num = Math.floor(Number(value) || 0)
  if (!Number.isFinite(num) || num <= 0) return ''
  return String(num).padStart(13, '0')
}

// msNum 把存下来的定宽串还原成数字,便于比较与判 0。空串回 0。
export function msNum (value: string): number {
  const num = Math.floor(Number(value) || 0)
  return Number.isFinite(num) && num > 0 ? num : 0
}
