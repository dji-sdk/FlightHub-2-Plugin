// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AlertDispatchProjectContext } from '../../types'
import { activate } from './activate'

const manifest = JSON.parse(readFileSync(new URL('../../../fh2-plugin.json', import.meta.url), 'utf8'))

const viewMocks = vi.hoisted(() => ({
  formGet: vi.fn(() => ({ viewId: 'dispatch-form', initialState: null })),
  formHandle: vi.fn(async () => ({ dispose: vi.fn() })),
  workspaceGet: vi.fn(() => ({ viewId: 'dispatch-workspace', initialState: null })),
  workspaceHandle: vi.fn(async () => ({ dispose: vi.fn() })),
}))

vi.mock('../../views/dispatch-form/contract', () => ({
  dispatchFormView: { get: viewMocks.formGet, handle: viewMocks.formHandle },
}))

vi.mock('../../views/dispatch-workspace/contract', () => ({
  dispatchWorkspaceView: { get: viewMocks.workspaceGet, handle: viewMocks.workspaceHandle },
}))

function createProjectActivateFixture (enableWorkspaceTest: boolean): {
  contributions: Map<string, Record<string, unknown>>;
  ctx: AlertDispatchProjectContext;
} {
  const contributions = new Map<string, Record<string, unknown>>()
  const ctx = {
    config: { enableWorkspaceTest },
    extensions: {
      contribute: vi.fn(async (id: string, contribution: Record<string, unknown>) => {
        contributions.set(id, contribution)
        return { update: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }
      }),
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    apiCall: vi.fn(),
  } as unknown as AlertDispatchProjectContext
  return { contributions, ctx }
}

describe('警情派遣 Project 激活', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('插件身份、侧栏路由、扩展与图标声明和激活贡献一致', async () => {
    const fixture = createProjectActivateFixture(false)
    await activate(fixture.ctx)

    expect(manifest.id).toBe('official_alert_dispatch')
    const packageJson = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'))
    expect(packageJson.name).toBe('@traffic-capabilities/official-alert-dispatch')
    expect(manifest.extensions).toEqual([{
      id: 'alert-dispatch-sidebar-action',
      point: 'project.sidebar-actions',
      path: '/alert-dispatch',
      position: 2,
    }])
    expect([...fixture.contributions.keys()]).toEqual([manifest.extensions[0].id])
    const contribution = fixture.contributions.get(manifest.extensions[0].id)
    expect(contribution?.icon).toBe('alert-dispatch')
    expect(manifest.contributes.icons).toEqual([{
      id: contribution?.icon,
      src: './static/icons/dispatch.svg',
    }])
    expect(readFileSync(new URL('../../../public/static/icons/dispatch.svg', import.meta.url), 'utf8'))
      .toContain('<svg')
  })

  it('默认隐藏工作区：贡献不带 renderWorkspace，工作区 handler 不注册', async () => {
    const fixture = createProjectActivateFixture(false)

    const lifecycle = await activate(fixture.ctx)

    const contribution = fixture.contributions.get('alert-dispatch-sidebar-action')
    expect(contribution).toBeDefined()
    expect(typeof contribution?.render).toBe('function')
    expect(contribution?.renderWorkspace).toBeUndefined()
    expect((contribution?.render as () => unknown)()).toMatchObject({ viewId: 'dispatch-form' })

    expect(viewMocks.formHandle).toHaveBeenCalledOnce()
    expect(viewMocks.workspaceHandle).not.toHaveBeenCalled()

    await lifecycle?.dispose?.()
  })

  it('开启工作区测试配置：贡献同时注册 render 与 renderWorkspace', async () => {
    const fixture = createProjectActivateFixture(true)

    const lifecycle = await activate(fixture.ctx)

    const contribution = fixture.contributions.get('alert-dispatch-sidebar-action')
    expect(typeof contribution?.render).toBe('function')
    expect(typeof contribution?.renderWorkspace).toBe('function')
    expect(viewMocks.formHandle).toHaveBeenCalledOnce()
    expect(viewMocks.workspaceHandle).toHaveBeenCalledOnce()

    expect((contribution?.render as () => unknown)()).toMatchObject({ viewId: 'dispatch-form' })
    expect((contribution?.renderWorkspace as () => unknown)()).toMatchObject({ viewId: 'dispatch-workspace' })

    await lifecycle?.dispose?.()
  })

  it('lifecycle dispose 正常完成', async () => {
    const fixture = createProjectActivateFixture(false)
    const lifecycle = await activate(fixture.ctx)
    await expect(lifecycle?.dispose?.()).resolves.toBeUndefined()
  })
})
