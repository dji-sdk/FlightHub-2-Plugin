// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccidentMessageContext } from '../../types'
import type { DispatchCardState } from '../../views/dispatch-card/contract'
import { activate } from './activate'

const viewMocks = vi.hoisted(() => ({
  get: vi.fn(() => ({ viewId: 'dispatch-card', initialState: null })),
  handle: vi.fn(async (_context: unknown, _session: unknown) => ({ dispose: vi.fn() })),
}))
const flowMocks = vi.hoisted(() => ({
  open: vi.fn(async () => {}),
  refreshDevices: vi.fn(async () => {}),
  refreshRoutes: vi.fn(async () => {}),
  selectDevice: vi.fn(),
  selectRoute: vi.fn(),
  dispatch: vi.fn(async () => ({ accepted: true })),
  close: vi.fn(async () => {}),
  dispose: vi.fn(async () => {}),
}))

vi.mock('../../views/dispatch-card/contract', () => ({
  dispatchCardView: viewMocks,
}))
vi.mock('../../workflow/dispatch-session', () => ({
  buildCockpitUrl: vi.fn(() => '/cockpit'),
  createDispatchSession: vi.fn(() => flowMocks),
}))

describe('accident message activation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    flowMocks.dispatch.mockResolvedValue({ accepted: true })
  })

  it('可选宿主能力缺失时仍提供 alert-flow', async () => {
    const provide = vi.fn(async () => ({ dispose: vi.fn(async () => {}) }))
    const ctx = {
      config: { enableMultiAngle: false, flowName: 'flow' },
      capabilities: { get: vi.fn(async () => undefined) },
      extensions: {
        contribute: vi.fn(async () => ({ update: vi.fn(async () => {}), dispose: vi.fn(async () => {}) })),
      },
      services: { provide },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      apiCall: vi.fn(),
    } as unknown as AccidentMessageContext

    const lifecycle = await activate(ctx)

    expect(viewMocks.handle).toHaveBeenCalledOnce()
    expect(provide).toHaveBeenCalledWith(expect.objectContaining({ serviceId: 'alert-flow' }), expect.any(Object))
    await lifecycle?.dispose?.()
  })

  it('旧派遣通知完成时不关闭后来到达的新警情', async () => {
    let releaseNotification!: (value: { dispose(): void }) => void
    const notification = {
      show: vi.fn(() => new Promise<{ dispose(): void }>((resolve) => {
        releaseNotification = resolve
      })),
    }
    const ctx = {
      config: { enableMultiAngle: false, flowName: 'flow' },
      capabilities: {
        get: vi.fn(async (id: string) => id === 'platform:notification' ? notification : undefined),
      },
      extensions: {
        contribute: vi.fn(async () => ({ update: vi.fn(async () => {}), dispose: vi.fn(async () => {}) })),
      },
      services: { provide: vi.fn(async () => ({ dispose: vi.fn(async () => {}) })) },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      apiCall: vi.fn(),
    } as unknown as AccidentMessageContext
    await activate(ctx)
    const session = viewMocks.handle.mock.calls[0]?.[1] as {
      state: { update(updater: (current: DispatchCardState) => DispatchCardState): void };
      methods: { dispatch(): Promise<{ readonly accepted: boolean }> };
    }
    session.state.update(current => ({ ...current, popupId: 'popup-old' }))

    const pending = session.methods.dispatch()
    await vi.waitFor(() => expect(notification.show).toHaveBeenCalledOnce())
    session.state.update(current => ({ ...current, popupId: 'popup-new' }))
    releaseNotification({ dispose () {} })

    await expect(pending).resolves.toEqual({ accepted: false })
    expect(flowMocks.close).not.toHaveBeenCalled()
  })
})
