// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import type { PluginViewStateSource } from './define-plugin-view.js'
import { createViewState } from './create-view-state.js'

describe('createViewState', () => {
  it('同步发送当前状态并只通知新的根状态', () => {
    const state = createViewState({ count: 0 })
    const listener = vi.fn()
    const subscription = state.subscribe(listener)

    expect(state.get()).toEqual({ count: 0 })
    expect(listener).toHaveBeenCalledTimes(1)

    const current = state.get()
    state.update(() => current)
    expect(listener).toHaveBeenCalledTimes(1)

    state.update(value => ({ count: value.count + 1 }))
    expect(state.get()).toEqual({ count: 1 })
    expect(listener).toHaveBeenLastCalledWith({ count: 1 })

    subscription.dispose()
    state.update(value => ({ count: value.count + 1 }))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('updater 抛错时保留原状态且不通知', () => {
    const state = createViewState({ count: 0 })
    const listener = vi.fn()
    state.subscribe(listener)

    expect(() => state.update(() => {
      throw new Error('更新失败')
    })).toThrow('更新失败')
    expect(state.get()).toEqual({ count: 0 })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('支持多个独立订阅者', () => {
    const state = createViewState(0)
    const first = vi.fn()
    const second = vi.fn()
    const firstSubscription = state.subscribe(first)
    state.subscribe(second)

    firstSubscription.dispose()
    state.update(value => value + 1)

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenLastCalledWith(1)
  })

  it('map 持续映射状态并默认以浅比较抑制重复通知', () => {
    const state = createViewState({ enabled: true, count: 0 })
    const mapper = vi.fn((value: { enabled: boolean; count: number }) => ({
      enabled: value.enabled,
    }))
    const mapped: PluginViewStateSource<{ enabled: boolean }> = state.map(mapper)
    const listener = vi.fn()
    const subscription = mapped.subscribe(listener)

    state.update(value => ({ ...value, count: 1 }))
    expect(listener).toHaveBeenCalledTimes(1)

    state.update(value => ({ ...value, enabled: false }))
    expect(listener).toHaveBeenLastCalledWith({ enabled: false })

    subscription.dispose()
    state.update(value => ({ ...value, enabled: true }))
    expect(listener).toHaveBeenCalledTimes(2)
    expect(mapper).toHaveBeenCalledTimes(3)
  })

  it('map 支持自定义比较函数', () => {
    const state = createViewState({ count: 1 })
    const listener = vi.fn()
    state.map(
      value => value.count,
      (previous, next) => previous % 2 === next % 2,
    ).subscribe(listener)

    state.update(() => ({ count: 3 }))
    state.update(() => ({ count: 4 }))

    expect(listener.mock.calls).toEqual([[1], [4]])
  })
})
