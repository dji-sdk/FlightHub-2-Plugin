// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { CapabilityProject } from './types.js'
import { buildCapability } from './build.js'
import { packCapability } from './pack.js'

/**
 * 真实构建回归需要主仓私有依赖（Engine 及 toolchain node_modules 软链）。
 * 公开源码树没有这些输入，跳过；以「无导出候选标记文件」识别主仓。
 */
const hasPrivateBuildInputs = (() => {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
  return !existsSync(join(repositoryRoot, 'public-distribution.json'))
})()
const describeInPrivateRepo = describe.runIf(hasPrivateBuildInputs)

const roots: string[] = []
const active = new Set<Promise<unknown>>()
const controllers = new Set<AbortController>()
function runBuild (capability: CapabilityProject, operationLockHeld = false) {
  const controller = new AbortController()
  controllers.add(controller)
  const operation = buildCapability({ capability, operationLockHeld, abortSignal: controller.signal })
  active.add(operation)
  void operation.then(() => {
    active.delete(operation)
    controllers.delete(controller)
  }, () => {
    active.delete(operation)
    controllers.delete(controller)
  })
  return operation
}
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
afterEach(async () => {
  for (const controller of controllers) controller.abort()
  await Promise.allSettled([...active])
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describeInPrivateRepo('capability build', () => {
  it('复用真实前端 Runner 与独立后端构建完成 Capability Build', async () => {
    const fixture = await createRealFixture()

    const result = await runBuild(fixture.capability)

    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
    expect(existsSync(join(fixture.frontendRoot, 'dist/fh2-plugin.json'))).toBe(true)
    expect(existsSync(join(fixture.backendRoot, 'dist/plugin.json'))).toBe(true)
    expect(JSON.parse(await readFile(join(fixture.root, '.fh2/build-report.json'), 'utf8'))).toMatchObject({
      capabilityId: 'exp_real_capability_build',
      frontend: { exp_real_frontend: { status: 'success' } },
      backend: { exp_real_backend: { status: 'success' } },
    })
    await expect(packCapability({ capability: fixture.capability, noBuild: true }))
      .rejects.toMatchObject({ diagnostic: { code: 'FH2_CAPABILITY_BUILD_STALE' } })
  })

  it('真实 Build 后 Pack 产物对齐生产上传包结构', async () => {
    const fixture = await createRealFixture()

    // pack 在调用 build 回调前已持有操作锁，与默认构建分支保持一致。
    const packed = await packCapability({ capability: fixture.capability, build: ({ capability }) => runBuild(capability, true) })

    const backendDir = join(packed.capabilityDir, 'backend/exp_real_backend')
    const frontendDir = join(packed.capabilityDir, 'frontend/exp_real_frontend')
    expect(existsSync(join(packed.capabilityDir, 'capabilities.json'))).toBe(true)
    expect(existsSync(join(frontendDir, 'plugin.json'))).toBe(true)
    expect(existsSync(join(frontendDir, 'dist/fh2-plugin.json'))).toBe(true)
    expect(existsSync(join(backendDir, 'plugin.json'))).toBe(true)
    expect(existsSync(join(backendDir, 'schema.sql'))).toBe(true)
    expect(existsSync(join(backendDir, 'workflows/example.json'))).toBe(true)
    expect(existsSync(join(backendDir, 'adapters/example.js'))).toBe(true)
    expect(existsSync(join(backendDir, 'build-info.json'))).toBe(false)
    expect(existsSync(join(packed.capabilityDir, 'packages.json'))).toBe(false)
    expect(existsSync(join(packed.packageDir, 'packages.json'))).toBe(true)
    expect(existsSync(join(packed.packageDir, 'SIGNATURE'))).toBe(false)
    expect(JSON.parse(await readFile(join(packed.packageDir, 'packages.json'), 'utf8'))).toEqual([{
      packageId: 'exp_real_package',
      name: '真实构建包',
      capabilityIds: ['exp_real_capability_build'],
    }])
    const frontendPackage = JSON.parse(await readFile(join(frontendDir, 'plugin.json'), 'utf8'))
    expect(frontendPackage).not.toHaveProperty('side')

    const zipNames = readFileSync(packed.zipPath).toString('latin1')
    expect(zipNames).toContain('packages.json')
    expect(zipNames).toContain('exp_real_capability_build/capabilities.json')
    expect(zipNames).toContain('exp_real_capability_build/frontend/exp_real_frontend/plugin.json')
    expect(zipNames).toContain('exp_real_capability_build/backend/exp_real_backend/schema.sql')
  })
})

async function createRealFixture (): Promise<{
  readonly root: string;
  readonly frontendRoot: string;
  readonly backendRoot: string;
  readonly capability: CapabilityProject;
}> {
  // fixture 位于 Toolchain 包内，node_modules 复用 Toolchain workspace 依赖
  // （vue/@rsbuild/plugin-vue 为 Toolchain devDependencies），与 examples 示例工程解耦。
  const parent = await mkdtemp(join(repositoryRoot, 'packages/fh2-plugin-toolchain/.fh2-capability-build-'))
  const root = join(parent, 'exp_real_capability_build')
  const frontendRoot = join(root, 'frontend/exp_real_frontend')
  const backendRoot = join(root, 'backend/exp_real_backend')
  roots.push(parent)
  await cp(join(repositoryRoot, 'packages/fh2-plugin-toolchain/template'), frontendRoot, {
    recursive: true,
    filter: source => !source.endsWith('/dist')
      && !source.endsWith('/node_modules')
      && !source.includes('/node_modules/'),
  })
  await writeFile(join(frontendRoot, 'package.json'), JSON.stringify({
    name: 'exp_real_frontend',
    type: 'module',
    dependencies: { 'fh2-plugin-sdk': '1.0.0-alpha.0', vue: '3.5.41' },
    devDependencies: {
      'fh2-plugin-toolchain': '1.0.0-alpha.0',
      '@rsbuild/core': '1.7.6',
      '@rsbuild/plugin-vue': '1.2.9',
    },
  }))
  await symlink(join(repositoryRoot, 'packages/fh2-plugin-toolchain/node_modules'), join(frontendRoot, 'node_modules'), 'dir')
  // 模板 rsbuild.config 通过包名导入 adapter；Toolchain node_modules 没有自身包链接
  // （会错误解析到 .pnpm 中的旧发布版本），这里改为 file URL 直连源码 adapter。
  const adapterModuleUrl = new URL('../rsbuild/index.ts', import.meta.url).href
  await writeFile(join(frontendRoot, 'rsbuild.config.ts'), `
import { defineConfig } from '@rsbuild/core'
import { pluginVue } from '@rsbuild/plugin-vue'
import { fh2Plugin } from ${JSON.stringify(adapterModuleUrl)}

export default defineConfig({
  plugins: [
    pluginVue(),
    fh2Plugin({
      manifestPath: './fh2-plugin.json',
      pluginEntry: './src/plugin.ts',
      typesOutDir: './src/generated',
      validateOnBuild: true,
    }),
  ],
  output: { distPath: { root: 'dist' } },
})
`)
  await writeFile(join(frontendRoot, 'fh2-plugin.json'), JSON.stringify({
    id: 'exp_real_frontend',
    name: '真实前端构建测试',
    version: '0.1.0',
    entry: './plugin.js',
    extensions: [
      { id: 'hello-action', point: 'cockpit.ui.toolbar-actions' },
      { id: 'hello-panel', point: 'cockpit.ui.left-panel' },
    ],
    views: { 'hello-panel': { entry: './views/hello-panel.js' } },
  }))
  await mkdir(join(backendRoot, 'workflows'), { recursive: true })
  await mkdir(join(backendRoot, 'adapters'), { recursive: true })
  await writeFile(join(backendRoot, 'fh2-plugin.json'), JSON.stringify({
    pluginId: 'exp_real_backend',
    name: '真实后端构建测试',
    version: '0.1.0',
    flows: ['workflows/example.json'],
    scripts: [{ name: 'example-script', path: 'adapters/example.js', entry: 'handle' }],
  }))
  await writeFile(join(backendRoot, 'workflows/example.json'), JSON.stringify({
    name: 'real-backend-flow',
    trigger: { api: {} },
    steps: [{ id: 'run', action: 'run_script', inputs: { script: { const: 'example-script' } } }],
  }))
  await writeFile(join(backendRoot, 'adapters/example.js'), 'function handle() { return {} }\n')
  await writeFile(join(backendRoot, 'schema.sql'), 'CREATE TABLE example_record (title TEXT);\n')
  await writeFile(join(root, 'capabilities.json'), JSON.stringify({ name: '真实构建', description: 'Runner 集成测试' }))
  await writeFile(join(root, 'packages.json'), JSON.stringify([{
    packageId: 'exp_real_package',
    name: '真实构建包',
    capabilityIds: ['exp_real_capability_build'],
  }]))
  const capability: CapabilityProject = {
    kind: 'capability-project',
    root,
    capabilityId: 'exp_real_capability_build',
    metadataPath: join(root, 'capabilities.json'),
    metadata: { name: '真实构建', description: 'Runner 集成测试' },
    frontend: [{ id: 'exp_real_frontend', root: frontendRoot, manifestPath: join(frontendRoot, 'fh2-plugin.json') }],
    backend: [{ id: 'exp_real_backend', root: backendRoot, manifestPath: join(backendRoot, 'fh2-plugin.json') }],
  }
  return { root, frontendRoot, backendRoot, capability }
}
