// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { randomUUID } from 'node:crypto'
import { inspectProject } from '../application/inspect.js'
import { validateProject } from '../application/validate.js'
import { generateProject } from '../application/generate.js'
import { createProject } from '../application/create.js'
import { createTaskService } from './factory.js'

/**
 * MCP Service Host：M1-M4 的服务装配层。
 *
 * - 同步工具（inspect/validate/generate/create）直接调 Application Service；
 * - Build/Pack/start_dev 走 TaskService（每个 MCP Server 实例独立 TaskOwner，
 *   get/cancel 不能读取或终止其他进程创建的任务）；
 * - MCP Server 退出只调用 stopOwned(owner)。
 */
export interface ApplicationServiceHost {
  readonly ownerLabel: string;
  inspect (root: string): unknown;
  validate (root: string): unknown;
  generate (root: string, check: boolean): unknown;
  create (root: string, params: { pluginId: string; directory?: string; template?: string }): unknown;
  taskStart (kind: 'build' | 'pack' | 'dev' | 'install', root: string, params: Readonly<Record<string, string | number | boolean>>): Promise<import('../../contracts/index.js').TaskSnapshot>;
  taskGet (taskId: string): Promise<import('../../contracts/index.js').TaskSnapshot>;
  taskCancel (taskId: string): Promise<import('../../contracts/index.js').TaskSnapshot>;
  taskSubscribe (listener: (event: import('../../contracts/index.js').TaskEvent) => void): () => void;
  stopOwned (): Promise<void>;
}

export function createInProcessServiceHost (): ApplicationServiceHost {
  const taskService = createTaskService()
  const owner = { ownerId: `mcp-${randomUUID()}` }

  return {
    ownerLabel: owner.ownerId,
    inspect: root => inspectProject(root),
    validate: root => validateProject(root),
    generate: (root, check) => generateProject(root, { check }),
    create: (root, params) => createProject(root, {
      pluginId: params.pluginId,
      ...(params.directory === undefined ? {} : { directory: params.directory }),
      ...(params.template === undefined ? {} : { template: params.template as 'capability-fullstack' | 'frontend-basic' | 'backend-basic' }),
    }),
    taskStart: (kind, root, params) => taskService.start(owner, { kind, root, params }),
    taskGet: async taskId => taskService.get(owner, taskId),
    taskCancel: taskId => taskService.cancel(owner, taskId),
    taskSubscribe: listener => taskService.subscribe(owner, listener),
    stopOwned: () => taskService.stopOwned(owner),
  }
}
