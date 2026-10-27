// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import ContextMenu from '@imengyu/vue3-context-menu'
import type { MenuItem as LibraryMenuItem } from '@imengyu/vue3-context-menu'
import '@imengyu/vue3-context-menu/lib/vue3-context-menu.css'

/**
 * 右键菜单服务：包装 @imengyu/vue3-context-menu，保持原有
 * showContextMenu / closeContextMenu / MenuEntry 的调用形状。
 * 该库自挂载组件实例，不依赖 app 上下文。
 */

export interface MenuItem {
  readonly label: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}

export type MenuEntry = MenuItem | 'separator'

export function showContextMenu (x: number, y: number, entries: readonly MenuEntry[]): void {
  const items: LibraryMenuItem[] = []
  let divided = false
  for (const entry of entries) {
    if (entry === 'separator') {
      divided = true
      continue
    }
    items.push({
      label: entry.label,
      disabled: entry.disabled === true,
      // 库的分隔线语义是「本项上方画线」，与原 separator 语义等价
      ...(divided ? { divided: 'up' as const } : {}),
      onClick: () => {
        entry.onSelect()
      },
    })
    divided = false
  }
  ContextMenu.showContextMenu({
    x,
    y,
    items,
    // mac dark：圆角毛玻璃观感的暗色主题，与 IDE 暗色色板一致
    theme: 'mac dark',
    zIndex: 90,
    // 点击空白处/Esc 即关；常驻菜单（画布右键）不应挡住 Monaco 的键盘焦点太久
    closeWhenScroll: true,
  })
}

export function closeContextMenu (): void {
  ContextMenu.closeContextMenu()
}
