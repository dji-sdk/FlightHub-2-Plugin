// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppCockpitContext } from '../src/generated/plugin-types'
import type { IssuePanelState } from '../src/views/issue-panel/contract'
import { registerIssueExample } from '../src/hosts/cockpit/issue-example'

const mocks = vi.hoisted(() => ({
  panelHandle: vi.fn(),
  panelGet: vi.fn((_ctx: unknown) => ({ viewId: 'issue-panel', initialState: null })),
  dialogHandle: vi.fn(),
  dialogGet: vi.fn((_ctx: unknown) => ({ viewId: 'issue-dialog', initialState: null })),
}))

vi.mock('../src/views/issue-panel/contract', () => ({
  issuePanelView: { handle: mocks.panelHandle, get: mocks.panelGet },
}))
vi.mock('../src/views/issue-dialog/contract', () => ({
  issueDialogView: { handle: mocks.dialogHandle, get: mocks.dialogGet },
}))

interface ContributionHandle extends Record<string, unknown> {
  readonly update: ReturnType<typeof vi.fn>;
}

function createContext (dialogCapability: unknown): {
  readonly ctx: AppCockpitContext;
  readonly contributions: Map<string, ContributionHandle>;
} {
  const contributions = new Map<string, ContributionHandle>()
  const ctx = {
    capabilities: { get: vi.fn(async () => dialogCapability) },
    extensions: {
      contribute: vi.fn(async (id: string, contribution: Record<string, unknown>) => {
        const handle = { ...contribution, update: vi.fn() } as ContributionHandle
        contributions.set(id, handle)
        return handle
      }),
    },
  } as unknown as AppCockpitContext
  return { ctx, contributions }
}

describe('cockpit 现场问题示例', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('入口切换面板可见性并同步激活态图标', async () => {
    const { ctx, contributions } = createContext(undefined)
    await registerIssueExample(ctx)

    const entry = contributions.get('issue-entry') as { onTrigger: () => Promise<void>; update: ReturnType<typeof vi.fn> }
    const panel = contributions.get('issue-panel')!
    await entry.onTrigger()
    expect(panel.update).toHaveBeenCalledWith({ visible: true })
    expect(entry.update).toHaveBeenCalledWith({ active: true, icon: 'issue-active' })

    await entry.onTrigger()
    expect(panel.update).toHaveBeenCalledWith({ visible: false })
    expect(entry.update).toHaveBeenCalledWith({ active: false, icon: 'issue' })
  })

  it('面板请求上报时通过 platform:dialog 打开宿主弹窗', async () => {
    const open = vi.fn(async () => ({ close: vi.fn(async () => {}), closed: Promise.resolve() }))
    const { ctx } = createContext({ open })
    await registerIssueExample(ctx)

    const registration = mocks.panelHandle.mock.calls[0]?.[1] as { methods: { requestCreate: () => Promise<void> } }
    await registration.methods.requestCreate()
    expect(open).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledWith(mocks.dialogGet.mock.results[0]?.value, { title: '上报现场问题', width: 520 })
  })

  it('弹窗提交后新增问题并关闭弹窗', async () => {
    const close = vi.fn(async () => {})
    const closed = new Promise<void>(() => {})
    const open = vi.fn(async () => ({ close, closed }))
    const { ctx } = createContext({ open })
    await registerIssueExample(ctx)

    const panelRegistration = mocks.panelHandle.mock.calls[0]?.[1] as {
      state: { get: () => IssuePanelState };
      methods: { requestCreate: () => Promise<void> };
    }
    const dialogRegistration = mocks.dialogHandle.mock.calls[0]?.[1] as {
      methods: { submit: (input: { title: string; description: string; severity: 'low' }) => Promise<void> };
    }
    const before = panelRegistration.state.get().issues.length
    await panelRegistration.methods.requestCreate()

    await dialogRegistration.methods.submit({ title: '浏览器联调问题', description: '验证弹窗提交', severity: 'low' })

    const issues = panelRegistration.state.get().issues
    expect(issues).toHaveLength(before + 1)
    expect(issues[0]).toMatchObject({ title: '浏览器联调问题', status: 'new' })
    expect(close).toHaveBeenCalledOnce()
  })

  it('宿主未提供弹窗能力时在面板内提示', async () => {
    const { ctx } = createContext(undefined)
    await registerIssueExample(ctx)

    const registration = mocks.panelHandle.mock.calls[0]?.[1] as {
      state: { get: () => IssuePanelState };
      methods: { requestCreate: () => Promise<void> };
    }
    await registration.methods.requestCreate()
    expect(mocks.dialogGet).not.toHaveBeenCalled()
    expect(registration.state.get().error).toContain('弹窗')
  })

  it('dismiss 隐藏面板并复位入口激活态', async () => {
    const { ctx, contributions } = createContext(undefined)
    await registerIssueExample(ctx)

    const entry = contributions.get('issue-entry') as { onTrigger: () => Promise<void>; update: ReturnType<typeof vi.fn> }
    const panel = contributions.get('issue-panel')!
    await entry.onTrigger()

    const registration = mocks.panelHandle.mock.calls[0]?.[1] as { methods: { dismiss: () => Promise<void> } }
    await registration.methods.dismiss()
    expect(panel.update).toHaveBeenCalledWith({ visible: false })
    expect(entry.update).toHaveBeenCalledWith({ active: false, icon: 'issue' })
  })
})
