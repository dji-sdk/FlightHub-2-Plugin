// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ArtifactDescriptor, TaskEvent, TaskOwner, TaskSnapshot } from '../../../contracts/index.js'
import { createDeterministicZip } from '../../../capability/zip.js'
import type { BuildProjectOptions, BuildProjectResult } from '../../application/build.js'
import type { PackProjectOptions, PackProjectResult } from '../../application/pack.js'
import { computeSourceRevision } from '../../source-revision.js'
import { InMemoryTaskService, TaskError } from '../task-service.js'
import { createBuildPackExecutor } from './build-pack.js'

const roots: string[] = []
const owner: TaskOwner = { ownerId: 'test-owner' }

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/**
 * 最小后端插件 fixture：TS 源码 + 合法清单（含 contractsRange 后端标志字段）+
 * tsconfig。Build 链路走真实 backend build（无 esbuild 前端依赖）。
 */
async function createBackendPlugin (): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-t6-'))
  roots.push(root)
  await mkdir(join(root, 'handlers'), { recursive: true })
  await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({
    pluginId: 'exp_t6_backend',
    name: 'T6 Backend',
    version: '0.1.0',
    contractsRange: '>=1.0.0 <2.0.0',
  }))
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: 'ES2022',
      lib: ['ES2022'],
      types: [],
      module: 'ESNext',
      moduleResolution: 'Bundler',
    },
    include: ['handlers/**/*.ts'],
  }))
  await writeFile(join(root, 'handlers/issue.ts'), 'export function h_createIssue(): number {\n  return 42\n}\n')
  return root
}

describe('build/Pack executor（T6）', () => {
  it.each([
    { kind: 'build', changeSource: false },
    { kind: 'build', changeSource: true },
    { kind: 'pack', changeSource: false },
    { kind: 'pack', changeSource: true },
  ] as const)('$kind：构建中修改源码=$changeSource，task/artifact revision 与 stale 一致且快照不可变', async ({ kind, changeSource }) => {
    const project = await createBackendPlugin()
    const initialRevision = computeSourceRevision(project)
    const outputDirectory = kind === 'build' ? 'dist' : 'release'
    const outputFile = join(project, outputDirectory, kind === 'build' ? 'entry.js' : 'plugin.zip')
    const content = Buffer.from('export const built = 42\n')
    const expectedZip = createDeterministicZip([{ path: 'entry.js', data: content }])
    const tasks = new InMemoryTaskService()
    const events: TaskEvent[] = []
    tasks.subscribe(owner, event => events.push(event))
    let task: TaskSnapshot
    let running: TaskSnapshot | undefined
    let applicationArtifact: ArtifactDescriptor | undefined
    const projectStub = async (root: string, options: Pick<BuildProjectOptions, 'sourceRevision'> = {}): Promise<BuildProjectResult> => {
      running = tasks.get(owner, task.taskId)
      expect(running).toMatchObject({ state: 'running', sourceRevision: initialRevision })
      expect(options.sourceRevision).toBe(initialRevision)
      if (changeSource) {
        await writeFile(join(root, 'handlers/issue.ts'), 'export function h_createIssue(): number { return 43 }\n')
      }
      await mkdir(join(root, outputDirectory), { recursive: true })
      await writeFile(outputFile, kind === 'build' ? content : expectedZip)
      applicationArtifact = Object.freeze({
        id: 'backend-output',
        kind: kind === 'build' ? 'backend-dist' : 'capability-package',
        path: kind === 'build' ? 'dist' : 'release/plugin.zip',
        digest: createHash('sha256').update(content).digest('hex'),
        size: content.byteLength,
        sourceRevision: options.sourceRevision!,
        typechecked: true,
        stale: false,
      })
      return {
        root,
        kind: 'backend-plugin',
        ok: true,
        diagnostics: [],
        members: [],
        outputs: [outputDirectory],
        artifacts: [applicationArtifact],
        typechecked: true,
      }
    }
    tasks.registerExecutor(kind, createBuildPackExecutor(kind, { build: projectStub, pack: projectStub }))
    task = await tasks.start(owner, { kind, root: project, params: {} })
    const final = await tasks.settle(owner, task.taskId)
    const finalRevision = computeSourceRevision(project)

    expect(finalRevision !== initialRevision).toBe(changeSource)
    expect(final).toMatchObject({ state: 'succeeded', sourceRevision: initialRevision, finalRevision, stale: changeSource })
    expect(final.artifacts).toHaveLength(1)
    const artifact = final.artifacts[0]!
    expect(artifact).toMatchObject({
      sourceRevision: initialRevision,
      stale: final.stale,
      typechecked: true,
      // dist 目录快照按 artifact id 派生；交付 zip 保留原名（见 build-pack.ts）。
      path: `.fh2/artifacts/${task.taskId}/${kind === 'build' ? 'backend-output.zip' : 'plugin.zip'}`,
      digest: createHash('sha256').update(expectedZip).digest('hex'),
      size: expectedZip.byteLength,
    })
    expect(artifact).not.toBe(applicationArtifact)
    expect(applicationArtifact).toMatchObject({ sourceRevision: initialRevision, stale: false, path: kind === 'build' ? 'dist' : 'release/plugin.zip' })
    expect(events.filter(event => event.type === 'artifact')).toEqual([
      expect.objectContaining({ artifact }),
    ])
    expect(task).toMatchObject({ state: 'queued', artifacts: [] })
    expect(task).not.toHaveProperty('sourceRevision')
    expect(running).toMatchObject({ state: 'running', sourceRevision: initialRevision, artifacts: [] })
    expect(running).not.toHaveProperty('finalRevision')

    await writeFile(outputFile, 'replacement output')
    await writeFile(join(project, 'handlers/issue.ts'), 'export function h_createIssue(): number { return 99 }\n')
    expect(await readFile(join(project, artifact.path))).toEqual(expectedZip)
    expect(tasks.get(owner, task.taskId)).toEqual(final)
  })

  it('build 任务：revision 记录、产物 digest、succeeded', { timeout: 60_000 }, async () => {
    const project = await createBackendPlugin()
    const tasks = new InMemoryTaskService({ canonicalizeRoot: root => root })
    tasks.registerExecutor('build', createBuildPackExecutor('build'))

    const snapshot = await tasks.start(owner, { kind: 'build', root: project, params: {} })
    const final = await tasks.settle(owner, snapshot.taskId)

    expect(final.state).toBe('succeeded')
    expect(final.sourceRevision).toMatch(/^[0-9a-f]{64}$/)
    expect(final.stale).toBe(false)
    expect(final.artifacts).toHaveLength(1)
    expect(final.artifacts[0]).toMatchObject({
      kind: 'backend-dist',
      typechecked: true,
      stale: false,
    })
    expect(final.artifacts[0]!.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(final.artifacts[0]!.sourceRevision).toBe(final.sourceRevision)
  })

  it('typecheck 失败：任务 failed，无产物，诊断包含 TS 错误', { timeout: 60_000 }, async () => {
    const project = await createBackendPlugin()
    await writeFile(join(project, 'handlers/issue.ts'), 'export function h_createIssue(): number {\n  return "not a number"\n}\n')
    const tasks = new InMemoryTaskService({ canonicalizeRoot: root => root })
    tasks.registerExecutor('build', createBuildPackExecutor('build'))

    const snapshot = await tasks.start(owner, { kind: 'build', root: project, params: {} })
    const final = await tasks.settle(owner, snapshot.taskId)

    expect(final.state).toBe('failed')
    expect(final.artifacts).toEqual([])
    expect(final.diagnostics.some(diagnostic => diagnostic.phase === 'typecheck' && diagnostic.severity === 'error')).toBe(true)
  })

  it('同 root 重复 build 在任务终态前被拒绝（IN_PROGRESS）；终态后可再启动', { timeout: 90_000 }, async () => {
    const project = await createBackendPlugin()
    const tasks = new InMemoryTaskService({ canonicalizeRoot: root => root })
    tasks.registerExecutor('build', createBuildPackExecutor('build'))

    const first = await tasks.start(owner, { kind: 'build', root: project, params: {} })
    // §3.1：同 owner 同参数的重复 start 返回已有 taskId；参数不同才是 IN_PROGRESS。
    const duplicate = await tasks.start(owner, { kind: 'build', root: project, params: {} })
    expect(duplicate.taskId).toBe(first.taskId)
    await expect(tasks.start(owner, { kind: 'build', root: project, params: { mode: 'development' } }))
      .rejects.toMatchObject({ code: 'FH2_TASK_IN_PROGRESS' })
    await tasks.settle(owner, first.taskId)

    const second = await tasks.start(owner, { kind: 'build', root: project, params: {} })
    const secondFinal = await tasks.settle(owner, second.taskId)
    expect(secondFinal.state).toBe('succeeded')
  })

  it('未注册类型：明确失败', async () => {
    const tasks = new InMemoryTaskService()
    await expect(tasks.start(owner, { kind: 'pack', root: '/nope', params: {} }))
      .rejects.toMatchObject({ code: 'FH2_TASK_NOT_FOUND' })
    expect(() => tasks.get(owner, 'missing')).toThrow(TaskError)
  })

  it('pack 任务：上传包快照保留交付 zip 原名，不用 artifact id 改名', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-pack-snapshot-'))
    roots.push(root)
    const zipPath = join(root, 'release', 'exp_workspace_package.zip')
    const packStub = async (): Promise<PackProjectResult> => {
      await mkdir(join(root, 'release'), { recursive: true })
      await writeFile(zipPath, 'zip-bytes')
      return {
        root,
        kind: 'industry-capability-workspace',
        ok: true,
        diagnostics: [],
        members: [],
        typechecked: true,
        artifacts: [{
          id: 'workspace-exp_workspace_package-capability-package',
          kind: 'capability-package',
          path: 'release/exp_workspace_package.zip',
          digest: '0'.repeat(64),
          size: 0,
          sourceRevision: 'rev',
          typechecked: true,
          stale: false,
        }],
      }
    }
    const tasks = new InMemoryTaskService({ canonicalizeRoot: root => root })
    tasks.registerExecutor('pack', createBuildPackExecutor('pack', { pack: packStub }))

    const snapshot = await tasks.start(owner, { kind: 'pack', root, params: {} })
    const final = await tasks.settle(owner, snapshot.taskId)

    expect(final.state).toBe('succeeded')
    expect(final.artifacts[0]!.path).toMatch(/^\.fh2\/artifacts\/.+\/exp_workspace_package\.zip$/)
    expect(readFileSync(join(root, final.artifacts[0]!.path)).toString()).toBe('zip-bytes')
  })

  /**
   * U2 打包范围回归：params.members（逗号分隔限定 id）必须翻译成 Set 传给
   * packProject；缺省/空串保持 undefined（= 全量）。历史上旧构建产物会静默丢弃
   * 该参数导致「勾选了成员仍全量打包」。
   */
  it('pack 任务：params.members 逐项传给 packProject，缺省/空串 = 全量', async () => {
    const captured: Array<{ members?: ReadonlySet<string> }> = []
    const packStub = async (root: string, options?: PackProjectOptions): Promise<PackProjectResult> => {
      captured.push(options?.members === undefined ? {} : { members: options.members })
      return { root, kind: 'capability-project', ok: true, diagnostics: [], members: [], artifacts: [], typechecked: true }
    }
    // 空 fixture：无 package.json → ensureDependenciesInstalled 不触发真实安装
    const emptyRoot = await mkdtemp(join(tmpdir(), 'fh2-members-'))
    roots.push(emptyRoot)
    const tasks = new InMemoryTaskService({ canonicalizeRoot: root => root })
    tasks.registerExecutor('pack', createBuildPackExecutor('pack', { pack: packStub }))

    const filtered = await tasks.start(owner, { kind: 'pack', root: emptyRoot, params: { members: 'cap_a/fe, cap_b/be' } })
    expect((await tasks.settle(owner, filtered.taskId)).state).toBe('succeeded')
    expect(captured[0]).toEqual({ members: new Set(['cap_a/fe', 'cap_b/be']) })

    const full = await tasks.start(owner, { kind: 'pack', root: emptyRoot, params: {} })
    expect((await tasks.settle(owner, full.taskId)).state).toBe('succeeded')
    expect(captured[1]).toEqual({})

    const emptyString = await tasks.start(owner, { kind: 'pack', root: emptyRoot, params: { members: '' } })
    expect((await tasks.settle(owner, emptyString.taskId)).state).toBe('succeeded')
    expect(captured[2]).toEqual({})
  })
})
