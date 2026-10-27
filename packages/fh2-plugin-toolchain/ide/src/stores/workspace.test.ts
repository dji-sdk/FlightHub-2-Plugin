// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkflowResources } from '../features/workflow/resources.js'
import { ideApi } from '../api/client.js'
import { applyBrowserTypeScriptDefaults, applyGojaTypeScriptDefaults, applyJsonSchemas }
  from '../editor/monaco-setup.js'
import { useStatusStore } from './status.js'
import { isGojaScript, useWorkspaceStore } from './workspace.js'

vi.mock('../api/client.js', () => ({
  ideApi: { actions: vi.fn() },
}))

vi.mock('../editor/monaco-setup.js', () => ({
  applyJsonSchemas: vi.fn(),
  applyGojaTypeScriptDefaults: vi.fn(),
  applyBrowserTypeScriptDefaults: vi.fn(),
}))

const actionsMock = vi.mocked(ideApi.actions)
const gojaDefaultsMock = vi.mocked(applyGojaTypeScriptDefaults)
const browserDefaultsMock = vi.mocked(applyBrowserTypeScriptDefaults)
const jsonSchemasMock = vi.mocked(applyJsonSchemas)

const WORKSPACE = { root: '/w', name: 'w', kind: 'frontend-plugin', toolchainVersion: '1.0.0', sessionId: 's1', diagnostics: [] } as const

beforeEach(() => {
  setActivePinia(createPinia())
  actionsMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('isGojaScript', () => {
  it('后端插件工作区全档 Goja；前端按 backend/ 目录分档；非脚本不入档', () => {
    expect(isGojaScript('backend/handlers/a.js', 'frontend-plugin')).toBe(true)
    expect(isGojaScript('src/plugin.ts', 'frontend-plugin')).toBe(false)
    expect(isGojaScript('any.js', 'backend-plugin')).toBe(true)
    expect(isGojaScript('README.md', 'backend-plugin')).toBe(false)
  })
})

describe('workspace store', () => {
  it('apply 写入信息与 schema，并重置 TS 档位到浏览器档', () => {
    const workspace = useWorkspaceStore()
    workspace.applyTypeScriptDefaults(true) // 先切到 Goja 档
    browserDefaultsMock.mockClear()

    workspace.apply(WORKSPACE, [])
    expect(workspace.info).toEqual(WORKSPACE)
    expect(workspace.schemas).toEqual([])
    expect(jsonSchemasMock).toHaveBeenCalledWith([])
    // gojaMode 被强制重写为浏览器档（null → false，再次写入 defaults）
    expect(browserDefaultsMock).toHaveBeenCalledTimes(1)
    expect(useWorkflowResources().workflowSchema.available).toBe(false)
  })

  it('applyTypeScriptDefaults 只在档位真变时写全局默认', () => {
    const workspace = useWorkspaceStore()
    expect(workspace.applyTypeScriptDefaults(true)).toBe(true)
    expect(gojaDefaultsMock).toHaveBeenCalledTimes(1)
    // 同档不重写
    expect(workspace.applyTypeScriptDefaults(true)).toBe(false)
    expect(gojaDefaultsMock).toHaveBeenCalledTimes(1)
    // 换档写
    expect(workspace.applyTypeScriptDefaults(false)).toBe(true)
    expect(browserDefaultsMock).toHaveBeenCalledTimes(1)
  })

  it('refreshCatalog 成功时更新词表，失败时降级并写状态栏', async () => {
    const workspace = useWorkflowResources()
    const status = useStatusStore()
    const result = {
      fixedSteps: [],
      scripts: [],
      triggerSeeds: {},
      runRoot: [],
      scriptAction: 'run_script',
      pluginActionPrefix: 'plugin.',
      stepStates: [],
      conditionOps: [],
      stepTriggers: [],
      grantableCaps: [],
      pluginManifestFound: false,
      catalogRevision: 'r1',
    }
    actionsMock.mockResolvedValue(result as never)
    await workspace.refreshCatalog()
    expect(workspace.catalog.available).toBe(true)
    expect(workspace.catalogDegraded).toBe(false)

    actionsMock.mockRejectedValue(new Error('boom'))
    await workspace.refreshCatalog()
    expect(workspace.catalog.available).toBe(false)
    expect(workspace.catalogDegraded).toBe(true)
    expect(status.message).toBe('平台动作目录未加载，工作流画布已降级为不检查入参模式。')
    expect(status.isError).toBe(false)
  })

  it('无参 refreshCatalog 沿用最近一次带路径的刷新；reset() 清空该记忆', async () => {
    const workspace = useWorkflowResources()
    const withScripts = {
      fixedSteps: [],
      scripts: [{ id: 'cascade-ingest', allowlist: [], inputs: [], outputs: [] }],
      triggerSeeds: {},
      runRoot: [],
      scriptAction: 'run_script',
      pluginActionPrefix: 'plugin.',
      stepStates: [],
      conditionOps: [],
      stepTriggers: [],
      grantableCaps: [],
      pluginManifestFound: true,
      pluginManifestPath: 'backend/fh2-plugin.json',
      catalogRevision: 'r1',
    }
    actionsMock.mockResolvedValue(withScripts as never)

    // 画布打开工作流 → 带路径刷新拿到 scripts
    await workspace.refreshCatalog('backend/workflows/a.json')
    expect(actionsMock).toHaveBeenLastCalledWith('backend/workflows/a.json')
    expect(workspace.catalog.scripts.map(script => script.id)).toEqual(['cascade-ingest'])

    // 工程配置刷新（无参）必须沿用该路径，而不是拿多后端工作区的空词表覆盖
    await workspace.refreshCatalog()
    expect(actionsMock).toHaveBeenLastCalledWith('backend/workflows/a.json')
    expect(workspace.catalog.scripts.map(script => script.id)).toEqual(['cascade-ingest'])

    // 切换工作区 → 记忆清空，回到无参的默认行为
    workspace.reset()
    await workspace.refreshCatalog()
    expect(actionsMock).toHaveBeenLastCalledWith(undefined)
  })

  it('selfInitiatedRoot 可直接读写（SSE 回声抑制标记）', () => {
    const workspace = useWorkspaceStore()
    expect(workspace.selfInitiatedRoot).toBeNull()
    workspace.selfInitiatedRoot = '/target'
    expect(workspace.selfInitiatedRoot).toBe('/target')
  })
})
