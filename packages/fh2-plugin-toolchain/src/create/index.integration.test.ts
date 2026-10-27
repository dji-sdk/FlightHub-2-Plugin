// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { PluginManifest } from 'fh2-plugin-sdk'
import { verifyPortableDist } from '../build/verify.js'
import { buildCapability } from '../capability/build.js'
import { discoverCapability } from '../capability/discovery.js'
import { packCapability } from '../capability/pack.js'
import type { CapabilityProject } from '../capability/types.js'
import { validateProject } from '../services/application/validate.js'
import { packageManagerSpawnPlan, runCreatePlugin } from './run.js'

const toolchainRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const roots: string[] = []
const activeBuilds = new Set<Promise<unknown>>()
const controllers = new Set<AbortController>()

afterEach(async () => {
  for (const controller of controllers) controller.abort()
  await Promise.allSettled([...activeBuilds])
  activeBuilds.clear()
  controllers.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('create 工作区回归', () => {
  it('pnpm 实际区分根、无 package 父目录、成员根和 src 的同名脚本', { timeout: 30_000 }, async () => {
    const workspace = await createWorkspace()
    const parent = join(workspace, 'exp_generated/frontend')
    const member = join(parent, 'exp_generated_frontend')
    const bin = join(workspace, 'node_modules/.bin')
    await mkdir(bin, { recursive: true })
    // 仅替代临时工程的 CLI 二进制来记录 cwd/argv，不改生成 scripts、不启动常驻 dev。
    await writeFile(join(bin, 'fh2-plugin'), `#!/usr/bin/env node
console.log('FH2_SCRIPT_SELECTION ' + JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }))
`, { mode: 0o755 })
    if (process.platform === 'win32') {
      await writeFile(join(bin, 'fh2-plugin.cmd'), `@"${process.execPath}" "%~dp0fh2-plugin" %*\r\n`)
    }

    expect(existsSync(join(parent, 'package.json'))).toBe(false)
    for (const [cwd, rootScript] of [
      [workspace, true],
      [parent, true],
      [member, false],
      [join(member, 'src'), false],
    ] as const) {
      expect(runCockpitScript(cwd)).toEqual({
        cwd: realpathSync(rootScript ? workspace : member),
        args: rootScript ? ['dev', 'cockpit', '--root', 'exp_generated'] : ['dev', 'cockpit'],
      })
    }
    expect(runCockpitScript(join(member, 'src'), true)).toEqual({
      cwd: realpathSync(workspace),
      args: ['dev', 'cockpit', '--root', 'exp_generated'],
    })
  })

  it('新工程 hello-only、完整前端和 issues 经真实校验构建打包保持 SVG 资源与路径', { timeout: 60_000 }, async () => {
    const workspace = await createWorkspace()
    const capabilityRoot = join(workspace, 'exp_generated')
    const code = await runCreatePlugin({
      args: ['frontend/exp_combined', '--plugin-id', 'exp_combined', '--template', 'frontend-basic', '--package-manager', 'pnpm', '--no-install'],
      cwd: capabilityRoot,
      stdout: { write: () => true },
      stderr: { write: () => true },
      stdinIsTTY: false,
      detectPackageManagerVersion: () => '10.15.0',
    })
    expect(code).toBe(0)
    const capability = discoverCapability(capabilityRoot)
    expect(capability.frontend.map(member => member.id).sort())
      .toEqual(['exp_combined', 'exp_generated_frontend', 'exp_generated_issues'])
    for (const member of capability.frontend) {
      // 复用已安装构建依赖，配置仅将 adapter 改为当前源码，避免命中旧 dist。
      await symlink(join(toolchainRoot, 'node_modules'), join(member.root, 'node_modules'), 'junction')
      const configPath = join(member.root, 'rsbuild.config.ts')
      const config = await readFile(configPath, 'utf8')
      await writeFile(configPath, config.replace(
        '\'fh2-plugin-toolchain/rsbuild\'',
        JSON.stringify(new URL('../rsbuild/index.ts', import.meta.url).href),
      ))
    }
    const validation = validateProject(workspace)
    expect(validation.ok, JSON.stringify(validation.diagnostics)).toBe(true)
    const built = await runBuild(capability)
    expect(built.ok, JSON.stringify(built.diagnostics)).toBe(true)
    // 当前源码 adapter 位于 Capability 外，按既有规则走正常 Pack 重建，不使用 --no-build。
    const packed = await packCapability({ capability, build: ({ capability }) => runBuild(capability, true) })
    const zipNames = (await readFile(packed.zipPath)).toString('latin1')
    for (const member of capability.frontend) {
      const source = JSON.parse(await readFile(member.manifestPath, 'utf8')) as PluginManifest
      const dist = await verifyPortableDist(join(member.root, 'dist'))
      const packedRoot = join(packed.capabilityDir, 'frontend', member.id)
      const outer = JSON.parse(await readFile(join(packedRoot, 'plugin.json'), 'utf8')) as { manifest: PluginManifest }
      const packedDist = JSON.parse(await readFile(join(packedRoot, 'dist/fh2-plugin.json'), 'utf8')) as PluginManifest
      const expectedIds = member.id === 'exp_generated_frontend'
        ? ['plugin']
        : member.id === 'exp_combined' ? ['plugin', 'issue', 'issue-active'] : ['issue', 'issue-active']
      expect(source.contributes?.icons?.map(icon => icon.id)).toEqual(expectedIds)
      expect(dist.contributes?.icons).toEqual(source.contributes?.icons)
      expect(packedDist.contributes?.icons).toEqual(dist.contributes?.icons)
      expect(outer.manifest.contributes?.icons).toEqual(expectedIds.map(id => ({ id, src: `./dist/icons/${id}.svg` })))
      for (const id of expectedIds) {
        const svg = await readFile(join(member.root, 'public/icons', `${id}.svg`), 'utf8')
        expect(await readFile(join(member.root, 'dist/icons', `${id}.svg`), 'utf8')).toBe(svg)
        expect(await readFile(join(packedRoot, 'dist/icons', `${id}.svg`), 'utf8')).toBe(svg)
        expect(zipNames).toContain(`exp_generated/frontend/${member.id}/dist/icons/${id}.svg`)
      }
    }
    // 反向资源回归：声明保留但实际 SVG 缺失时，既有 Dist 校验必须失败。
    const helloDist = join(capabilityRoot, 'frontend/exp_generated_frontend/dist')
    await rm(join(helloDist, 'icons/plugin.svg'))
    await expect(verifyPortableDist(helloDist)).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'FH2_DIST_ASSET_MISSING' })],
    })
  })
})

async function runBuild (capability: CapabilityProject, operationLockHeld = false) {
  const controller = new AbortController()
  controllers.add(controller)
  const operation = buildCapability({ capability, operationLockHeld, abortSignal: controller.signal })
  activeBuilds.add(operation)
  try {
    return await operation
  } finally {
    activeBuilds.delete(operation)
    controllers.delete(controller)
  }
}

async function createWorkspace (): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-create-v2-'))
  roots.push(root)
  const errors: string[] = []
  const code = await runCreatePlugin({
    args: ['workspace', '--capability-id', 'exp_generated', '--package-manager', 'pnpm', '--no-install'],
    cwd: root,
    stdout: { write: () => true },
    stderr: {
      write: (chunk) => {
        errors.push(String(chunk))
        return true
      },
    },
    stdinIsTTY: false,
    detectPackageManagerVersion: () => '10.15.0',
  })
  expect(code, errors.join('')).toBe(0)
  return join(root, 'workspace')
}

function runCockpitScript (cwd: string, workspaceRoot = false): unknown {
  const plan = packageManagerSpawnPlan('pnpm', [...(workspaceRoot ? ['-w'] : []), 'run', 'dev:cockpit'])
  const result = spawnSync(plan.command, plan.args, { cwd, shell: plan.shell, encoding: 'utf8', timeout: 10_000 })
  expect(result.status, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`).toBe(0)
  const line = result.stdout.split(/\r?\n/).find(line => line.startsWith('FH2_SCRIPT_SELECTION '))
  expect(line).toBeDefined()
  return JSON.parse(line!.slice('FH2_SCRIPT_SELECTION '.length))
}
