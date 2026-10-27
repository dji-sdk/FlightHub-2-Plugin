// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import process from 'node:process'
import { createInProcessServiceHost } from './service-host.js'

/**
 * T4：MCP 内部 worker 入口（不是公开 CLI）。
 *
 * - 承载 Application Service 与 TaskService 的执行进程：父进程（MCP stdio server）
 *   的 stdout 只承载协议帧，业务输出（rsbuild/vue-tsc 等）写进本进程 stdout，
 *   由父进程捕获为日志管道，绝不透传到协议流；
 * - 控制事件固定走 Node IPC（process.send/on('message')）；
 * - 收到 shutdown 或父进程断开（IPC 断连）时 stopOwned 清理任务后退出。
 */
interface ParentMessage {
  readonly type: 'call' | 'task-start' | 'task-cancel' | 'task-get' | 'shutdown';
  readonly callId?: number;
  readonly service?: 'inspect' | 'validate' | 'generate' | 'create';
  readonly taskId?: string;
  readonly kind?: 'build' | 'pack' | 'dev' | 'install';
  readonly root?: string;
  readonly params?: Record<string, unknown>;
}

const host = createInProcessServiceHost()

function send (message: unknown): void {
  if (process.send === undefined) return
  process.send(message)
}

process.on('message', (raw: unknown) => {
  const message = raw as ParentMessage
  if (message.type === 'shutdown') {
    void host.stopOwned().finally(() => process.exit(0))
    return
  }
  if (message.type === 'call') {
    const { callId, service, root, params } = message
    if (callId === undefined || service === undefined || root === undefined) return
    void Promise.resolve()
      .then(() => {
        switch (service) {
          case 'inspect': return host.inspect(root)
          case 'validate': return host.validate(root)
          case 'generate': return host.generate(root, params?.check === true)
          case 'create': return host.create(root, {
            pluginId: String(params?.pluginId ?? ''),
            ...(params?.directory === undefined ? {} : { directory: String(params.directory) }),
            ...(params?.template === undefined ? {} : { template: String(params.template) }),
          })
        }
      })
      .then(data => send({ type: 'call-result', callId, ok: true, data }))
      .catch(error => send({
        type: 'call-result',
        callId,
        ok: false,
        error: {
          code: error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string'
            ? String((error as { code: unknown }).code)
            : 'FH2_MCP_INTERNAL',
          message: error instanceof Error ? error.message : String(error),
        },
      }))
    return
  }
  if (message.type === 'task-start') {
    const { taskId, kind, root, params } = message
    if (taskId === undefined || kind === undefined || root === undefined) return
    void host.taskStart(kind, root, (params ?? {}) as Record<string, string | number | boolean>)
      .then(snapshot => send({ type: 'task-started', taskId, snapshot }))
      .catch(error => send({
        type: 'task-start-failed',
        taskId,
        error: {
          code: error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string'
            ? String((error as { code: unknown }).code)
            : 'FH2_TASK_IN_PROGRESS',
          message: error instanceof Error ? error.message : String(error),
        },
      }))
    return
  }
  if (message.type === 'task-get') {
    const { taskId } = message
    if (taskId === undefined) return
    // taskGet 是异步（宿主可能为 worker 代理）：先 await 再发送，异常映射为错误回包。
    void Promise.resolve()
      .then(() => host.taskGet(taskId))
      .then(snapshot => send({ type: 'task-result', taskId, snapshot }))
      .catch(error => send({
        type: 'task-result',
        taskId,
        error: {
          code: error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string'
            ? String((error as { code: unknown }).code)
            : 'FH2_TASK_NOT_FOUND',
          message: error instanceof Error ? error.message : String(error),
        },
      }))
    return
  }
  if (message.type === 'task-cancel') {
    const { taskId } = message
    if (taskId === undefined) return
    void host.taskCancel(taskId)
      .then(snapshot => send({ type: 'task-cancel-result', taskId, snapshot }))
      .catch(error => send({
        type: 'task-cancel-result',
        taskId,
        error: {
          code: error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string'
            ? String((error as { code: unknown }).code)
            : 'FH2_MCP_INTERNAL',
          message: error instanceof Error ? error.message : String(error),
        },
      }))
  }
})

// 任务事件透传到父进程（日志/状态流），父进程转发为任务日志。
host.taskSubscribe(event => send({ type: 'task-event', event }))

// 父进程退出（IPC 断连）：清理任务后退出，不留孤儿任务/子进程。
process.on('disconnect', () => {
  void host.stopOwned().finally(() => process.exit(0))
})

send({ type: 'ready' })
