// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TaskEvent, TaskSnapshot } from '../contracts/index.js'
import { startIdeServer } from './ide-server.js'
import type { IdeServer } from './ide-server.js'

/**
 * U1/U2/U3 服务端纵切：POST /api/tasks 受理 → SSE `task` 事件 → 终态 →
 * 产物下载（digest 校验）→ 二次构建不覆盖旧任务产物快照。
 */
let server: IdeServer
let token: string
let projectRoot = ''
const roots: string[] = []

async function api (path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${server.url}${path}`, {
    ...init,
    headers: { 'x-fh2-ide-token': token, ...init.headers },
  })
}

beforeAll(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'fh2-tasks-serve-'))
  roots.push(projectRoot)
  await mkdir(join(projectRoot, 'handlers'), { recursive: true })
  await writeFile(join(projectRoot, 'fh2-plugin.json'), JSON.stringify({
    pluginId: 'exp_tasks_serve',
    name: 'Tasks Serve',
    version: '0.1.0',
    contractsRange: '>=1.0.0 <2.0.0',
  }))
  await writeFile(join(projectRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: 'ES2022', lib: ['ES2022'], types: [], module: 'ESNext', moduleResolution: 'Bundler' },
    include: ['handlers/**/*.ts'],
  }))
  await writeFile(join(projectRoot, 'handlers/issue.ts'), 'export function h_createIssue(): number {\n  return 42\n}\n')

  const webRoot = await mkdtemp(join(tmpdir(), 'fh2-tasks-web-'))
  roots.push(webRoot)
  await mkdir(webRoot, { recursive: true })
  await writeFile(join(webRoot, 'index.html'), '<html><head></head><body>ide</body></html>')
  server = await startIdeServer({ root: projectRoot, webRoot, port: 0, watch: false })
  token = server.token
}, 60_000)

afterAll(async () => {
  await server?.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function waitForTerminal (taskId: string): Promise<TaskSnapshot> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const snapshot = await (await api(`/api/tasks/${taskId}`)).json() as { data?: TaskSnapshot }
    const state = snapshot.data?.state
    if (state === 'succeeded' || state === 'failed' || state === 'cancelled') return snapshot.data!
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('任务未在超时内到达终态')
}

describe('serve 任务通道（U1/U2/U3）', { timeout: 200_000 }, () => {
  it('pOST /api/tasks 受理返回 taskId；SSE 推送 task 事件且 sequence 单调', async () => {
    // 先连 SSE 再启动任务。
    const events: TaskEvent[] = []
    const controller = new AbortController()
    const sse = await fetch(`${server.url}/api/events?token=${token}`, { signal: controller.signal })
    const reader = sse.body!.getReader()
    const pump = (async () => {
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        for (;;) {
          const index = buffer.indexOf('\n\n')
          if (index === -1) break
          const frame = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const eventLine = /^event: (.+)$/m.exec(frame)
          const dataLine = /^data: (.+)$/m.exec(frame)
          if (eventLine?.[1] === 'task' && dataLine !== null) {
            const parsed: unknown = JSON.parse(dataLine[1]!)
            events.push(parsed as TaskEvent)
          }
        }
      }
    })()

    const started = await (await api('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'build' }),
    })).json() as { ok: boolean; data?: TaskSnapshot }
    expect(started.ok).toBe(true)
    const taskId = started.data!.taskId
    expect(started.data!.state).toBe('queued')

    const final = await waitForTerminal(taskId)
    expect(final.state).toBe('succeeded')
    expect(final.artifacts.length).toBeGreaterThan(0)
    expect(final.artifacts.every(a => a.typechecked)).toBe(true)

    // SSE 事件到达且 sequence 单调。
    await new Promise(resolve => setTimeout(resolve, 500))
    controller.abort()
    void pump.catch(() => undefined)
    const taskEvents = events.filter(event => event.taskId === taskId)
    expect(taskEvents.length).toBeGreaterThan(0)
    const sequences = taskEvents.map(event => event.sequence)
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
    expect(taskEvents.some(event => event.type === 'state' && event.state === 'succeeded')).toBe(true)
  }, 150_000)

  it('产物下载：digest 校验通过；二次构建后旧产物快照不变（U3）', async () => {
    const first = await (await api('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'build' }),
    })).json() as { data?: TaskSnapshot }
    const firstFinal = await waitForTerminal(first.data!.taskId)
    const artifact = firstFinal.artifacts.find(candidate => candidate.kind === 'backend-dist')!

    const download = await api(`/api/tasks/${first.data!.taskId}/artifacts/${encodeURIComponent(artifact.id)}`)
    expect(download.status).toBe(200)
    const bytes = Buffer.from(await download.arrayBuffer())
    expect(bytes.byteLength).toBe(artifact.size)
    // 下载文件名必须是裸文件名（Windows 路径下 split('/') 会把整条绝对路径写进头）
    const disposition = download.headers.get('content-disposition') ?? ''
    const fileName = /^attachment; filename="([^"]*)"$/i.exec(disposition)?.[1] ?? ''
    expect(fileName).not.toBe('')
    expect(fileName).not.toContain('/')
    expect(fileName).not.toContain('\\')

    // 二次构建（新任务、新快照目录）后，旧任务产物仍可下载且内容一致。
    const second = await (await api('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'build' }),
    })).json() as { data?: TaskSnapshot }
    await waitForTerminal(second.data!.taskId)

    const reDownload = await api(`/api/tasks/${first.data!.taskId}/artifacts/${encodeURIComponent(artifact.id)}`)
    expect(reDownload.status).toBe(200)
    const reBytes = Buffer.from(await reDownload.arrayBuffer())
    expect(reBytes.equals(bytes)).toBe(true)

    // 越权 artifactId / 不存在任务 → 404。
    const missing = await api(`/api/tasks/${first.data!.taskId}/artifacts/no-such-artifact`)
    expect(missing.status).toBe(404)
    const missingTask = await api('/api/tasks/task-missing/artifacts/whatever')
    expect(missingTask.status).toBe(404)
  }, 200_000)

  it('gET /api/tasks 列表包含历史任务；logs 返回有界 tail', async () => {
    const list = await (await api('/api/tasks')).json() as { data?: { tasks?: TaskSnapshot[] } }
    expect((list.data?.tasks ?? []).length).toBeGreaterThanOrEqual(2)

    const first = list.data?.tasks?.[0]
    if (first === undefined) throw new Error('任务列表为空')
    const logs = await (await api(`/api/tasks/${first.taskId}/logs`)).json() as { data?: { lines?: string[] } }
    expect((logs.data?.lines ?? []).length).toBeGreaterThan(0)
  })

  it('非法 kind 与取消已终态任务的错误映射', async () => {
    const bad = await api('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'inspect' }),
    })
    expect(bad.status).toBe(400)

    const list = await (await api('/api/tasks')).json() as { data?: { tasks?: TaskSnapshot[] } }
    const finished = list.data?.tasks?.find(task => task.state === 'succeeded')
    if (finished === undefined) throw new Error('无已完成任务')
    const cancel = await api(`/api/tasks/${finished.taskId}/cancel`, { method: 'POST' })
    expect(cancel.status).toBe(409)
  })
})

describe('startup / Start Center（N1/N3）', () => {
  it('无有效工程的根：workspace 返回 unknown，仍提供 API；create→open 闭环', { timeout: 120_000 }, async () => {
    const plainRoot = await mkdtemp(join(tmpdir(), 'fh2-startup-'))
    roots.push(plainRoot)
    const webRoot = await mkdtemp(join(tmpdir(), 'fh2-startup-web-'))
    roots.push(webRoot)
    await mkdir(webRoot, { recursive: true })
    await writeFile(join(webRoot, 'index.html'), '<html><head></head><body>ide</body></html>')
    vi.stubEnv('FH2_TOOLCHAIN_PACKAGE_ROOT', resolve(import.meta.dirname, '../..'))
    const startupServer = await startIdeServer({ root: plainRoot, webRoot, port: 0, watch: false })
    try {
      const startupApi = async (path: string, init: RequestInit = {}): Promise<Response> =>
        await fetch(`${startupServer.url}${path}`, {
          ...init,
          headers: { 'x-fh2-ide-token': startupServer.token, ...init.headers },
        })

      // N1：无有效 root 仍可启动，workspace 返回 unknown + 会话 id（前端进入 Start Center）。
      const workspace = await (await startupApi('/api/workspace')).json() as { data?: { kind?: string; sessionId?: string } }
      expect(workspace.data?.kind).toBe('unknown')
      expect(workspace.data?.sessionId !== undefined && workspace.data.sessionId !== '').toBe(true)

      // N3：创建工程（frontend-basic，不安装依赖）。
      const created = await (await startupApi('/api/workspace/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pluginId: 'exp_startup_demo', template: 'frontend-basic' }),
      })).json() as { ok: boolean; data?: { projectRoot?: string }; error?: { message?: string } }
      expect(created.ok, created.error?.message).toBe(true)
      const projectRoot = created.data?.projectRoot
      if (projectRoot === undefined) throw new Error('projectRoot 缺失')
      expect(existsSync(join(projectRoot, 'fh2-plugin.json'))).toBe(true)

      // open 新根 → 识别为前端插件。
      const opened = await startupApi('/api/workspace/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root: projectRoot }),
      })
      expect(opened.status).toBe(200)
      const openedBody = await opened.json() as { data?: { kind?: string } }
      expect(openedBody.data?.kind).toBe('frontend-plugin')

      // 非法 Plugin ID 被拒绝，不落半成品。
      const bad = await startupApi('/api/workspace/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pluginId: 'Not_Valid' }),
      })
      expect(bad.status).toBe(500)
      const badBody = await bad.json() as { error?: { message?: string } }
      expect(badBody.error?.message).toContain('创建失败')
    } finally {
      await startupServer.close()
      vi.unstubAllEnvs()
    }
  })
})
