// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { InMemoryTaskService } from './task-service.js'
import type { TaskServiceOptions } from './task-service.js'
import { canonicalOperationRoot } from './operation-lock.js'
import { createBuildPackExecutor } from './executors/build-pack.js'
import { createRunExecutor } from './executors/dev.js'
import type { DevExecutorOptions } from './executors/dev.js'
import { createInstallExecutor } from './executors/install.js'

/** CLI、IDE、MCP 的唯一默认任务装配。 */
export function createTaskService (options: TaskServiceOptions = {}, run: DevExecutorOptions = {}): InMemoryTaskService {
  const service = new InMemoryTaskService({ canonicalizeRoot: canonicalOperationRoot, ...options })
  service.registerExecutor('build', createBuildPackExecutor('build'))
  service.registerExecutor('pack', createBuildPackExecutor('pack'))
  service.registerExecutor('dev', createRunExecutor('dev', run))
  service.registerExecutor('preview', createRunExecutor('preview', run))
  service.registerExecutor('install', createInstallExecutor())
  return service
}
