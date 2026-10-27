// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { acquireOperationLock } from '../operation-lock.js'
import type { TaskExecutor } from '../task-service.js'
import { TaskCancelledError } from '../task-service.js'
import { AbortedInstallError, runPackageManagerInstall } from './dependencies.js'
import type { PackageManagerName } from './dependencies.js'

/**
 * T7：Install executor（Create 的依赖安装任务）。
 *
 * - 固定包管理器与参数（npm/pnpm install），不接受任意命令输入；
 * - 失败和取消只清理本次安装的临时状态，不删除已成功生成的工程文件；
 * - 取消：SIGTERM → 宽限 → SIGKILL（进程语义由共享 runPackageManagerInstall 承载）。
 */
const SUPPORTED_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn'])

export function createInstallExecutor (): TaskExecutor {
  return {
    async start (context) {
      const release = acquireOperationLock(context.root)
      try {
        const manager = typeof context.params.manager === 'string' && SUPPORTED_MANAGERS.has(context.params.manager)
          ? context.params.manager as PackageManagerName
          : 'npm'
        try {
          await runPackageManagerInstall(manager, context.root, {
            emitLog: (stream, line) => context.emitLog(stream, line),
            signal: context.signal,
          })
        } catch (error) {
          if (error instanceof AbortedInstallError || context.signal.aborted) throw new TaskCancelledError()
          throw error
        }
        return {}
      } finally {
        release()
      }
    },
  }
}
