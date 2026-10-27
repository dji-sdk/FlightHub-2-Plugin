// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 编辑器 Tab 批量关闭的目标集合（纯函数）。
 * openPaths 即 documents store 的 tab 顺序；target 必须在其中。
 */

export type CloseScope = 'right' | 'others'

/** 关闭右侧 / 关闭其他 的目标列表；目标不在 openPaths 中时返回空。 */
export function closeTargets (openPaths: readonly string[], target: string, scope: CloseScope): readonly string[] {
  const index = openPaths.indexOf(target)
  if (index === -1) return []
  if (scope === 'right') return openPaths.slice(index + 1)
  return openPaths.filter(path => path !== target)
}
