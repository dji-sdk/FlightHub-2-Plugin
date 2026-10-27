// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import type { PluginContext } from '../contracts/index.js'
import { definePluginView } from './define-plugin-view.js'

interface TestState {
  readonly enabled: boolean;
}

interface TestContract {
  state: TestState;
  methods: {
    setEnabled: (input: { enabled: boolean }) => void;
    readLabel: () => string;
  };
}

const contract = definePluginView<TestContract>('settings')

describe('definePluginView typed client', () => {
  it('method proxy 发送参数数组并返回 typed result', async () => {
    const channel = new MessageChannel()
    const client = contract.client(channel.port1)
    channel.port2.start()
    channel.port2.addEventListener('message', (event) => {
      const request = event.data as { t?: string; id?: number; method?: string; args?: unknown }
      expect(request).toMatchObject({ t: 'req', method: 'setEnabled', args: [{ enabled: true }] })
      channel.port2.postMessage({ t: 'resp', id: request.id, ok: true })
    }, { once: true })

    await expect(client.setEnabled({ enabled: true })).resolves.toBeUndefined()
    client.dispose()
    channel.port2.close()
  })

  it('state 首次送达并向晚订阅者重放最新值', async () => {
    const channel = new MessageChannel()
    const client = contract.client(channel.port1)
    const direct = vi.fn()
    const replay = vi.fn()
    client.state.subscribe(direct)

    channel.port2.postMessage({ t: 'state', value: { enabled: false } })
    await vi.waitFor(() => {
      expect(direct).toHaveBeenCalledWith({ enabled: false })
    })

    client.state.subscribe(replay)
    expect(replay).toHaveBeenCalledWith({ enabled: false })
    client.dispose()
    channel.port2.close()
  })

  it('close 拒绝 pending method，且 client 不是 thenable', async () => {
    const channel = new MessageChannel()
    const client = contract.client(channel.port1)
    expect((client as unknown as { then?: unknown }).then).toBeUndefined()

    const pending = client.readLabel()
    channel.port2.postMessage({ t: 'close', reason: 'host unmount' })

    await expect(pending).rejects.toThrow('host unmount')
    channel.port2.close()
  })

  it('handle 只透传 session provider，不再维护 runtime 名称数组', async () => {
    const handle = vi.fn(async (_viewId: string, _provider: unknown) => ({ dispose: () => {} }))
    const ctx = { views: { handle } } as unknown as PluginContext
    const session = {
      state: {
        subscribe: (listener: (state: TestState) => void) => {
          listener({ enabled: true })
          return { dispose: () => {} }
        },
      },
      methods: {
        setEnabled: () => {},
        readLabel: () => '已启用',
      },
    }

    await contract.handle(ctx, session)

    expect(handle).toHaveBeenCalledWith('settings', expect.any(Function))
    const provider = handle.mock.calls[0]![1] as () => unknown
    expect(provider()).toBe(session)
  })

  it('initialState contract 生成 typed handle', () => {
    interface RecordContract {
      state: { readonly recordId: string; readonly loading: boolean };
      initialState: { readonly recordId: string };
    }
    const recordView = definePluginView<RecordContract>('record')
    const get = vi.fn((viewId: string, initialState?: unknown) => ({ viewId, initialState: initialState ?? null }))
    const ctx = { views: { get } } as unknown as PluginContext

    expect(recordView.get(ctx, { recordId: 'a' })).toEqual({
      viewId: 'record',
      initialState: { recordId: 'a' },
    })
  })

  it('类型拒绝非 state 子集的 initialState 和非法 method', () => {
    interface InvalidInitialStateContract {
      state: { readonly enabled: boolean };
      initialState: { readonly mode: string };
    }
    interface InvalidMethodContract {
      state: { readonly enabled: boolean };
      methods: { broken: string };
    }
    interface InvalidStateContract {
      state: { readonly callback: () => void };
    }
    interface InvalidMethodArgContract {
      state: { readonly enabled: boolean };
      methods: { upload: (input: { callback: () => void }) => void };
    }
    interface InvalidMethodResultContract {
      state: { readonly enabled: boolean };
      methods: { read: () => { callback: () => void } };
    }
    // @ts-expect-error initialState 必须是 state 子集
    definePluginView<InvalidInitialStateContract>('invalid-initial-state')
    // @ts-expect-error method 必须是零或一个参数的函数类型
    definePluginView<InvalidMethodContract>('invalid-method')
    // @ts-expect-error state 必须满足 PluginValue
    definePluginView<InvalidStateContract>('invalid-state')
    // @ts-expect-error method 参数必须满足 PluginValue
    definePluginView<InvalidMethodArgContract>('invalid-method-arg')
    // @ts-expect-error method 返回值必须满足 PluginValue
    definePluginView<InvalidMethodResultContract>('invalid-method-result')
  })
})
