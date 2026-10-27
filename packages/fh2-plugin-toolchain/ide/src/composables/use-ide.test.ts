// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createApp } from 'vue'
import type { App } from 'vue'
import { ideApi } from '../api/client.js'
import { closeDialog, dialogState } from '../services/dialog.js'
import { useDocumentsStore } from '../stores/documents.js'
import { useProblemsStore } from '../stores/problems.js'
import { useRunStore } from '../stores/run.js'
import { useSettingsStore } from '../stores/settings.js'
import { isWorkspaceDiscoveryPath, useIde } from './use-ide.js'
import type { IdeContext } from './use-ide.js'

describe('isWorkspaceDiscoveryPath', () => {
  it('只匹配会改变工作区 discovery 的 JSON 文件', () => {
    expect(isWorkspaceDiscoveryPath('packages.json')).toBe(true)
    expect(isWorkspaceDiscoveryPath('official_parking/capabilities.json')).toBe(true)
    expect(isWorkspaceDiscoveryPath('official_parking/frontend/official_ui/fh2-plugin.json')).toBe(true)
    expect(isWorkspaceDiscoveryPath('src/main.ts')).toBe(false)
    expect(isWorkspaceDiscoveryPath('workflows/demo.json')).toBe(false)
  })
})

describe('useIde 运行目标选择', () => {
  let app: App<Element> | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    closeDialog(null)
    app?.unmount()
    app = null
    vi.restoreAllMocks()
  })

  it('多目标每次启动都弹窗，并以上次选择作为默认值', async () => {
    const targets = [
      { projectPath: 'official_accident', label: '事故快处', kind: 'capability-project', modes: ['dev'] },
      { projectPath: 'official_parking', label: '违停巡逻', kind: 'capability-project', modes: ['dev'] },
    ] as const
    vi.spyOn(ideApi, 'runTargets').mockResolvedValue({ targets })
    const start = vi.spyOn(ideApi, 'runStart').mockImplementation(async (mode, options) => ({
      mode,
      status: 'starting',
      projectPath: options?.projectPath ?? '',
    }))

    let ide: IdeContext | undefined
    app = createApp({
      setup () {
        ide = useIde()
        return () => null
      },
    })
    app.use(createPinia())
    const root = document.createElement('div')
    document.body.append(root)
    app!.mount(root)

    const first = ide!.toggleRun('dev')
    await vi.waitFor(() => expect(dialogState().current?.spec.title).toBe('选择 dev 运行目标'))
    expect(dialogState().current?.spec.fields?.[0]).toMatchObject({ value: 'official_accident' })
    closeDialog({ projectPath: 'official_parking' })
    await first
    expect(start).toHaveBeenLastCalledWith('dev', { projectPath: 'official_parking' })

    useRunStore().setProcesses([])
    const second = ide!.toggleRun('dev')
    await vi.waitFor(() => expect(dialogState().current?.spec.title).toBe('选择 dev 运行目标'))
    expect(dialogState().current?.spec.fields?.[0]).toMatchObject({ value: 'official_parking' })
    closeDialog({ projectPath: 'official_parking' })
    await second
    expect(start).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])('端口冲突：用户确认=%s，取消不重试，确认携服务端token重试', async (confirmed) => {
    vi.spyOn(ideApi, 'runTargets').mockResolvedValue({ targets: [{ projectPath: '.', label: '测试', kind: 'frontend-plugin', modes: ['dev'] }] })
    const start = vi.spyOn(ideApi, 'runStart').mockResolvedValueOnce({ mode: 'dev', status: 'failed', projectPath: '.', portConflict: { port: 5175, processes: [{ pid: 123, command: 'node' }], confirmationToken: 'confirm-port', message: '端口已占用' } }).mockResolvedValue({ mode: 'dev', status: 'starting', projectPath: '.' })
    let ide!: IdeContext
    app = createApp({ setup () {
      ide = useIde()
      return () => null
    } })
    app.use(createPinia())
    app.mount(document.createElement('div'))
    const starting = ide.toggleRun('dev')
    await vi.waitFor(() => expect(dialogState().current?.spec.title).toContain('5175'))
    expect(dialogState().current?.spec.body).toContain('node（PID 123）')
    expect(start).toHaveBeenCalledOnce()
    closeDialog(confirmed ? {} : null)
    await starting
    expect(start).toHaveBeenCalledTimes(confirmed ? 2 : 1)
    if (confirmed) expect(start).toHaveBeenLastCalledWith('dev', { projectPath: '.', port: 5175, portConfirmation: 'confirm-port' })
    else expect(useRunStore().statusOf('dev')?.status).toBe('failed')
  })

  it('preview 提示 HTTP 项目页、PAC 同源和手填本次资源根，只透传用户输入且不自动打开', async () => {
    vi.spyOn(ideApi, 'runTargets').mockResolvedValue({ targets: [{ projectPath: '.', label: '测试', kind: 'frontend-plugin', modes: ['preview'] }] })
    const target = 'http://fh2.example.com/project?org=1#/team'
    const start = vi.spyOn(ideApi, 'runStart').mockResolvedValue({ mode: 'preview', status: 'running', projectPath: '.', url: 'http://fh2.example.com/project?org=1&fh2-plugin-debug=1#/team' })
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    let ide!: IdeContext
    app = createApp({ setup () {
      ide = useIde()
      return () => null
    } })
    app.use(createPinia())
    app.mount(document.createElement('div'))

    const starting = ide.toggleRun('preview')
    await vi.waitFor(() => expect(dialogState().current?.spec.title).toBe('在真实司空中预览本地前端？'))
    const spec = dialogState().current!.spec
    const field = spec.fields?.find(field => field.name === 'target')
    expect(field).toMatchObject({
      kind: 'text',
      label: '司空项目页地址',
      placeholder: 'http://fh2.example.com/project?org=1（必填）',
      hint: expect.stringContaining('完整 HTTP URL'),
    })
    expect(field).not.toHaveProperty('value')
    const body = spec.body!.join('\n')
    expect(body).toContain('不支持 HTTPS')
    expect(body).toContain('SwitchyOmega')
    expect(body).toContain('PAC')
    expect(body).toContain('同一 Origin（协议、主机、端口）')
    expect(body).toContain('手动填写')
    expect(body).toContain('本次会话的资源根 URL')
    expect(body).toContain('不会自动预填来源或 session')
    expect(body).toContain('不是 localhost 单插件 Manifest URL')
    expect(body).not.toContain('本地静态服务')
    closeDialog({ target, ack: true })
    await starting

    expect(start).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledWith('preview', { projectPath: '.', target })
    expect(dialogState().current).toBeNull()
    expect(open).not.toHaveBeenCalled()
  })

  it.each([null, { target: 'http://fh2.example.com/project?org=1', ack: false }])('preview 取消或未勾选确认时不请求运行（%s）', async (result) => {
    const targets = vi.spyOn(ideApi, 'runTargets')
    const start = vi.spyOn(ideApi, 'runStart')
    let ide!: IdeContext
    app = createApp({ setup () {
      ide = useIde()
      return () => null
    } })
    app.use(createPinia())
    app.mount(document.createElement('div'))

    const starting = ide.toggleRun('preview')
    await vi.waitFor(() => expect(dialogState().current?.spec.title).toBe('在真实司空中预览本地前端？'))
    closeDialog(result)
    await starting
    expect(targets).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })
})

describe('useIde 自动保存', () => {
  let app: App<Element> | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    useSettingsStore().setAutoSave(true)
  })

  afterEach(() => {
    vi.useRealTimers()
    app?.unmount()
    app = null
    vi.restoreAllMocks()
  })

  function mountIde (): void {
    app = createApp({ setup () {
      useIde()
      return () => null
    } })
    app.use(createPinia())
    app.mount(document.createElement('div'))
  }

  it('编辑静默期后自动落盘；save 走 revision 串行链', async () => {
    const writeFile = vi.spyOn(ideApi, 'writeFile').mockResolvedValue({ revision: 'rev-2', path: 'x', bytesWritten: 1 })
    mountIde()
    const documents = useDocumentsStore()
    documents.openDetached('auto-1.txt', 'x', 'rev-1')
    const version = documents.modelVersion('auto-1.txt')!
    expect(documents.applyEdit('auto-1.txt', 'y', version)).toBe(true)
    expect(documents.isDirty('auto-1.txt')).toBe(true)

    await vi.advanceTimersByTimeAsync(800)
    expect(writeFile).toHaveBeenCalledOnce()
    expect(writeFile).toHaveBeenCalledWith('auto-1.txt', 'y', 'rev-1')
  })

  it('关闭自动保存后编辑不落盘', async () => {
    const writeFile = vi.spyOn(ideApi, 'writeFile').mockResolvedValue({ revision: 'rev-2', path: 'x', bytesWritten: 1 })
    mountIde()
    useSettingsStore().setAutoSave(false)
    const documents = useDocumentsStore()
    documents.openDetached('auto-2.txt', 'x', 'rev-1')
    const version = documents.modelVersion('auto-2.txt')!
    documents.applyEdit('auto-2.txt', 'y', version)

    await vi.advanceTimersByTimeAsync(800)
    expect(writeFile).not.toHaveBeenCalled()
    expect(documents.isDirty('auto-2.txt')).toBe(true)
  })

  it('非编辑产生的未保存草稿（openUnsaved）不被自动写盘', async () => {
    const writeFile = vi.spyOn(ideApi, 'writeFile').mockResolvedValue({ revision: 'rev-2', path: 'x', bytesWritten: 1 })
    mountIde()
    const documents = useDocumentsStore()
    documents.openUnsaved('auto-3.txt', '草稿内容')

    await vi.advanceTimersByTimeAsync(2000)
    expect(writeFile).not.toHaveBeenCalled()
    expect(documents.isDirty('auto-3.txt')).toBe(true)
  })

  it('持续输入重置静默期：只保存最终内容一次', async () => {
    const writeFile = vi.spyOn(ideApi, 'writeFile').mockResolvedValue({ revision: 'rev-2', path: 'x', bytesWritten: 1 })
    mountIde()
    const documents = useDocumentsStore()
    documents.openDetached('auto-4.txt', 'x', 'rev-1')
    let version = documents.modelVersion('auto-4.txt')!
    documents.applyEdit('auto-4.txt', 'y', version)
    await vi.advanceTimersByTimeAsync(500)
    version = documents.modelVersion('auto-4.txt')!
    documents.applyEdit('auto-4.txt', 'z', version)

    await vi.advanceTimersByTimeAsync(800)
    expect(writeFile).toHaveBeenCalledOnce()
    expect(writeFile).toHaveBeenCalledWith('auto-4.txt', 'z', 'rev-1')
  })
})

describe('useIde 手动检查工程', () => {
  let app: App<Element> | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    app?.unmount()
    app = null
    vi.restoreAllMocks()
  })

  it('清空旧问题后再写入本轮校验结果', async () => {
    vi.spyOn(ideApi, 'validate').mockResolvedValue({ ok: true, diagnostics: [], durationMs: 1 })

    let ide: IdeContext | undefined
    app = createApp({
      setup () {
        ide = useIde()
        return () => null
      },
    })
    app.use(createPinia())
    app.mount(document.createElement('div'))

    const problems = useProblemsStore()
    problems.setProblems('workflow', [{
      origin: 'workflow',
      severity: 'error',
      path: 'workflows/old.json',
      line: 1,
      column: 1,
      code: 'OLD',
      message: '上一轮遗留问题',
      source: 'workflow',
    }])
    problems.setEditorProblems([{
      origin: 'editor',
      severity: 'warning',
      path: 'src/old.ts',
      line: 1,
      column: 1,
      code: 'OLD_EDITOR',
      message: '旧编辑器问题',
      source: 'editor',
    }])

    await ide!.runValidate()

    expect(ideApi.validate).toHaveBeenCalledOnce()
    expect(problems.items).toEqual([])
  })
})
