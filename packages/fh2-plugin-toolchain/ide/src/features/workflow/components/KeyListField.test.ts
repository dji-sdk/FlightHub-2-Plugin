// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import type { Ref } from 'vue'
import KeyListField from './KeyListField.vue'

/**
 * KeyListField：键列表行式编辑器（provides/optional/interruptedBy/seed 共用）。
 *
 * 契约重点（schema `provided` 的 anyOf：全字符串 或 全 {key,type}）：
 * - 所有行都「（未声明）」→ 提交裸字符串数组（不无端升形态）；
 * - 任一行选了类型 → 统一对象形态，未声明的行只写 {key}（不编造类型）；
 * - 新增空行不提交（空键在序列化里丢弃）；
 * - 词表外类型显式列出、不静默改掉。
 */

interface Mount {
  readonly root: HTMLElement;
  readonly unmount: () => void;
}

const TYPES = ['string', 'number', 'bool', 'object', 'array']

function mountField (value: Ref<readonly unknown[]>, commits: (readonly unknown[])[], types?: readonly string[]): Mount {
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({
    setup () {
      return () => h(KeyListField, {
        value: value.value,
        ...(types === undefined ? {} : { types }),
        onCommit: (next: readonly unknown[]) => {
          commits.push(next)
          value.value = next
        },
      })
    },
  })
  app.mount(root)
  return {
    root,
    unmount: () => {
      app.unmount()
      root.remove()
    },
  }
}

function change (input: HTMLInputElement | HTMLSelectElement, text: string): void {
  input.value = text
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function click (element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: false }))
}

function addButtons (root: HTMLElement): HTMLButtonElement[] {
  return [...root.querySelectorAll('button')].filter(button => button.textContent?.includes('添加键'))
}

describe('keyListField', () => {
  it('字符串形态 + 任一行选类型 → 统一对象形态（未声明的行只写 key）', async () => {
    const commits: (readonly unknown[])[] = []
    const value = ref<readonly unknown[]>(['waylineUuid', 'dockSn'])
    const { root, unmount } = mountField(value, commits, TYPES)

    const select = root.querySelector('select') as HTMLSelectElement
    expect([...select.options].map(option => option.value)).toEqual(['', ...TYPES])
    change(select, 'string')
    expect(commits[0]).toEqual([
      { key: 'waylineUuid', type: 'string' },
      { key: 'dockSn' },
    ])
    unmount()
  })

  it('全部行未声明类型 → 保持裸字符串数组形态', async () => {
    const commits: (readonly unknown[])[] = []
    const value = ref<readonly unknown[]>(['decision', 'remark'])
    const { root, unmount } = mountField(value, commits, TYPES)

    change(root.querySelector('input') as HTMLInputElement, 'verdict')
    expect(commits[0]).toEqual(['verdict', 'remark'])
    unmount()
  })

  it('对象形态值渲染出键与类型列；词表外类型显式列出', async () => {
    const commits: (readonly unknown[])[] = []
    const value = ref<readonly unknown[]>([{ key: 'x', type: 'weird' }, { key: 'y', type: 'string' }])
    const { root, unmount } = mountField(value, commits, TYPES)

    const select = root.querySelector('select') as HTMLSelectElement
    expect(select.value).toBe('weird')
    expect([...select.options].some(option => option.textContent?.includes('weird（不在类型列表内）'))).toBe(true)
    // 编辑另一行：weird 原样保留，不被词表改写
    change(root.querySelectorAll('input')[1] as HTMLInputElement, 'z')
    expect(commits[0]).toEqual([{ key: 'x', type: 'weird' }, { key: 'z', type: 'string' }])
    unmount()
  })

  it('新增空行不提交；填键后提交且新行默认词表第一项', async () => {
    const commits: (readonly unknown[])[] = []
    const value = ref<readonly unknown[]>([])
    const { root, unmount } = mountField(value, commits, TYPES)

    click(addButtons(root)[0]!)
    await nextTick()
    expect(commits).toEqual([])

    change(root.querySelector('input') as HTMLInputElement, 'decision')
    expect(commits[0]).toEqual([{ key: 'decision', type: 'string' }])
    unmount()
  })

  it('纯键模式（无 types）没有类型列，提交字符串数组', async () => {
    const commits: (readonly unknown[])[] = []
    const value = ref<readonly unknown[]>(['user_cancel'])
    const { root, unmount } = mountField(value, commits)

    expect(root.querySelector('select')).toBeNull()
    click(addButtons(root)[0]!)
    await nextTick()
    const inputs = [...root.querySelectorAll('input')] as HTMLInputElement[]
    change(inputs[1]!, 'force_stop')
    expect(commits[0]).toEqual(['user_cancel', 'force_stop'])
    unmount()
  })

  it('外部值变更重建行；等价回显不打断本地新行', async () => {
    const commits: (readonly unknown[])[] = []
    const value = ref<readonly unknown[]>(['a'])
    const { root, unmount } = mountField(value, commits)

    value.value = ['b']
    await nextTick()
    expect(root.querySelector('input')!.value).toBe('b')

    click(addButtons(root)[0]!)
    await nextTick()
    value.value = ['b']
    await nextTick()
    expect(root.querySelectorAll('input')).toHaveLength(2)
    unmount()
  })
})
