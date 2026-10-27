// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { DevExecutorOptions } from '../services/tasks/executors/dev.js'
import { createTaskService } from '../services/tasks/factory.js'
import type { ArtifactDescriptor, TaskEvent, TaskKind, TaskOwner, TaskSnapshot } from '../contracts/index.js'
import { TaskError } from '../services/tasks/task-service.js'
import type { InMemoryTaskService, TaskServiceOptions } from '../services/tasks/task-service.js'
import { createProject } from '../services/application/create.js'
import { IdeRequestError } from '../contracts/ide.js'

/**
 * Serve 任务桥（U1/U2/U3 的服务端）：
 *
 * - Serve 进程持有一个 TaskService 实例（owner = Web IDE 会话），Build/Pack 走
 *   T6 executor（Typecheck 门禁 + operation lock + revision/stale + 不可变产物快照）；
 * - HTTP：POST /api/tasks（受理）、GET /api/tasks/:id（快照）、POST /api/tasks/:id/cancel、
 *   GET /api/tasks/:id/logs（有界 tail）、GET /api/tasks/:id/artifacts/:artifactId（下载）；
 * - SSE：`task` 事件携带 TaskEvent（sequence 单调，客户端按 taskId 去重）；
 * - 下载校验 digest/size，路径限制在 `.fh2/artifacts/<taskId>/` 内，不读可被覆盖的 dist。
 */
export class IdeTaskBridge {
  owner: TaskOwner = { ownerId: 'web-ide' }
  private sessionId = ''
  private unsubscribe: (() => void) | undefined
  private readonly listeners = new Set<(event: TaskEvent) => void>()
  private readonly service: InMemoryTaskService

  constructor (options: TaskServiceOptions = {}, run: DevExecutorOptions = {}) {
    this.service = createTaskService(options, run)
    this.setSession('')
  }

  async start (root: string, rawKind: unknown, params: Readonly<Record<string, string | number | boolean>> = {}): Promise<TaskSnapshot> {
    if (rawKind !== 'build' && rawKind !== 'pack' && rawKind !== 'install' && rawKind !== 'dev' && rawKind !== 'preview') {
      throw new IdeRequestError('FH2_IDE_BAD_REQUEST', 'kind 只支持 build、pack、install、dev 或 preview。')
    }
    try {
      return { ...await this.service.start(this.owner, { kind: rawKind as TaskKind, root, params }), workspaceSessionId: this.sessionId }
    } catch (error) {
      throw taskErrorToIdeError(error)
    }
  }

  /**
   * N3：Create —— 同步生成工程（Application Service），可选安装依赖（install 任务）。
   * 返回新工程根（绝对路径）；Open/Create 只接受本地已鉴权 UI 的显式请求。
   */
  async create (root: string, body: Record<string, unknown>): Promise<{
    readonly projectRoot: string;
    readonly log: readonly string[];
    readonly installTaskId?: string;
  }> {
    const pluginId = body.pluginId
    if (typeof pluginId !== 'string' || pluginId === '') {
      throw new IdeRequestError('FH2_IDE_BAD_REQUEST', '缺少 pluginId。Missing "pluginId".')
    }
    const directory = typeof body.directory === 'string' && body.directory !== '' ? body.directory : undefined
    const template = typeof body.template === 'string' ? body.template : undefined
    const result = await createProject(root, {
      pluginId,
      ...(directory === undefined ? {} : { directory }),
      ...(template === undefined ? {} : { template: template as 'capability-fullstack' | 'frontend-basic' | 'backend-basic' }),
    })
    if (!result.ok) {
      throw new IdeRequestError('FH2_IDE_COMMAND_FAILED', `创建失败：${result.diagnostics.map(diagnostic => diagnostic.message).join('；')}`)
    }
    let installTaskId: string | undefined
    if (body.install === true && result.projectRoot !== undefined) {
      const manager = typeof body.packageManager === 'string' ? body.packageManager : 'npm'
      const task = await this.start(result.projectRoot, 'install', { manager })
      installTaskId = task.taskId
    }
    return {
      projectRoot: result.projectRoot!,
      log: result.log,
      ...(installTaskId === undefined ? {} : { installTaskId }),
    }
  }

  list (): readonly TaskSnapshot[] {
    // 快照即遍历：Serve 进程内任务量有限（history 上限）。
    return this.service.list(this.owner).map(task => ({ ...task, workspaceSessionId: this.sessionId }))
  }

  get (taskId: string): TaskSnapshot {
    try {
      return { ...this.service.get(this.owner, taskId), workspaceSessionId: this.sessionId }
    } catch (error) {
      throw taskErrorToIdeError(error)
    }
  }

  async cancel (taskId: string): Promise<TaskSnapshot> {
    const session = this.sessionId
    try {
      return { ...await this.service.cancel(this.owner, taskId), workspaceSessionId: session }
    } catch (error) {
      throw taskErrorToIdeError(error)
    }
  }

  logs (taskId: string): readonly string[] {
    try {
      return this.service.logTail(this.owner, taskId)
    } catch (error) {
      throw taskErrorToIdeError(error)
    }
  }

  setSession (sessionId: string): void {
    this.unsubscribe?.()
    this.sessionId = sessionId
    this.owner = { ownerId: `web-ide-${sessionId}` }
    this.unsubscribe = this.service.subscribe(this.owner, (event) => {
      for (const listener of this.listeners) listener({ ...event, kind: this.service.get(this.owner, event.taskId).kind, workspaceSessionId: sessionId })
    })
  }

  subscribe (listener: (event: TaskEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async stopAll (): Promise<void> {
    await this.service.stopOwned(this.owner)
  }

  /**
   * U3：按 taskId/artifactId 读取不可变产物快照。
   * 只允许 `.fh2/artifacts/<taskId>/` 内、任务快照登记过的文件；digest/size 校验后返回。
   */
  readArtifact (root: string, taskId: string, artifactId: string): { readonly bytes: Buffer; readonly artifact: ArtifactDescriptor; readonly fileName: string } {
    const task = this.get(taskId)
    const artifact = task.artifacts.find(candidate => candidate.id === artifactId)
    if (artifact === undefined) {
      throw new IdeRequestError('FH2_IDE_NOT_FOUND', `产物不存在：${artifactId}。Artifact not found: ${artifactId}.`)
    }
    if (artifact.path.includes('..') || !artifact.path.startsWith('.fh2/artifacts/')) {
      throw new IdeRequestError('FH2_IDE_PATH_ESCAPE', '产物路径不合法。Invalid artifact path.')
    }
    const absolutePath = resolve(root, artifact.path)
    if (!absolutePath.startsWith(resolve(root, '.fh2', 'artifacts', taskId))) {
      throw new IdeRequestError('FH2_IDE_PATH_ESCAPE', '产物路径不合法。Invalid artifact path.')
    }
    let bytes: Buffer
    try {
      bytes = readFileSync(absolutePath)
    } catch {
      throw new IdeRequestError('FH2_IDE_NOT_FOUND', `产物快照已过期或被清理：${artifactId}。Artifact snapshot expired or cleaned: ${artifactId}.`)
    }
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== artifact.digest || bytes.byteLength !== artifact.size) {
      throw new IdeRequestError('FH2_IDE_INTERNAL', '产物摘要校验失败，已拒绝下载。Artifact digest mismatch; download rejected.')
    }
    return { bytes, artifact, fileName: basename(absolutePath) || `${artifactId}.zip` }
  }
}

function taskErrorToIdeError (error: unknown): IdeRequestError {
  if (error instanceof TaskError) {
    const status = error.code === 'FH2_TASK_NOT_FOUND' ? 'FH2_IDE_NOT_FOUND' : 'FH2_IDE_PROCESS_RUNNING'
    return new IdeRequestError(status, error.message)
  }
  if (error instanceof IdeRequestError) return error
  return new IdeRequestError('FH2_IDE_INTERNAL', error instanceof Error ? error.message : String(error))
}
