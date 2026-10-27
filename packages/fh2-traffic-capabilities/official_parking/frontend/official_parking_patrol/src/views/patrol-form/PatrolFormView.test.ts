// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// @vitest-environment happy-dom
import { createApp, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PatrolFormView from './PatrolFormView.vue'
import type { PatrolFormState, PatrolFormViewClient } from './contract'

let root: HTMLElement | undefined
afterEach(() => root?.remove())

const baseState: PatrolFormState = {
  enabled: false,
  contextAvailable: true,
  multiWayline: false,
  submitting: false,
  recheckDelayMinutes: 10,
}

function createClient (initial: PatrolFormState = baseState) {
  let current = initial
  const listeners = new Set<(value: PatrolFormState) => void>()
  const setEnabled = vi.fn()
  const setRecheckDelayMinutes = vi.fn()
  const client = {
    state: {
      subscribe (listener: (value: PatrolFormState) => void) {
        listeners.add(listener)
        listener(current)
        return {
          dispose () {
            listeners.delete(listener)
          },
        }
      },
    },
    setEnabled,
    setRecheckDelayMinutes,
    dispose: vi.fn(),
  }
  return {
    client: client as unknown as PatrolFormViewClient,
    setEnabled,
    setRecheckDelayMinutes,
    push (next: PatrolFormState) {
      current = next
      for (const listener of listeners) listener(next)
    },
  }
}

function mountView (client: PatrolFormViewClient): HTMLElement {
  root = document.createElement('div')
  document.body.append(root)
  createApp(PatrolFormView, {
    client,
    styleTarget: document.head,
    overlayElement: document.body,
  }).mount(root)
  return root
}

function queryInput (): HTMLInputElement {
  return root!.querySelector<HTMLInputElement>('.delay-input')!
}

async function inputDelay (value: string): Promise<void> {
  const input = queryInput()
  input.value = value
  input.dispatchEvent(new Event('input'))
  await nextTick()
}

describe('patrolFormView', () => {
  it('开关关闭：不渲染违停复检间隔输入框与错误提示', async () => {
    const { client } = createClient()
    const mounted = mountView(client)
    await nextTick()
    expect(mounted.querySelector('.delay-input')).toBeNull()
    expect(mounted.querySelector('.delay-error')).toBeNull()
  })

  it('开关开启：渲染违停复检间隔(分钟)输入框并显示默认 10 分钟', async () => {
    const { client } = createClient({ ...baseState, enabled: true })
    const mounted = mountView(client)
    await nextTick()
    expect(mounted.querySelector('.delay-label')?.textContent).toBe('违停复检间隔(分钟)')
    const input = mounted.querySelector<HTMLInputElement>('.delay-input')
    expect(input).not.toBeNull()
    // 普通文本输入框（原生 number 样式不佳且输入行为受限），数字键盘由 inputmode 提供
    expect(input!.getAttribute('type')).toBe('text')
    expect(input!.getAttribute('inputmode')).toBe('numeric')
    expect(input!.value).toBe('10')
    expect(mounted.querySelector('.delay-error')).toBeNull()
  })

  it('输入合法值：上报分钟数值且无错误提示', async () => {
    const { client, setRecheckDelayMinutes } = createClient({ ...baseState, enabled: true })
    const mounted = mountView(client)
    await nextTick()

    await inputDelay('15')
    expect(setRecheckDelayMinutes).toHaveBeenLastCalledWith({ value: 15 })
    expect(mounted.querySelector('.delay-error')).toBeNull()
  })

  it('输入非法值（0/空/小数/超上限/非数字）：上报 null 并显示错误提示，恢复合法后错误消失', async () => {
    const { client, setRecheckDelayMinutes } = createClient({ ...baseState, enabled: true })
    const mounted = mountView(client)
    await nextTick()

    for (const raw of ['0', '', '1.5', '26', 'abc', '30分钟']) {
      await inputDelay(raw)
      expect(setRecheckDelayMinutes).toHaveBeenLastCalledWith({ value: null })
      expect(mounted.querySelector('.delay-error')).not.toBeNull()
    }

    await inputDelay('25')
    expect(setRecheckDelayMinutes).toHaveBeenLastCalledWith({ value: 25 })
    expect(mounted.querySelector('.delay-error')).toBeNull()
  })

  it('状态推送新值（复制继承/表单重置）：输入框同步更新', async () => {
    const { client, push } = createClient({ ...baseState, enabled: true })
    mountView(client)
    await nextTick()

    push({ ...baseState, enabled: true, recheckDelayMinutes: 2 })
    await nextTick()
    expect(queryInput().value).toBe('2')
  })

  it('状态回显自身上报的 null：不清空用户正在输入的文本', async () => {
    const { client, push } = createClient({ ...baseState, enabled: true })
    mountView(client)
    await nextTick()

    await inputDelay('26')
    push({ ...baseState, enabled: true, recheckDelayMinutes: null })
    await nextTick()
    expect(queryInput().value).toBe('26')
  })

  it('点击开关：调用 setEnabled', async () => {
    const { client, setEnabled } = createClient()
    const mounted = mountView(client)
    await nextTick()

    mounted.querySelector<HTMLButtonElement>('.switch')!.click()
    await nextTick()
    expect(setEnabled).toHaveBeenCalledWith({ enabled: true })
  })
})
