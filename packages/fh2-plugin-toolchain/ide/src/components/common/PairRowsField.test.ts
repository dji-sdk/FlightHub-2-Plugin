// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import type { Ref } from 'vue'
import PairRowsField from './PairRowsField.vue'

/**
 * PairRowsField：键=值 行式编辑器（stream.match 与对话框 pairs 字段共用）。
 *
 * 契约重点：提交值是普通对象；空键行丢弃；重复键后行胜出；
 * 外部值变更（重载/撤销）重建行、等价回显不打断本地编辑。
 */

interface Mount {
  readonly root: HTMLElement;
  readonly unmount: () => void;
}

function mountField (value: Ref<Record<string, string>>, commits: Record<string, string>[]): Mount {
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({
    setup () {
      return () => h(PairRowsField, {
        value: value.value,
        onCommit: (next: Record<string, string>) => {
          commits.push({ ...next })
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

function change (input: HTMLInputElement, text: string): void {
  input.value = text
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function click (element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: false }))
}

function addButtons (root: HTMLElement): HTMLButtonElement[] {
  return [...root.querySelectorAll('button')].filter(button => button.textContent?.includes('＋'))
}

function removeButtons (root: HTMLElement): HTMLButtonElement[] {
  return [...root.querySelectorAll('button')].filter(button => button.textContent?.trim() === '删除')
}

describe('pairRowsField', () => {
  it('对象值渲染成行；改键提交整份对象', async () => {
    const commits: Record<string, string>[] = []
    const value = ref<Record<string, string>>({ event_type: 'illegal_road', status: 'pending' })
    const { root, unmount } = mountField(value, commits)
    const inputs = [...root.querySelectorAll('input')]
    expect(inputs).toHaveLength(4)
    expect(inputs[0]!.value).toBe('event_type')
    expect(inputs[1]!.value).toBe('illegal_road')

    change(inputs[0] as HTMLInputElement, 'event_kind')
    expect(commits).toEqual([{ event_kind: 'illegal_road', status: 'pending' }])
    unmount()
  })

  it('新增空行不提交；填完键值才提交', async () => {
    const commits: Record<string, string>[] = []
    const value = ref<Record<string, string>>({})
    const { root, unmount } = mountField(value, commits)

    click(addButtons(root)[0]!)
    await nextTick()
    expect(root.querySelectorAll('input')).toHaveLength(2)
    expect(commits).toEqual([])

    const inputs = [...root.querySelectorAll('input')] as HTMLInputElement[]
    change(inputs[0]!, 'event_type')
    change(inputs[1]!, 'illegal_road')
    // 值提交按格走：先 {event_type:''}，再补上值
    expect(commits).toEqual([{ event_type: '' }, { event_type: 'illegal_road' }])
    unmount()
  })

  it('删行提交剩余对象；删到一条不剩提交空对象', async () => {
    const commits: Record<string, string>[] = []
    const value = ref<Record<string, string>>({ a: '1', b: '2' })
    const { root, unmount } = mountField(value, commits)

    click(removeButtons(root)[0]!)
    await nextTick()
    expect(commits).toEqual([{ b: '2' }])

    click(removeButtons(root)[0]!)
    await nextTick()
    expect(commits).toEqual([{ b: '2' }, {}])
    unmount()
  })

  it('空键行在提交里丢弃；重复键后行胜出', async () => {
    const commits: Record<string, string>[] = []
    const value = ref<Record<string, string>>({ a: '1' })
    const { root, unmount } = mountField(value, commits)

    click(addButtons(root)[0]!)
    await nextTick()
    // 新行不填键、只填值 → 这一行被序列化丢弃，提交值与现状等价
    const inputs = [...root.querySelectorAll('input')] as HTMLInputElement[]
    change(inputs[3]!, '半配置')
    expect(commits).toEqual([{ a: '1' }])

    // 把新行的键改成与第一行相同（含首尾空格）→ trim 后后行胜出
    change(inputs[2]!, ' a ')
    expect(commits).toEqual([{ a: '1' }, { a: '半配置' }])
    unmount()
  })

  it('外部值变更重建行；等价回显不打断本地编辑', async () => {
    const commits: Record<string, string>[] = []
    const value = ref<Record<string, string>>({ a: '1' })
    const { root, unmount } = mountField(value, commits)

    value.value = { b: '2' }
    await nextTick()
    expect(root.querySelector('input')!.value).toBe('b')

    // 本地加了一行还没填（无提交），外部写回与当前序列化等价的值 → 空行必须还在
    click(addButtons(root)[0]!)
    await nextTick()
    value.value = { b: '2' }
    await nextTick()
    expect(root.querySelectorAll('input')).toHaveLength(4)
    unmount()
  })
})
