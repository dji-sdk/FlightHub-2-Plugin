// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { ArtifactDescriptor } from '../../../contracts/index.js'
import { createDeterministicZip } from '../../../capability/zip.js'
import type { ZipEntry } from '../../../capability/zip.js'
import { buildProject } from '../../application/build.js'
import { packProject } from '../../application/pack.js'
import { computeSourceRevision } from '../../source-revision.js'
import { acquireOperationLock } from '../operation-lock.js'
import type { TaskExecutor } from '../task-service.js'
import { TaskCancelledError } from '../task-service.js'
import { ensureDependenciesInstalled } from './dependencies.js'

/**
 * T6：Build/Pack executor（实施计划 §3.1.1/§3.4）。
 *
 * - 取得 canonical operation lock 并完成准备后计算 initialRevision，完成时重新计算
 *   finalRevision；TaskService 依此得出 stale = final !== initial；
 * - Build 产物 dist 目录在任务完成时快照为不可变 zip（`.fh2/artifacts/<taskId>/`），
 *   旧 Task 下载不受下一次 Build 覆盖 dist 影响（U3）；Pack 的交付 zip 本身不可变；
 * - 取消：进入执行后立即检查 signal；持锁期间异常/取消都在 finally 释放锁；
 * - 失败/取消也保留 revision（initialRevision 已 report）。
 */
export interface BuildPackExecutorServices {
  readonly build?: typeof buildProject;
  readonly pack?: typeof packProject;
}

export function createBuildPackExecutor (
  kind: 'build' | 'pack',
  services: BuildPackExecutorServices = {},
): TaskExecutor {
  return {
    async start (context) {
      const release = acquireOperationLock(context.root)
      try {
        if (context.signal.aborted) throw new TaskCancelledError()
        const initialRevision = computeSourceRevision(context.root)
        context.reportInitialRevision(initialRevision)
        context.emitLog('stdout', `${kind} started (source ${initialRevision.slice(0, 12)})`)
        // 前置依赖保障：缺 node_modules 时先自动 install（typecheck/build/rsbuild 都依赖它）
        await ensureDependenciesInstalled(context.root, {
          emitLog: (stream, line) => context.emitLog(stream, line),
          signal: context.signal,
        })
        if (context.signal.aborted) throw new TaskCancelledError()

        const result = kind === 'build'
          ? await (services.build ?? buildProject)(context.root, {
            ...(typeof context.params.configPath === 'string' ? { configPath: context.params.configPath } : {}),
            ...(typeof context.params.frontend === 'string' ? { frontend: context.params.frontend.split(',').filter(Boolean) } : {}),
            ...(typeof context.params.backend === 'string' ? { backend: context.params.backend.split(',').filter(Boolean) } : {}),
            sourceRevision: initialRevision,
            operationLockHeld: true,
            ...(context.signal === undefined ? {} : { abortSignal: context.signal }),
          })
          : await (services.pack ?? packProject)(context.root, {
            ...(typeof context.params.outputRoot === 'string' ? { outputRoot: context.params.outputRoot } : {}),
            // U2 打包范围：逗号分隔的成员限定 id（`<capId>[/<memberId>]`）；缺省 = 全量
            ...(typeof context.params.members === 'string' && context.params.members !== ''
              ? { members: new Set(context.params.members.split(',').map(entry => entry.trim()).filter(Boolean)) }
              : {}),
            sourceRevision: initialRevision,
            operationLockHeld: true,
            ...(context.params.noBuild === true ? { noBuild: true } : {}),
            // IDE-014-06：取消传播到 typecheck/内部 build 的挂起子进程，终态如实记 cancelled
            ...(context.signal === undefined ? {} : { abortSignal: context.signal }),
          })

        for (const diagnostic of result.diagnostics) context.emitDiagnostic(diagnostic)
        if (!result.ok) {
          throw new Error(`${kind} 失败：${result.diagnostics.length} 条诊断。${kind} failed with ${result.diagnostics.length} diagnostic(s).`)
        }
        const finalRevision = computeSourceRevision(context.root)
        const artifacts = snapshotDistArtifacts(context.root, context.taskId, result.artifacts, initialRevision, finalRevision)
        context.emitLog('stdout', `${kind} succeeded (source ${finalRevision.slice(0, 12)})`)
        return { artifacts, finalRevision }
      } finally {
        release()
      }
    },
  }
}

/**
 * U3：Build 的 dist 产物快照为不可变 zip。
 * zip 是确定性归档（排序 + 固定时间戳），digest = zip sha256；下载端点按
 * taskId/artifactId 读取快照，不直接读随后会被覆盖的 dist。
 */
function snapshotDistArtifacts (
  root: string,
  taskId: string,
  artifacts: readonly ArtifactDescriptor[],
  initialRevision: string,
  finalRevision: string,
): readonly ArtifactDescriptor[] {
  if (artifacts.length === 0) return artifacts
  const snapshotRoot = resolve(root, '.fh2', 'artifacts', taskId)
  return artifacts.map((artifact) => {
    const artifactPath = resolve(root, artifact.path)
    const zip = artifact.kind === 'frontend-dist' || artifact.kind === 'backend-dist'
      ? createDeterministicZip(collectZipEntries(artifactPath, artifactPath))
      : readFileSync(artifactPath)
    mkdirSync(snapshotRoot, { recursive: true })
    // 交付 zip 已经是最终文件名，快照保留 basename；dist 目录才用 artifact id 派生。
    const zipName = artifact.kind === 'capability-package'
      ? artifact.path.split('/').pop()!
      : `${artifact.id}.zip`
    writeFileSync(join(snapshotRoot, zipName), zip)
    return {
      ...artifact,
      // 产物标识构建起始输入；结束 revision 只用于新鲜度判定。
      sourceRevision: initialRevision,
      stale: finalRevision !== initialRevision,
      path: `.fh2/artifacts/${taskId}/${zipName}`,
      digest: createHash('sha256').update(zip).digest('hex'),
      size: zip.byteLength,
    }
  })
}

function collectZipEntries (distRoot: string, directory: string, entries: ZipEntry[] = []): ZipEntry[] {
  let names: readonly string[]
  try {
    names = readdirSync(directory)
  } catch {
    return entries
  }
  for (const name of [...names].sort()) {
    const path = join(directory, name)
    const stats = statSync(path)
    if (stats.isDirectory()) {
      collectZipEntries(distRoot, path, entries)
      continue
    }
    if (!stats.isFile()) continue
    entries.push({ path: relative(distRoot, path).split('\\').join('/'), data: readFileSync(path) })
  }
  return entries
}

/** 注册 Build/Pack executor 的便捷入口。 */
export function registerBuildPackExecutors (register: (kind: 'build' | 'pack', executor: TaskExecutor) => void): void {
  register('build', createBuildPackExecutor('build'))
  register('pack', createBuildPackExecutor('pack'))
}
