// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccidentProjectContext } from '../../types'
import { activate } from './activate'

const viewMocks = vi.hoisted(() => ({
  listGet: vi.fn(() => ({ viewId: 'accident-list', initialState: null })),
  listHandle: vi.fn(async () => ({ dispose: vi.fn() })),
  dialogGet: vi.fn(() => ({ viewId: 'all-events-dialog', initialState: null })),
  dialogHandle: vi.fn(async () => ({ dispose: vi.fn() })),
}))

vi.mock('../../views/accident-list/contract', () => ({
  accidentListView: { get: viewMocks.listGet, handle: viewMocks.listHandle },
  allEventsDialogView: { get: viewMocks.dialogGet, handle: viewMocks.dialogHandle },
}))

type ApiCallMock = ReturnType<typeof vi.fn>

interface ContextMenuRegistrationInput {
  readonly id: string;
  readonly label: string;
  readonly group?: { readonly id: string; readonly label: string };
  onTrigger(event: { readonly position: { readonly lat: number; readonly lng: number; readonly height: number } | null }): void | Promise<void>;
}

function createProjectActivateFixture (
  apiCall: ApiCallMock,
  capabilityOverrides: Record<string, Record<string, unknown>> = {},
): {
    contributions: Map<string, Record<string, unknown>>;
    on: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    setInterval: ReturnType<typeof vi.fn>;
    clearInterval: ReturnType<typeof vi.fn>;
    location: {
      getState: ReturnType<typeof vi.fn>;
      onStateChanged: ReturnType<typeof vi.fn>;
    };
    ctx: AccidentProjectContext;
  } {
  const contributions = new Map<string, Record<string, unknown>>()
  const on = vi.fn(async () => ({ dispose: vi.fn(async () => {}) }))
  const connect = vi.fn(async () => ({ requestDispatch: vi.fn(), on, dispose: vi.fn(async () => {}) }))
  let pollHandleSeq = 0
  const setInterval = vi.fn(() => ++pollHandleSeq)
  const clearInterval = vi.fn()
  const location = {
    getState: vi.fn(async () => ({ pathname: '/organization/o1/project/p1', search: '', hash: '' })),
    onStateChanged: vi.fn(async () => ({ dispose: vi.fn(async () => {}) })),
  }
  const ctx = {
    config: { enableMultiAngle: false, flowName: 'flow' },
    capabilities: {
      get: vi.fn(async (id: string) => id === 'project:context'
        ? {
            getState: vi.fn(async () => ({
              projectId: 'project-1',
              organizationId: 'organization-1',
              userInfo: { org_role: null, project_role: null, user_id: null, nick_name: null, account: null },
            })),
            onStateChanged: vi.fn(async () => ({ dispose: vi.fn() })),
          }
        : capabilityOverrides[id] ?? (id === 'platform:location' ? location : undefined)),
    },
    extensions: {
      contribute: vi.fn(async (id: string, contribution: Record<string, unknown>) => {
        contributions.set(id, contribution)
        return { update: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }
      }),
    },
    services: { connect },
    ws: { onBizCode: vi.fn(async () => {
      throw new Error('WS 未初始化')
    }) },
    timers: { setInterval, clearInterval, setTimeout: vi.fn(), clearTimeout: vi.fn() },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    apiCall,
  } as unknown as AccidentProjectContext
  return { contributions, on, connect, setInterval, clearInterval, location, ctx }
}

type ProjectActivateFixture = ReturnType<typeof createProjectActivateFixture>

function getLocationHandler (fixture: ProjectActivateFixture): (state: { hash: string }) => void {
  const handler = fixture.location.onStateChanged.mock.calls[0]?.[0]
  if (typeof handler !== 'function') throw new Error('platform:location onStateChanged 尚未订阅')
  return handler as (state: { hash: string }) => void
}

describe('accident project activation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('message Host 缺席时仍激活列表并启动查询与轮询', async () => {
    const apiCall = vi.fn(async () => ({ code: 0, data: { list: [] } }))
    const fixture = createProjectActivateFixture(apiCall)

    const lifecycle = await activate(fixture.ctx)

    expect(fixture.contributions.has('accident-sidebar-action')).toBe(true)
    expect(viewMocks.listHandle).toHaveBeenCalledOnce()
    expect(fixture.connect).toHaveBeenCalledOnce()
    expect(fixture.on).toHaveBeenCalledWith('stateChanged', expect.any(Function))
    expect(apiCall).toHaveBeenCalledWith('/plugin-scene/data-store/events/query', expect.any(Object))
    expect(fixture.setInterval).toHaveBeenCalledOnce()
    expect(fixture.ctx.logger.warn).toHaveBeenCalledWith('警情实时通知不可用，继续使用轮询', { message: 'WS 未初始化' })

    await lifecycle?.dispose?.()
  })

  it('首拉挂起时不阻塞激活：activate 立即完成并启动轮询', async () => {
    const neverSettlingApiCall = vi.fn(() => new Promise(() => {}))
    const fixture = createProjectActivateFixture(neverSettlingApiCall)

    const lifecycle = await activate(fixture.ctx)

    expect(fixture.contributions.has('accident-sidebar-action')).toBe(true)
    expect(viewMocks.listHandle).toHaveBeenCalledOnce()
    expect(neverSettlingApiCall).toHaveBeenCalledWith('/plugin-scene/data-store/events/query', expect.any(Object))
    expect(fixture.setInterval).toHaveBeenCalledOnce()

    await lifecycle?.dispose?.()
  })

  it('注册地图右键菜单「获取并复制经纬度」，回调经剪贴板复制坐标', async () => {
    const apiCall = vi.fn(async () => ({ code: 0, data: { list: [] } }))
    const disposeMenu = vi.fn(async () => {})
    const writeText = vi.fn(async () => {})
    const show = vi.fn(async () => {})
    let menuInput: ContextMenuRegistrationInput | undefined
    const fixture = createProjectActivateFixture(apiCall, {
      'platform:map': {
        registerContextMenuItem: vi.fn(async (input: ContextMenuRegistrationInput) => {
          menuInput = input
          return { dispose: disposeMenu }
        }),
      },
      'platform:clipboard': { writeText },
      'platform:notification': { show },
    })

    const lifecycle = await activate(fixture.ctx)

    expect(menuInput).toMatchObject({
      id: 'copy-coordinates',
      label: '获取并复制经纬度',
      group: { id: 'location', label: '位置' },
    })
    await menuInput!.onTrigger({ position: { lat: 22.5431, lng: 114.0579, height: 0 } })
    expect(writeText).toHaveBeenCalledWith({ text: '22.5431,114.0579' })
    expect(show).not.toHaveBeenCalled()

    await menuInput!.onTrigger({ position: null })
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ intent: 'warning' }))

    await lifecycle?.dispose?.()
    expect(disposeMenu).toHaveBeenCalledOnce()
  })

  it('剪贴板写入失败时通过通知提示错误', async () => {
    const apiCall = vi.fn(async () => ({ code: 0, data: { list: [] } }))
    const writeText = vi.fn(async () => {
      throw new Error('execCommand copy 失败')
    })
    const show = vi.fn(async () => {})
    let menuInput: ContextMenuRegistrationInput | undefined
    const fixture = createProjectActivateFixture(apiCall, {
      'platform:map': {
        registerContextMenuItem: vi.fn(async (input: ContextMenuRegistrationInput) => {
          menuInput = input
          return { dispose: vi.fn(async () => {}) }
        }),
      },
      'platform:clipboard': { writeText },
      'platform:notification': { show },
    })

    const lifecycle = await activate(fixture.ctx)

    await menuInput!.onTrigger({ position: { lat: 22.5431, lng: 114.0579, height: 0 } })
    expect(fixture.ctx.logger.error).toHaveBeenCalledWith('复制经纬度失败', { message: 'execCommand copy 失败' })
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ intent: 'error' }))

    await lifecycle?.dispose?.()
  })

  it('地图或剪贴板能力缺失时不注册右键菜单', async () => {
    const apiCall = vi.fn(async () => ({ code: 0, data: { list: [] } }))
    const registerContextMenuItem = vi.fn()
    const fixture = createProjectActivateFixture(apiCall, {
      'platform:map': { registerContextMenuItem },
    })

    const lifecycle = await activate(fixture.ctx)

    expect(registerContextMenuItem).not.toHaveBeenCalled()
    expect(fixture.ctx.logger.warn).toHaveBeenCalledWith('Project Host 未提供 platform:clipboard，地图右键复制经纬度不可用')

    await lifecycle?.dispose?.()
  })

  it('初始即在驾驶舱时不首拉不轮询，离开后刷新并恢复轮询', async () => {
    const apiCall = vi.fn(async () => ({ code: 0, data: { list: [] } }))
    const fixture = createProjectActivateFixture(apiCall)
    fixture.location.getState.mockResolvedValue({ pathname: '/organization/o1/project/p1', search: '', hash: '#/cockpit' })

    const lifecycle = await activate(fixture.ctx)

    expect(apiCall).not.toHaveBeenCalledWith('/plugin-scene/data-store/events/query', expect.any(Object))
    expect(fixture.setInterval).not.toHaveBeenCalled()

    getLocationHandler(fixture)({ hash: '' })

    await vi.waitFor(() => {
      expect(apiCall).toHaveBeenCalledWith('/plugin-scene/data-store/events/query', expect.any(Object))
    })
    expect(fixture.setInterval).toHaveBeenCalledOnce()

    await lifecycle?.dispose?.()
  })

  it('进入驾驶舱暂停轮询，离开恢复且重复通知不重复建定时器', async () => {
    const apiCall = vi.fn(async () => ({ code: 0, data: { list: [] } }))
    const fixture = createProjectActivateFixture(apiCall)

    const lifecycle = await activate(fixture.ctx)
    const handler = getLocationHandler(fixture)

    handler({ hash: '#/cockpit' })
    expect(fixture.clearInterval).toHaveBeenCalledWith(1)

    handler({ hash: '#/cockpit' })
    expect(fixture.setInterval).toHaveBeenCalledOnce()

    handler({ hash: '' })
    expect(fixture.setInterval).toHaveBeenCalledTimes(2)
    expect(fixture.clearInterval).toHaveBeenCalledOnce()

    handler({ hash: '' })
    expect(fixture.setInterval).toHaveBeenCalledTimes(2)

    await lifecycle?.dispose?.()
    handler({ hash: '#/cockpit' })
    expect(fixture.clearInterval).toHaveBeenCalledTimes(2)
  })
})
