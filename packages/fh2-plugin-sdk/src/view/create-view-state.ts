// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { Disposable } from '../contracts/index.js'
import type { PluginViewStateSource } from './define-plugin-view.js'

/** Entry Realm 中持有并向 View 投影的响应式状态。 */
export interface PluginState<T> extends PluginViewStateSource<T> {
  /** 读取当前状态。 */
  get(): T;
  /** 以不可变 updater 提交下一状态。 */
  update(updater: (current: T) => T): void;
  /** 将完整状态持续映射为某个 View 所需的状态。 */
  map<TMapped>(
    mapper: (state: T) => TMapped,
    equals?: (previous: TMapped, next: TMapped) => boolean,
  ): PluginViewStateSource<TMapped>;
}

/** 创建由 Entry 持有、可直接作为 View state source 使用的状态。 */
export function createViewState<T> (initialState: T): PluginState<T> {
  let current = initialState
  const listeners = new Set<(state: T) => void>()

  const state: PluginState<T> = {
    get: () => current,
    update (updater) {
      const next = updater(current)
      if (Object.is(current, next)) return

      current = next
      for (const listener of [...listeners]) listener(next)
    },
    subscribe (listener): Disposable {
      listeners.add(listener)
      try {
        listener(current)
      } catch (error) {
        listeners.delete(listener)
        throw error
      }
      return {
        dispose: () => {
          listeners.delete(listener)
        },
      }
    },
    map<TMapped> (
      mapper: (value: T) => TMapped,
      equals: (previous: TMapped, next: TMapped) => boolean = shallowEqual,
    ): PluginViewStateSource<TMapped> {
      return {
        subscribe (listener) {
          let hasPrevious = false
          let previous: TMapped
          return state.subscribe((value) => {
            const next = mapper(value)
            if (hasPrevious && equals(previous, next)) return

            previous = next
            hasPrevious = true
            listener(next)
          })
        },
      }
    },
  }

  return state
}

function shallowEqual<T> (previous: T, next: T): boolean {
  if (Object.is(previous, next)) return true
  if (Array.isArray(previous) || Array.isArray(next)) {
    if (!Array.isArray(previous) || !Array.isArray(next) || previous.length !== next.length) return false
    return previous.every((value, index) => Object.is(value, next[index]))
  }
  if (!isRecord(previous) || !isRecord(next)) return false

  const previousKeys = Object.keys(previous)
  const nextKeys = Object.keys(next)
  if (previousKeys.length !== nextKeys.length) return false
  return previousKeys.every(key => (
    Object.hasOwn(next, key) && Object.is(previous[key], next[key])
  ))
}

function isRecord (value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}
