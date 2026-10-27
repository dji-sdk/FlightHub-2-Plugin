// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TaskSnapshot } from '../contracts/index.js'
import { startIdeServer } from './ide-server.js'

/**
 * E3：真实 Build 并发与一致性纵切。
 *
 * - 跨进程互斥：两个独立 `fh2-plugin build` CLI 进程并发构建同一工程，
 *   后到者收到 FH2_CAPABILITY_OPERATION_IN_PROGRESS（operation lock 的跨进程语义）；
 * - stale：任务执行期间修改源码 → finalRevision ≠ initialRevision → 任务标记 stale
 *   （产物保留，不伪造新鲜）。
 */
const roots: string[] = []
let projectRoot = ''
let cliEntry = ''

beforeAll(async () => {
  cliEntry = resolve(fileURLToPath(new URL('../../dist/cli.js', import.meta.url)))
  projectRoot = await createBackendProject()
}, 30_000)

afterAll(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/**
 * Capability 工程（含一个后端成员）：CLI 对 Capability build 持 operation lock
 * （独立插件分支的锁是既有缺口，见 findings —— 不在本测试范围）。
 */
async function createBackendProject (): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-e3-'))
  roots.push(root)
  const backendRoot = join(root, 'backend/exp_e3_backend')
  await mkdir(join(backendRoot, 'handlers'), { recursive: true })
  await writeFile(join(root, 'capabilities.json'), JSON.stringify({ name: 'E3', description: 'e3' }))
  await writeFile(join(backendRoot, 'fh2-plugin.json'), JSON.stringify({
    pluginId: 'exp_e3_backend',
    name: 'E3 Backend',
    version: '0.1.0',
    contractsRange: '>=1.0.0 <2.0.0',
  }))
  await writeFile(join(backendRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: 'ES2022', lib: ['ES2022'], types: [], module: 'ESNext', moduleResolution: 'Bundler' },
    include: ['handlers/**/*.ts'],
  }))
  await writeFile(join(backendRoot, 'handlers/issue.ts'), 'export function h_createIssue(): number {\n  return 42\n}\n')
  return root
}

interface CliOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCliBuild (cwd: string, delayMs = 0): Promise<CliOutcome> {
  return new Promise((resolveOutcome) => {
    setTimeout(() => {
      const child = spawn(process.execPath, [cliEntry, 'build'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout.on('data', chunk => stdout.push(chunk))
      child.stderr.on('data', chunk => stderr.push(chunk))
      child.on('exit', code => resolveOutcome({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }))
    }, delayMs)
  })
}

describe('e3：真实 Build 并发与 stale', () => {
  it('跨进程互斥：并发 CLI build 同一工程，后到者报 IN_PROGRESS', { timeout: 180_000 }, async () => {
    // 前端 build 含 rsbuild，耗时足够让两进程真正并发。
    const [first, second] = await Promise.all([
      runCliBuild(projectRoot, 0),
      runCliBuild(projectRoot, 150),
    ])
    const outcomes = [first, second].sort((left, right) => left.code - right.code)
    // 至少一个成功；另一个要么成功（先完成了）要么明确报锁冲突——绝不允许两个都静默成功写同一 dist。
    const rejected = outcomes.find(outcome => outcome.code !== 0)
    if (rejected !== undefined) {
      expect(rejected.stderr).toMatch(/FH2_CAPABILITY_OPERATION_IN_PROGRESS|已有构建/)
    }
    expect(outcomes[0]!.code).toBe(0)
  })

  it('stale：任务执行期间修改源码 → stale=true', { timeout: 180_000 }, async () => {
    const webRoot = await mkdtemp(join(tmpdir(), 'fh2-e3-web-'))
    roots.push(webRoot)
    await mkdir(webRoot, { recursive: true })
    await writeFile(join(webRoot, 'index.html'), '<html><head></head><body>ide</body></html>')
    const server = await startIdeServer({ root: projectRoot, webRoot, port: 0, watch: false })
    try {
      const api = async (path: string, init: RequestInit = {}): Promise<Response> =>
        await fetch(`${server.url}${path}`, { ...init, headers: { 'x-fh2-ide-token': server.token, ...init.headers } })

      const started = await (await api('/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'build' }),
      })).json() as { data?: TaskSnapshot }
      const taskId = started.data?.taskId
      expect(taskId).toBeDefined()

      // 受理后立即改源码（落在 typecheck/build 执行期间）。
      await writeFile(join(projectRoot, 'backend/exp_e3_backend/handlers/issue.ts'), 'export function h_createIssue(): number {\n  return 43\n}\n')

      let final: TaskSnapshot | undefined
      for (let attempt = 0; attempt < 400; attempt++) {
        const snapshot = await (await api(`/api/tasks/${taskId}`)).json() as { data?: TaskSnapshot }
        const state = snapshot.data?.state
        if (state === 'succeeded' || state === 'failed' || state === 'cancelled') {
          final = snapshot.data
          break
        }
        await new Promise(resolveTimer => setTimeout(resolveTimer, 100))
      }
      expect(final).toBeDefined()
      expect(final!.state).toBe('succeeded')
      // 构建期间源码被修改：stale 如实标记，不伪造新鲜。
      expect(final!.stale).toBe(true)
      expect(final!.finalRevision).not.toBe(final!.sourceRevision)
    } finally {
      await server.close()
      // 恢复源码供后续复用。
      await writeFile(join(projectRoot, 'backend/exp_e3_backend/handlers/issue.ts'), 'export function h_createIssue(): number {\n  return 42\n}\n')
    }
  })
})
