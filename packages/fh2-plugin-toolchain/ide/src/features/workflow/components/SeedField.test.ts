// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { createApp, h } from 'vue'
import SeedField from './SeedField.vue'

/**
 * SeedField：启动数据多选。
 *
 * 契约重点：平台已知键（stream/bizNotify 固定键）展示值类型徽标；
 * 没有类型表的轴（api/job 自定键、未带 seedTypes 的知识包）不显示徽标，也不猜。
 */

interface Mount {
  readonly root: HTMLElement;
  readonly unmount: () => void;
}

function mountField (props: Record<string, unknown>, commits: (readonly string[])[]): Mount {
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({
    setup () {
      return () => h(SeedField, {
        axis: 'stream',
        available: [],
        notGuaranteed: [],
        current: [],
        ...props,
        onCommit: (next: readonly string[]) => {
          commits.push(next)
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

describe('seedField', () => {
  it('平台已知键展示类型徽标；类型表没有的键不显示', () => {
    const { root, unmount } = mountField({
      available: ['eventId', 'payload', 'lat'],
      notGuaranteed: ['lat'],
      types: { eventId: 'string', payload: 'object', lat: 'number' },
    }, [])
    const items = [...root.querySelectorAll('.wf-seed-item')]
    expect(items).toHaveLength(3)
    expect(items[0]!.textContent).toContain('eventId')
    expect(items[0]!.querySelector('.wf-seed-type')?.textContent).toBe('string')
    expect(items[1]!.querySelector('.wf-seed-type')?.textContent).toBe('object')
    // 不保证播的键：⚠ 与类型徽标并存（两个事实互不掩盖）
    expect(items[2]!.querySelector('.wf-seed-warn')).not.toBeNull()
    expect(items[2]!.querySelector('.wf-seed-type')?.textContent).toBe('number')
    unmount()
  })

  it('没有类型表（api/job 自定键）不显示徽标', () => {
    const { root, unmount } = mountField({
      axis: 'job',
      available: [],
    }, [])
    // 自由输入分支：行式键列表，没有类型列
    expect(root.querySelector('.wf-seed-type')).toBeNull()
    expect(root.querySelector('.wf-key-list')).not.toBeNull()
    unmount()
  })
})
