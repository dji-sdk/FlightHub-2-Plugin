// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createApp, h, provide } from 'vue'
import { IDE_KEY } from '../composables/use-ide'
import type { IdeContext } from '../composables/use-ide'
import StartCenter from './startup/StartCenter.vue'

/**
 * StartCenter 挂载测试：沿用仓内先例（裸 createApp + DOM 断言）。
 * ideApi 以 vi.mock 打桩（workspaceCreate / taskGet）；context 桩可按用例覆盖
 * trackInstallTask / openWorkspacePath 的行为。
 */

const workspaceCreate = vi.fn()
const openWorkspacePath = vi.fn()
const trackInstallTask = vi.fn()

vi.mock('../api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api/client')>()
  return {
    ...original,
    ideApi: {
      ...original.ideApi,
      workspaceCreate: (options: unknown) => workspaceCreate(options),
      taskGet: async (taskId: string) => ({ taskId, state: 'running', lastSequence: 0 }),
    },
  }
})

interface Mount {
  readonly root: HTMLElement;
  readonly unmount: () => void;
}

const mounts: Mount[] = []

function mountStartCenter (): Mount {
  const pinia = createPinia()
  setActivePinia(pinia)
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({
    setup () {
      provide(IDE_KEY, stubContext())
      return () => h(StartCenter)
    },
  })
  app.use(pinia)
  app.mount(root)
  return { root, unmount: () => app.unmount() }
}

function stubContext (): IdeContext {
  return {
    start: vi.fn(),
    switchView: vi.fn(async () => {}),
    openFile: vi.fn(async () => {}),
    closeFile: vi.fn(),
    saveActive: vi.fn(async () => {}),
    saveAll: vi.fn(async () => true),
    runPack: vi.fn(async () => {}),
    cancelTask: vi.fn(async () => {}),
    openWorkspacePath: async root => openWorkspacePath(root),
    trackInstallTask: async (taskId, projectRoot) => await trackInstallTask(taskId, projectRoot),
    downloadArtifact: vi.fn(async () => {}),
    jumpTo: vi.fn(async () => {}),
    showTreeMenu: vi.fn(),
    promptCreate: vi.fn(async () => {}),
    createTreeEntry: vi.fn(async () => true),
    renameTreeEntry: vi.fn(async () => true),
    moveTreeEntry: vi.fn(async () => true),
    refreshTree: vi.fn(async () => {}),
    loadTreeChildren: vi.fn(async () => {}),
    runValidate: vi.fn(async () => {}),
    toggleRun: vi.fn(async () => {}),
    openRunUrl: vi.fn(),
    openInCanvas: vi.fn(async () => {}),
    revealWorkflowNode: vi.fn(async () => {}),
  }
}

beforeEach(() => {
  workspaceCreate.mockReset()
  openWorkspacePath.mockReset()
  trackInstallTask.mockReset()
})

afterEach(() => {
  for (const { unmount } of mounts.splice(0)) unmount()
})

/** 触发创建：默认模板/ID 合法（exp_my_plugin）。 */
async function submitCreate (root: HTMLElement): Promise<void> {
  const button = [...root.querySelectorAll('button')].find(candidate => candidate.textContent?.includes('创建并打开'))
  button?.click()
  await vi.waitFor(() => {
    if (workspaceCreate.mock.calls.length === 0) throw new Error('workspaceCreate 未被调用')
  })
}

/** 等待视图出现指定文本。 */
async function waitForText (root: HTMLElement, text: string): Promise<void> {
  await vi.waitFor(() => {
    if ((root.textContent ?? '').includes(text)) return
    throw new Error(`等待文本未出现：${text}`)
  })
}

describe('startCenter', () => {
  it('未勾选安装：创建成功直接打开，不进入安装阶段', async () => {
    workspaceCreate.mockResolvedValue({ projectRoot: '/tmp/x', log: [] })
    trackInstallTask.mockImplementation(async () => 'succeeded')
    const mount = mountStartCenter()
    mounts.push(mount)

    await submitCreate(mount.root)
    expect(workspaceCreate).toHaveBeenCalledTimes(1)
    expect(workspaceCreate).toHaveBeenCalledWith(expect.objectContaining({ template: 'capability-fullstack' }))
    expect(trackInstallTask).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(openWorkspacePath).toHaveBeenCalledWith('/tmp/x')
    })
    expect(mount.root.textContent).not.toContain('正在安装依赖')
  })

  it('带 installTaskId：进入安装等待视图，不切根；成功后打开', async () => {
    let releaseInstall: ((state: 'succeeded' | 'failed' | 'cancelled') => void) | undefined
    workspaceCreate.mockResolvedValue({ projectRoot: '/tmp/x', installTaskId: 'task-1', log: [] })
    trackInstallTask.mockImplementation(async () => await new Promise((resolve) => {
      releaseInstall = resolve
    }))
    const mount = mountStartCenter()
    mounts.push(mount)

    await submitCreate(mount.root)
    await waitForText(mount.root, '正在安装依赖')
    // 安装中：不打开工作区（stopAll 会取消任务）
    expect(openWorkspacePath).not.toHaveBeenCalled()
    expect(trackInstallTask).toHaveBeenCalledWith('task-1', '/tmp/x')

    releaseInstall?.('succeeded')
    await vi.waitFor(() => {
      expect(openWorkspacePath).toHaveBeenCalledWith('/tmp/x')
    })
  })

  it('安装失败：显示原因与「仍然打开」；点击后打开工作区', async () => {
    workspaceCreate.mockResolvedValue({ projectRoot: '/tmp/x', installTaskId: 'task-1', log: [] })
    trackInstallTask.mockResolvedValue('failed')
    const mount = mountStartCenter()
    mounts.push(mount)

    await submitCreate(mount.root)
    await waitForText(mount.root, '依赖安装未完成')
    expect(mount.root.textContent).toContain('自动重新安装依赖')

    const openAnyway = [...mount.root.querySelectorAll('button')].find(candidate => candidate.textContent?.includes('仍然打开'))
    expect(openAnyway).toBeDefined()
    openAnyway?.click()
    await vi.waitFor(() => {
      expect(openWorkspacePath).toHaveBeenCalledWith('/tmp/x')
    })
  })
})

describe('startCenter 创建入口', () => {
  it('只展示全栈工程类型，不再提供最近工程与路径打开', async () => {
    const mount = mountStartCenter()
    mounts.push(mount)

    await waitForText(mount.root, '创建并打开')
    expect(mount.root.textContent).toContain('全栈（前后端 Capability）')
    expect(mount.root.textContent).not.toContain('前端插件')
    expect(mount.root.textContent).not.toContain('后端插件')
    expect(mount.root.textContent).not.toContain('最近工程')
    expect(mount.root.textContent).not.toContain('或输入工程路径打开')
  })
})
