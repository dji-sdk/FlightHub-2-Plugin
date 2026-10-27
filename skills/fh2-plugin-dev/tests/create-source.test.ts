// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runCreatePlugin } from '../../../packages/fh2-plugin-toolchain/src/create/run.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it.each(['pnpm', 'npm', 'yarn'] as const)('source %s 创建只生成 SDK/Toolchain 本地依赖、空 npmrc 和真实 README 命令', async (packageManager) => {
  const root = await mkdtemp(join(tmpdir(), 'fh2-skill-source-create-'))
  roots.push(root)
  const sourceRoot = join(root, 'source checkout')
  const businessRoot = join(root, 'business')
  await mkdir(businessRoot)
  await mkdir(join(sourceRoot, 'examples'), { recursive: true })
  await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({ name: 'fh2-plugin-platform' }))
  // An excluded sibling must never become a generated dependency or override.
  for (const name of ['sdk', 'toolchain', 'contract']) {
    const directory = join(sourceRoot, 'packages', `fh2-plugin-${name}`)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `fh2-plugin-${name}`, version: '0.1.0' }))
  }

  for (const template of ['frontend-basic', 'backend-basic', 'capability-fullstack'] as const) {
    const pluginId = 'exp_source_demo'
    const directory = join(businessRoot, template)
    let errors = ''
    const commands: unknown[] = []
    const code = await runCreatePlugin({
      cwd: businessRoot,
      args: [template, '--platform-root', sourceRoot, '--template', template, ...(template === 'capability-fullstack' ? ['--capability-id', pluginId] : ['--plugin-id', pluginId]), '--package-manager', packageManager, '--no-install'],
      env: {},
      stdinIsTTY: false,
      enforceDependencySource: true,
      stdout: { write: () => true },
      stderr: {
        write: (value) => {
          errors += String(value)
          return true
        },
      },
      detectPackageManagerVersion: () => ({ pnpm: '10.15.0', npm: '10.9.3', yarn: '1.22.22' })[packageManager],
      runCommand: async (...args) => {
        commands.push(args)
      },
    })
    expect(code, errors).toBe(0)
    expect(commands).toEqual([])
    expect(await readFile(join(directory, '.npmrc'), 'utf8')).toBe('')
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    expect(pkg.engines.node).toBe('>=20.19')
    const dependencies = { ...pkg.dependencies, ...pkg.devDependencies }
    expect(Object.keys(dependencies).filter(name => name.startsWith('fh2-plugin-')).sort()).toEqual(['fh2-plugin-sdk', 'fh2-plugin-toolchain'])
    for (const name of ['sdk', 'toolchain']) {
      const spec = dependencies[`fh2-plugin-${name}`]
      expect(spec).toMatch(/^file:/)
      expect(resolve(directory, spec.slice(5))).toBe(join(sourceRoot, 'packages', `fh2-plugin-${name}`))
    }
    const overrides = packageManager === 'pnpm'
      ? await readFile(join(directory, 'pnpm-workspace.yaml'), 'utf8')
      : JSON.stringify(packageManager === 'npm' ? pkg.overrides : pkg.resolutions)
    expect(overrides).toContain('fh2-plugin-sdk')
    expect(overrides).toContain('fh2-plugin-toolchain')
    expect(overrides).not.toContain('fh2-plugin-contract')
    const readme = await readFile(join(directory, 'README.md'), 'utf8')
    expect(readme).toContain('插件化开发者工具')
    expect(readme).toContain('pnpm install --frozen-lockfile')
    expect(readme).toContain('pnpm link:toolchain')
    expect(readme).toContain('--platform-root')
    expect(readme).toContain('developer-runtime/')
    expect(readme).not.toMatch(/nexus|djicorp|npm login|mock-plugin-token|localhost:5175/i)
    if (template === 'backend-basic') {
      for (const script of ['dev', 'types', 'types:check', 'validate', 'build']) expect(readme).toContain(`${packageManager} run ${script}`)
      expect(readme).not.toContain('--root backend/')
      expect(pkg.scripts).not.toHaveProperty('test')
      expect(pkg.scripts).not.toHaveProperty('pack')
    } else if (template === 'frontend-basic') {
      expect(pkg.scripts).not.toHaveProperty('pack')
    } else {
      expect(pkg.scripts.generate).toBe(`fh2-plugin generate --root ${pluginId}`)
      expect(pkg.scripts.pack).toBe(`fh2-plugin pack --root ${pluginId}`)
      for (const member of [`${pluginId}_frontend`, `${pluginId}_issues`]) {
        const memberRoot = join(directory, pluginId, 'frontend', member)
        expect(await readFile(join(memberRoot, '.npmrc'), 'utf8')).toBe('')
        const memberPkg = JSON.parse(await readFile(join(memberRoot, 'package.json'), 'utf8'))
        for (const name of ['sdk', 'toolchain']) {
          const spec = { ...memberPkg.dependencies, ...memberPkg.devDependencies }[`fh2-plugin-${name}`]
          expect(resolve(memberRoot, spec.slice(5))).toBe(join(sourceRoot, 'packages', `fh2-plugin-${name}`))
        }
      }
      const backendReadme = await readFile(join(directory, pluginId, 'backend', `${pluginId}_backend`, 'README.md'), 'utf8')
      expect(backendReadme).not.toMatch(/pnpm run pack|nexus|mock-plugin-token|localhost:5175/i)
      expect(backendReadme).toContain(`pnpm exec fh2-plugin dev --root backend/${pluginId}_backend`)
    }
  }
})
