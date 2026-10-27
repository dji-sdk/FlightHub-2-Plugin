// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 文件树图标映射：扩展名 → 分类（图标组件 + 着色 class）。
 * 颜色定义在 styles.css 的 .tree-icon.icon-* —— 图标本身是单色 SVG，
 * 着色走 CSS（currentColor），与 VS Code 暗色系色板对齐。
 */
import type { Component } from 'vue'
import {
  CodeSlashOutline,
  CubeOutline,
  DocumentTextOutline,
  FileTrayFullOutline,
  FolderOpenOutline,
  FolderOutline,
  ImageOutline,
} from '@vicons/ionicons5'

export interface TreeIcon {
  readonly component: Component;
  /** styles.css 里的着色 class（icon-dir / icon-ts / …）。 */
  readonly cls: string;
}

export interface TreeIcons {
  readonly folder: TreeIcon;
  readonly folderOpen: TreeIcon;
}

export const TREE_FOLDER_ICONS: TreeIcons = {
  folder: { component: FolderOutline, cls: 'icon-dir' },
  folderOpen: { component: FolderOpenOutline, cls: 'icon-dir' },
}

const CODE: TreeIcon = { component: CodeSlashOutline, cls: 'icon-code' }
const DOC: TreeIcon = { component: DocumentTextOutline, cls: 'icon-doc' }
const IMAGE: TreeIcon = { component: ImageOutline, cls: 'icon-img' }
const JSON_LIKE: TreeIcon = { component: CubeOutline, cls: 'icon-json' }
const DEFAULT: TreeIcon = { component: FileTrayFullOutline, cls: 'icon-default' }

/** 代码类的细分色：同用 CodeSlashOutline，色相按语言分。 */
const CODE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'icon-ts',
  tsx: 'icon-ts',
  mts: 'icon-ts',
  cts: 'icon-ts',
  js: 'icon-js',
  mjs: 'icon-js',
  cjs: 'icon-js',
  jsx: 'icon-js',
  vue: 'icon-vue',
  css: 'icon-css',
  scss: 'icon-css',
  less: 'icon-css',
  html: 'icon-html',
  htm: 'icon-html',
}

const DOC_EXTENSIONS: ReadonlySet<string> = new Set([
  'md',
  'markdown',
  'txt',
  'sql',
  'sh',
  'bash',
  'yml',
  'yaml',
  'toml',
  'log',
])

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'ico',
  'bmp',
])

/** 按文件名（含扩展名）取图标；未知类型回落到托盘默认图标。 */
export function fileIconOf (name: string): TreeIcon {
  const extension = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : ''
  if (extension === '') return DEFAULT

  const codeCls = CODE_BY_EXTENSION[extension]
  if (codeCls !== undefined) return { component: CODE.component, cls: codeCls }
  if (extension === 'json') return JSON_LIKE
  if (DOC_EXTENSIONS.has(extension)) return DOC
  if (IMAGE_EXTENSIONS.has(extension)) return IMAGE
  return DEFAULT
}
