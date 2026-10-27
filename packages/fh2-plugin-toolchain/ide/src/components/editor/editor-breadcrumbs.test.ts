// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createApp, h, nextTick } from 'vue'
import type { App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import * as monaco from 'monaco-editor'
import { afterEach, expect, it } from 'vitest'
import { useDocumentsStore } from '../../stores/documents'
import EditorBreadcrumbs from './EditorBreadcrumbs.vue'

let app: App | undefined
let root: HTMLElement
afterEach(() => {
  app?.unmount()
  root?.remove()
  for (const model of monaco.editor.getModels()) model.dispose()
})

it('路径栏随活动tab、重命名和关闭更新，根文件只有文件名，无文件时隐藏', async () => {
  const pinia = createPinia()
  setActivePinia(pinia)
  app = createApp({ render: () => h(EditorBreadcrumbs) })
  app.use(pinia)
  root = document.createElement('div')
  document.body.append(root)
  app.mount(root)
  const documents = useDocumentsStore()
  expect(root.querySelector('nav')).toBeNull()
  documents.open('src/目录/main.ts', 'const value = 1')
  await nextTick()
  expect(root.querySelector('nav')?.title).toBe('src/目录/main.ts')
  expect([...root.querySelectorAll('.breadcrumb-item')].map(element => element.textContent?.trim())).toEqual(['src', '目录', 'main.ts'])
  expect(root.querySelectorAll('.breadcrumb-separator')).toHaveLength(2)
  expect(root.querySelector('.breadcrumb-file .tree-icon')).not.toBeNull()
  documents.open('package.json', '{}')
  await nextTick()
  expect(root.querySelectorAll('.breadcrumb-item')).toHaveLength(1)
  expect(root.querySelector('.breadcrumb-file')?.textContent?.trim()).toBe('package.json')
  documents.activate('src/目录/main.ts')
  documents.remapOpenDocuments('src/目录', 'src/新目录')
  await nextTick()
  expect(root.querySelector('nav')?.title).toBe('src/新目录/main.ts')
  documents.close('src/新目录/main.ts')
  await nextTick()
  expect(root.querySelector('nav')?.title).toBe('package.json')
  documents.close('package.json')
  await nextTick()
  expect(root.querySelector('nav')).toBeNull()
})
