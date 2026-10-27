// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { generatePluginTypes } from 'fh2-plugin-sdk/generator'
import type { PluginManifest } from 'fh2-plugin-sdk'
import semver from 'semver'
import packageManagerPolicy from '../package-manager-policy.json'
import { askQuestion, runCreatePlugin as createPlugin, isUnpublishedSourceBaseline, packageManagerSpawnPlan, parseCreateArgs, quoteShellArg } from './run.js'

const temporaryDirectories: string[] = []
const require = createRequire(import.meta.url)
const sdkPackage = require('fh2-plugin-sdk/package.json') as { version: string }
const toolchainPackage = require('../../package.json') as { version: string }

const toolchainRoot = dirname(require.resolve('../../package.json'))

const frontendScripts = {
  generate: 'fh2-plugin generate',
  validate: 'fh2-plugin validate',
  build: 'fh2-plugin build',
  watch: 'fh2-plugin build --watch',
  dev: 'fh2-plugin dev',
  'dev:frontend': 'fh2-plugin dev --frontend-only',
  'dev:cockpit': 'fh2-plugin dev cockpit',
  'dev:cockpit:frontend': 'fh2-plugin dev cockpit --frontend-only',
  preview: 'fh2-plugin preview',
  test: 'vitest run',
  tsc: 'vue-tsc --noEmit -p tsconfig.json',
  lint: 'eslint .',
}

const activeCreates = new Set<Promise<number>>()

function runCreatePlugin (...args: Parameters<typeof createPlugin>): ReturnType<typeof createPlugin> {
  const operation = createPlugin(...args)
  activeCreates.add(operation)
  void operation.then(() => activeCreates.delete(operation), () => activeCreates.delete(operation))
  return operation
}

afterEach(async () => {
  // Vitest 超时后原 Promise 仍可能写 fixture，先等待其退出再删目录。
  await Promise.allSettled([...activeCreates])
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('fh2-plugin create 参数', () => {
  it('解析完整非交互参数', () => {
    expect(parseCreateArgs([
      'my-plugin',
      '--plugin-id',
      'exp_my_plugin',
      '--name=我的插件',
      '--package-manager',
      'npm',
      '--platform-root',
      '/tmp/fh2-plugin-platform',
      '--template',
      'frontend-basic',
      '--no-install',
    ])).toEqual({
      directory: 'my-plugin',
      pluginId: 'exp_my_plugin',
      name: '我的插件',
      packageManager: 'npm',
      platformRoot: '/tmp/fh2-plugin-platform',
      template: 'frontend-basic',
      install: false,
      help: false,
      version: false,
    })
  })

  it('拒绝未知包管理器和冲突安装参数', () => {
    expect(() => parseCreateArgs(['p', '--package-manager', 'bun'])).toThrow(/支持：pnpm、npm、yarn/)
    expect(() => parseCreateArgs(['p', '--install', '--no-install'])).toThrow(/不能同时或重复指定/)
    expect(() => parseCreateArgs(['-x'])).toThrow(/未知参数/)
    expect(() => parseCreateArgs(['p', '--template', 'unknown'])).toThrow(/未知插件模板/)
    expect(() => parseCreateArgs(['p', '--template', '3'])).toThrow(/未知插件模板/)
    expect(() => parseCreateArgs(['p', '--status-plugin-id', 'exp_status'])).toThrow(/未知参数/)
  })

  it('-- 之后停止解析选项', () => {
    expect(parseCreateArgs(['--', 'my-plugin'])).toMatchObject({ directory: 'my-plugin' })
  })

  it('帮助区分交互与非交互必填参数', async () => {
    const output = captureWriter()
    const code = await runCreatePlugin({
      args: ['--help'],
      stdinIsTTY: false,
      stdout: output,
      stderr: output,
    })

    expect(code).toBe(0)
    expect(output.text).toContain('fh2-plugin create [项目目录] [选项]')
    expect(output.text).toContain('默认生成完整 Capability')
    expect(output.text).toContain('非交互 Capability 至少提供项目目录')
  })

  it('下一步 shell 参数使用安全单引号转义', () => {
    expect(quoteShellArg('parent dir/my\'plugin')).toBe(`'parent dir/my'\"'\"'plugin'`)
    expect(quoteShellArg('parent dir\\my-plugin', 'win32')).toBe('"parent dir\\my-plugin"')
  })

  it('真实 SIGINT 会中止 readline question 并移除监听器', async () => {
    const signals = new EventEmitter()
    const questioner = {
      question: async (_prompt: string, options: { readonly signal: AbortSignal }) => {
        return await new Promise<string>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('cancelled')
            error.name = 'AbortError'
            reject(error)
          }, { once: true })
        })
      },
    }

    const answer = askQuestion(questioner, signals, '项目目录：')
    signals.emit('SIGINT')
    await expect(answer).rejects.toMatchObject({ name: 'AbortError' })
    expect(signals.listenerCount('SIGINT')).toBe(0)
  })
})

describe('fh2-plugin create 创建工程', () => {
  it('带 --plugin-id 未指定模板时默认生成 frontend-basic 前端插件工程', async () => {
    const root = await temporaryRoot()
    const output = captureWriter()
    const code = await runCreatePlugin({
      args: ['frontend', '--plugin-id', 'exp_frontend', '--no-install'],
      cwd: root,
      stdinIsTTY: false,
      stdout: output,
      stderr: captureWriter(),
    })

    expect(code).toBe(0)
    const manifest = JSON.parse(await readFile(join(root, 'frontend/fh2-plugin.json'), 'utf8'))
    expect(manifest).toMatchObject({
      id: 'exp_frontend',
      permissions: ['platform:dialog'],
      extensions: [
        { id: 'hello-action', point: 'cockpit.ui.toolbar-actions' },
        { id: 'hello-panel', point: 'cockpit.ui.left-panel' },
        { id: 'issue-entry', point: 'cockpit.ui.toolbar-actions', anchor: 'footer-toolbar:before-ai' },
        { id: 'issue-panel', point: 'cockpit.ui.left-bottom-panels' },
      ],
    })
    expect(existsSync(join(root, 'frontend/backend'))).toBe(false)
    await expectDeclaredIcons(join(root, 'frontend'), ['plugin', 'issue', 'issue-active'])
    expect(output.text).toContain('✓ 插件工程已创建')
    expect(output.text).toContain('✓ 类型已生成：src/generated/plugin-types.ts')
  })

  it.each(['pnpm', 'npm', 'yarn'] as const)('前端 README 为 %s 说明首次进入 Cockpit 的真实入口', async (packageManager) => {
    const root = await temporaryRoot()
    const code = await runCreatePlugin({
      args: ['frontend', '--plugin-id', 'exp_frontend', '--package-manager', packageManager, '--no-install'],
      cwd: root,
      stdinIsTTY: false,
      stdout: captureWriter(),
      stderr: captureWriter(),
      detectPackageManagerVersion: () => undefined,
    })

    expect(code).toBe(0)
    const readme = await readFile(join(root, 'frontend/README.md'), 'utf8')
    const pkg = JSON.parse(await readFile(join(root, 'frontend/package.json'), 'utf8'))
    expect(readme).toContain('团队页')
    expect(readme).toContain('设备卡')
    expect(readme).toContain('进入虚拟驾驶舱')
    expect(readme).toContain('设备小窗')
    expect(readme).toContain('“虚拟驾驶舱”')
    expect(readme).toContain(`${packageManager} run dev:cockpit`)
    expect(pkg.scripts['dev:cockpit']).toBe('fh2-plugin dev cockpit')
    expect(pkg.scripts).toEqual(frontendScripts)
  })

  it.each(['pnpm', 'npm', 'yarn'] as const)('工作区根为 %s 仅新增 Cockpit 脚本，保留成员脚本和对应命令文案', async (packageManager) => {
    const root = await temporaryRoot()
    const output = captureWriter()
    const code = await runCreatePlugin({
      args: ['workspace', '--capability-id', 'exp_custom', '--package-manager', packageManager, '--no-install'],
      cwd: root,
      stdinIsTTY: false,
      stdout: output,
      stderr: captureWriter(),
      detectPackageManagerVersion: () => undefined,
    })

    expect(code).toBe(0)
    const workspace = join(root, 'workspace')
    const pkg = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'))
    expect(pkg.scripts).toEqual({
      generate: 'fh2-plugin generate --root exp_custom',
      validate: 'fh2-plugin validate --root exp_custom',
      build: 'fh2-plugin build --root exp_custom',
      dev: 'fh2-plugin dev --root exp_custom',
      'dev:cockpit': 'fh2-plugin dev cockpit --root exp_custom',
      'dev:frontend': 'fh2-plugin dev --root exp_custom --frontend-only',
      'dev:backend': 'fh2-plugin dev --root exp_custom --backend-only',
      preview: 'fh2-plugin preview --root exp_custom',
      pack: 'fh2-plugin pack --root exp_custom',
      test: packageManager === 'pnpm'
        ? 'pnpm -r --if-present test'
        : packageManager === 'npm' ? 'npm run test --workspaces --if-present' : 'yarn workspaces run test',
    })
    expect(pkg.scripts).not.toHaveProperty('dev:cockpit:frontend')
    const readme = await readFile(join(workspace, 'README.md'), 'utf8')
    const debugging = readme.split('## 调试与交付')[1]!
    expect(debugging).toContain(`在外层工作区根运行 \`${packageManager} run dev:cockpit\``)
    expect(debugging).toContain('只调试该插件')
    expect(debugging).toContain('不要假定任意子目录都会命中工作区根脚本')
    const exec = packageManager === 'pnpm' ? 'pnpm exec' : packageManager === 'npm' ? 'npm exec --' : 'yarn'
    expect(debugging).toContain(`${exec} fh2-plugin dev cockpit --root exp_custom`)
    expect(debugging).toContain('旧工程若没有根 `dev:cockpit`')
    expect(output.text).toContain(`  ${packageManager} run dev:cockpit\n`)
    expect(output.text).not.toContain('run dev:cockpit:frontend')
    if (packageManager === 'pnpm') {
      expect(debugging).toContain('pnpm -w run dev:cockpit')
      expect(debugging).toContain('成员 `src/` 命中成员脚本')
    } else {
      expect(debugging).not.toContain('pnpm')
      expect(output.text).not.toContain('pnpm')
    }
    for (const pluginId of ['exp_custom_frontend', 'exp_custom_issues']) {
      const memberRoot = join(workspace, 'exp_custom/frontend', pluginId)
      const member = JSON.parse(await readFile(join(memberRoot, 'package.json'), 'utf8'))
      expect(member.scripts).toEqual(frontendScripts)
      const memberReadme = await readFile(join(memberRoot, 'README.md'), 'utf8')
      expect(memberReadme).toContain(`在本前端插件目录运行 \`${packageManager} run dev:cockpit\``)
      expect(memberReadme).not.toContain('-w run')
    }
  })

  it('创建 backend-basic 后端插件工程', async () => {
    const root = await temporaryRoot()
    const output = captureWriter()
    const code = await runCreatePlugin({
      args: ['backend', '--plugin-id', 'exp_backend', '--name', '后端示例', '--template', 'backend-basic', '--no-install'],
      cwd: root,
      stdinIsTTY: false,
      stdout: output,
      stderr: captureWriter(),
    })

    expect(code).toBe(0)
    const backendRoot = join(root, 'backend')
    const manifest = JSON.parse(await readFile(join(backendRoot, 'fh2-plugin.json'), 'utf8'))
    expect(manifest).toMatchObject({
      pluginId: 'exp_backend',
      name: '后端示例',
      scripts: [expect.objectContaining({ path: 'adapters/example-script.ts', entry: 'handle' })],
      events: [expect.objectContaining({ consumer: expect.any(Array) })],
    })
    // 占位符替换进 README 与 schema.sql。
    expect(await readFile(join(backendRoot, 'README.md'), 'utf8')).toContain('exp_backend')
    expect(await readFile(join(backendRoot, 'README.md'), 'utf8')).not.toContain('__BACKEND_PLUGIN_ID__')
    // 单插件工程没有 backend/ 层级：README 的 dev 指引在插件根直接运行。
    expect(await readFile(join(backendRoot, 'README.md'), 'utf8')).toContain('pnpm run dev')
    expect(await readFile(join(backendRoot, 'README.md'), 'utf8')).not.toContain('--root backend/')
    expect(await readFile(join(backendRoot, 'schema.sql'), 'utf8')).not.toContain('__BACKEND_PLUGIN_NAME__')
    // mock/ 来自 template-capability：dev 回退到插件根读取 fixture 与事件。
    expect(await readFile(join(backendRoot, 'mock/fixtures/default.json'), 'utf8')).toContain('example_record')
    expect(await readFile(join(backendRoot, 'mock/events/example-created.json'), 'utf8')).toContain('example.created')
    // types/ 按当前清单与源码 import 图现生成一遍。
    expect(existsSync(join(backendRoot, 'types/handler.d.ts'))).toBe(true)
    const packageJson = JSON.parse(await readFile(join(backendRoot, 'package.json'), 'utf8'))
    expect(packageJson).toMatchObject({
      name: 'exp_backend',
      scripts: {
        generate: 'fh2-plugin generate',
        validate: 'fh2-plugin validate',
        build: 'fh2-plugin build',
        dev: 'fh2-plugin dev',
        tsc: 'tsc --noEmit -p tsconfig.json',
      },
    })
    expect(output.text).toContain('✓ 后端插件工程已创建')
    expect(output.text).toContain('✓ 后端插件 Worker 契约校验通过')
    expect(output.text).toContain('✓ 后端类型已生成：types/')
  })

  it('默认生成包含独立前后端插件的 Capability Workspace', async () => {
    const root = await temporaryRoot()
    const output = captureWriter()
    const code = await runCreatePlugin({
      args: ['exp_issue_center', '--no-install'],
      cwd: root,
      // 输出文案断言 pnpm：显式固定 UA，避免宿主包管理器（npm/npx 直跑）影响检测结果
      env: { npm_config_user_agent: 'pnpm/10.15.0 node/v20.19.5 darwin arm64' },
      stdinIsTTY: false,
      stdout: output,
      stderr: captureWriter(),
    })

    expect(code).toBe(0)
    // 工作区根只携带 packages.json/package.json/pnpm-workspace.yaml/README；
    // capability 内容（capabilities.json/frontend/backend/mock）住同名子目录。
    const workspaceRoot = join(root, 'exp_issue_center')
    const capabilityRoot = join(workspaceRoot, 'exp_issue_center')
    expect(JSON.parse(await readFile(join(workspaceRoot, 'packages.json'), 'utf8'))).toEqual([{
      packageId: 'exp_issue_center_package',
      name: 'Issue Center包',
      capabilityIds: ['exp_issue_center'],
    }])
    expect(JSON.parse(await readFile(join(capabilityRoot, 'capabilities.json'), 'utf8'))).toMatchObject({
      name: 'Issue Center',
      description: expect.any(String),
    })
    expect(existsSync(join(workspaceRoot, 'capabilities.json'))).toBe(false)
    expect(existsSync(join(capabilityRoot, 'packages.json'))).toBe(false)
    expect(JSON.parse(await readFile(join(capabilityRoot, 'frontend/exp_issue_center_frontend/fh2-plugin.json'), 'utf8')))
      .toMatchObject({ id: 'exp_issue_center_frontend' })
    expect(JSON.parse(await readFile(join(capabilityRoot, 'frontend/exp_issue_center_issues/fh2-plugin.json'), 'utf8')))
      .toMatchObject({
        id: 'exp_issue_center_issues',
        permissions: ['platform:dialog'],
        extensions: [
          { id: 'issue-entry', point: 'cockpit.ui.toolbar-actions', anchor: 'footer-toolbar:before-ai' },
          { id: 'issue-panel', point: 'cockpit.ui.left-bottom-panels' },
        ],
        views: {
          'issue-panel': { entry: './views/issue-panel.js' },
          'issue-dialog': { entry: './views/issue-dialog.js' },
        },
      })
    expect(await readFile(join(capabilityRoot, 'frontend/exp_issue_center_issues/src/hosts/cockpit/activate.ts'), 'utf8'))
      .toContain('registerIssueExample')
    expect(JSON.parse(await readFile(join(capabilityRoot, 'backend/exp_issue_center_backend/fh2-plugin.json'), 'utf8')))
      .toMatchObject({
        pluginId: 'exp_issue_center_backend',
        events: [expect.objectContaining({ consumer: expect.any(Array) })],
        scripts: [expect.objectContaining({ path: 'adapters/example-script.ts', entry: 'handle' })],
      })
    // entities 刻意不在清单里:存储事实由 schema.sql 单点驱动,build 投影进产物。
    const backendManifest = JSON.parse(await readFile(join(capabilityRoot, 'backend/exp_issue_center_backend/fh2-plugin.json'), 'utf8'))
    expect(backendManifest.entities).toBeUndefined()
    expect(await readFile(join(capabilityRoot, 'backend/exp_issue_center_backend/handlers/example/create.ts'), 'utf8'))
      .toContain('export function create')
    expect(await readFile(join(capabilityRoot, 'backend/exp_issue_center_backend/handlers/example/create.ts'), 'utf8'))
      .toContain('import { createRecord }')
    expect(await readFile(join(capabilityRoot, 'backend/exp_issue_center_backend/events/example-created.ts'), 'utf8'))
      .toContain('import { ingestEvent }')
    // 占位符替换进 README 与 schema.sql,创建出来的引导命令可直接复制执行。
    expect(await readFile(join(capabilityRoot, 'backend/exp_issue_center_backend/README.md'), 'utf8'))
      .toContain('exp_issue_center_backend')
    expect(await readFile(join(capabilityRoot, 'backend/exp_issue_center_backend/README.md'), 'utf8'))
      .not.toContain('__BACKEND_PLUGIN_ID__')
    expect(await readFile(join(capabilityRoot, 'backend/exp_issue_center_backend/schema.sql'), 'utf8'))
      .not.toContain('__BACKEND_PLUGIN_NAME__')
    // types/ 只投影 Host 注入面；schema.sql 不再生成 EntityMap 或 storage facade。
    expect(existsSync(join(capabilityRoot, 'backend/exp_issue_center_backend/types/entities.d.ts'))).toBe(false)
    expect(existsSync(join(capabilityRoot, 'backend/exp_issue_center_backend/types/storage.ts'))).toBe(false)
    expect(await readFile(join(capabilityRoot, 'backend/exp_issue_center_backend/shared/store.ts'), 'utf8'))
      .toContain('queryStore')
    expect(existsSync(join(capabilityRoot, 'backend/exp_issue_center_backend/tsconfig.json'))).toBe(true)
    expect(await readFile(join(capabilityRoot, 'backend/exp_issue_center_backend/workflows/example-flow.json'), 'utf8'))
      .toContain('"trigger"')
    expect(await readFile(join(capabilityRoot, 'mock/fixtures/default.json'), 'utf8')).toContain('example_record')
    expect(existsSync(join(workspaceRoot, 'mock'))).toBe(false)
    const rootPackage = JSON.parse(await readFile(join(workspaceRoot, 'package.json'), 'utf8'))
    expect(rootPackage).toMatchObject({
      name: 'exp_issue_center',
      workspaces: ['exp_issue_center/frontend/*'],
      devDependencies: {
        'fh2-plugin-sdk': sdkPackage.version,
        'fh2-plugin-toolchain': toolchainPackage.version,
      },
      scripts: {
        generate: 'fh2-plugin generate --root exp_issue_center',
        validate: 'fh2-plugin validate --root exp_issue_center',
        build: 'fh2-plugin build --root exp_issue_center',
        dev: 'fh2-plugin dev --root exp_issue_center',
        preview: 'fh2-plugin preview --root exp_issue_center',
        pack: 'fh2-plugin pack --root exp_issue_center',
      },
    })
    expect(output.text).toContain('pnpm run generate')
    expect(output.text).toContain('pnpm run build')
    expect(output.text).toContain('pnpm run dev')
    expect(output.text).toContain('pnpm run preview')
    expect(output.text).toContain('pnpm run pack')
    const pnpmWorkspace = await readFile(join(workspaceRoot, 'pnpm-workspace.yaml'), 'utf8')
    expect(pnpmWorkspace).toContain('packages:')
    expect(pnpmWorkspace).toContain('exp_issue_center/frontend/*')
    expect(pnpmWorkspace).toContain('onlyBuiltDependencies')
    const capabilityReadme = await readFile(join(workspaceRoot, 'README.md'), 'utf8')
    expect(capabilityReadme).toContain('pnpm run build')
    expect(capabilityReadme).toContain('pnpm run dev')
    expect(capabilityReadme).toContain('pnpm run preview')
    expect(capabilityReadme).toContain('团队页')
    expect(capabilityReadme).toContain('进入虚拟驾驶舱')
    expect(capabilityReadme).toContain('pnpm exec fh2-plugin dev cockpit --root exp_issue_center')
    expect(capabilityReadme).toContain('pnpm run dev:cockpit')
    expect(rootPackage.scripts['dev:cockpit']).toBe('fh2-plugin dev cockpit --root exp_issue_center')
    expect(rootPackage.scripts).not.toHaveProperty('dev:cockpit:frontend')
    await expectDeclaredIcons(join(capabilityRoot, 'frontend/exp_issue_center_frontend'), ['plugin'])
    await expectDeclaredIcons(join(capabilityRoot, 'frontend/exp_issue_center_issues'), ['issue', 'issue-active'])
    for (const pluginId of ['exp_issue_center_frontend', 'exp_issue_center_issues']) {
      const readme = await readFile(join(capabilityRoot, 'frontend', pluginId, 'README.md'), 'utf8')
      expect(readme).toContain('进入虚拟驾驶舱')
      expect(readme).toContain('pnpm run dev:cockpit')
    }
  })

  // 真实构建用例：隔离运行 5-7s，满载并行下会超过 vitest 默认 5s 超时。
  it('capability 内两个前端插件按示例拆分自同一模板', { timeout: 30_000 }, async () => {
    const root = await temporaryRoot()
    const legacyCode = await runCreatePlugin({
      args: ['legacy', '--template', 'frontend-basic', '--plugin-id', 'exp_shared_frontend', '--no-install'],
      cwd: root,
      stdinIsTTY: false,
      stdout: captureWriter(),
      stderr: captureWriter(),
    })
    const capabilityCode = await runCreatePlugin({
      args: ['exp_workspace', '--template', 'capability-fullstack', '--frontend-plugin-id', 'exp_shared_frontend', '--no-install'],
      cwd: root,
      stdinIsTTY: false,
      stdout: captureWriter(),
      stderr: captureWriter(),
    })

    expect(legacyCode).toBe(0)
    expect(capabilityCode).toBe(0)
    const legacyRoot = join(root, 'legacy')
    const helloRoot = join(root, 'exp_workspace/exp_workspace/frontend/exp_shared_frontend')
    const issuesRoot = join(root, 'exp_workspace/exp_workspace/frontend/exp_workspace_issues')
    for (const file of [
      'src/plugin.ts',
      'src/hosts/cockpit/hello-example.ts',
      'src/views/hello-panel/HelloPanel.vue',
      'src/views/hello-panel/contract.ts',
      'src/views/hello-panel/index.ts',
      'src/views/hello-panel/mount.ts',
      'tests/contract.test.ts',
      'public/icons/plugin.svg',
      'rsbuild.config.ts',
      'tsconfig.json',
      'vitest.config.ts',
    ]) {
      expect(await readFile(join(helloRoot, file), 'utf8'))
        .toBe(await readFile(join(legacyRoot, file), 'utf8'))
    }
    for (const file of [
      'src/plugin.ts',
      'src/hosts/cockpit/issue-example.ts',
      'src/views/issue-panel/IssuePanel.vue',
      'src/views/issue-panel/contract.ts',
      'src/views/issue-panel/index.ts',
      'src/views/issue-dialog/IssueDialog.vue',
      'src/views/issue-dialog/contract.ts',
      'src/views/issue-dialog/index.ts',
      'tests/contract.test.ts',
      'tests/issue-activate.test.ts',
      'public/icons/issue.svg',
      'public/icons/issue-active.svg',
      'rsbuild.config.ts',
    ]) {
      expect(await readFile(join(issuesRoot, file), 'utf8'))
        .toBe(await readFile(join(legacyRoot, file), 'utf8'))
    }

    // hello 插件裁剪 issue 文件，issue 插件裁剪 hello 文件
    for (const file of [
      'src/hosts/cockpit/issue-example.ts',
      'src/views/issue-panel/contract.ts',
      'src/views/issue-dialog/contract.ts',
      'public/icons/issue.svg',
      'tests/issue-activate.test.ts',
      'tests/resource-cleanup.test.ts',
    ]) {
      await expect(readFile(join(helloRoot, file), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    }
    for (const file of [
      'src/hosts/cockpit/hello-example.ts',
      'src/views/hello-panel/contract.ts',
    ]) {
      await expect(readFile(join(issuesRoot, file), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(await readFile(join(helloRoot, 'src/hosts/cockpit/activate.ts'), 'utf8')).toContain('registerHelloExample')
    expect(await readFile(join(helloRoot, 'src/hosts/cockpit/activate.ts'), 'utf8')).not.toContain('registerIssueExample')
  })

  it('支持自定义现场问题插件 ID 并拒绝重复 ID', async () => {
    const root = await temporaryRoot()
    const customCode = await runCreatePlugin({
      args: ['exp_custom_issues', '--issues-plugin-id', 'exp_onsite', '--no-install'],
      cwd: root,
      stdinIsTTY: false,
      stdout: captureWriter(),
      stderr: captureWriter(),
    })

    expect(customCode).toBe(0)
    expect(JSON.parse(await readFile(join(root, 'exp_custom_issues/exp_custom_issues/frontend/exp_onsite/fh2-plugin.json'), 'utf8')))
      .toMatchObject({ id: 'exp_onsite' })

    const duplicateCode = await runCreatePlugin({
      args: ['exp_dup_issues', '--frontend-plugin-id', 'exp_same', '--issues-plugin-id', 'exp_same', '--no-install'],
      cwd: root,
      stdinIsTTY: false,
      stdout: captureWriter(),
      stderr: captureWriter(),
    })
    expect(duplicateCode).toBe(1)
  })

  it('在平台仓库根交互创建时默认写入 examples 且不自动安装', async () => {
    const root = await temporaryRoot()
    await createPlatformRepositoryRoot(root)
    const commands: unknown[] = []
    const responses = ['1', 'exp_root_demo', '', '', '', '']
    const code = await runCreatePlugin({
      args: [],
      cwd: root,
      stdinIsTTY: true,
      stdout: captureWriter(),
      stderr: captureWriter(),
      ask: async (_message, defaultValue) => responses.shift() || defaultValue || '',
      detectPackageManagerVersion: () => '10.17.0',
      // 固定 UA，避免宿主包管理器影响检测。
      env: { npm_config_user_agent: 'pnpm/10.15.0 node/v20.19.5 darwin arm64' },
      runCommand: async (...args) => {
        commands.push(args)
      },
    })

    expect(code).toBe(0)
    expect(commands).toEqual([])
    expect(JSON.parse(await readFile(join(root, 'examples/exp_root_demo/package.json'), 'utf8'))).toMatchObject({
      packageManager: 'pnpm@10.17.0',
      dependencies: { 'fh2-plugin-sdk': 'file:../../packages/fh2-plugin-sdk' },
      devDependencies: {
        'fh2-plugin-toolchain': 'file:../../packages/fh2-plugin-toolchain',
      },
    })
    const frontendWorkspace = await readFile(join(root, 'examples/exp_root_demo/pnpm-workspace.yaml'), 'utf8')
    expect(frontendWorkspace).toContain('overrides:')
    expect(frontendWorkspace).toContain('fh2-plugin-sdk: file:../../packages/fh2-plugin-sdk')
    expect(frontendWorkspace).toContain('fh2-plugin-toolchain: file:../../packages/fh2-plugin-toolchain')
    // 运行数据随 Toolchain 交付，不生成完整 Contract 的仓外依赖。
    expect(frontendWorkspace).not.toContain('fh2-plugin-contract')
    expect(frontendWorkspace).not.toContain('fh2-plugin-engine')
    // responses 首答 '1' = frontend-basic：单前端插件工程没有 backend/ 目录。
    expect(existsSync(join(root, 'examples/exp_root_demo/backend'))).toBe(false)
    expect(JSON.parse(await readFile(join(root, 'examples/exp_root_demo/fh2-plugin.json'), 'utf8')))
      .toMatchObject({ id: 'exp_root_demo' })
  })

  it('从平台仓子目录向上识别本地依赖来源', async () => {
    const root = await temporaryRoot()
    await createPlatformRepositoryRoot(root)
    const cwd = join(root, '_test')
    await mkdir(cwd)
    const stderr = captureWriter()

    const code = await runCreatePlugin({
      args: ['exp_local', '--no-install'],
      cwd,
      stdinIsTTY: false,
      stdout: captureWriter(),
      stderr,
    })

    expect(code).toBe(0)
    const pkg = JSON.parse(await readFile(join(cwd, 'exp_local/package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
    }
    expect(pkg.devDependencies['fh2-plugin-sdk']).toBe('file:../../packages/fh2-plugin-sdk')
    expect(pkg.devDependencies['fh2-plugin-toolchain']).toBe('file:../../packages/fh2-plugin-toolchain')
    expect(pkg.devDependencies).not.toHaveProperty('@4f2e/fh2-plugin-engine')
    expect(pkg).not.toHaveProperty('resolutions')
    expect(stderr.text).toContain(`依赖来源：本地平台仓 ${root}`)
  })

  it('支持 --platform-root 在仓外生成本地 file: 依赖', async () => {
    const platformRoot = await temporaryRoot()
    await createPlatformRepositoryRoot(platformRoot)
    const externalRoot = await temporaryRoot()
    const stderr = captureWriter()

    const code = await runCreatePlugin({
      args: ['exp_external', '--platform-root', platformRoot, '--no-install'],
      cwd: externalRoot,
      stdinIsTTY: false,
      stdout: captureWriter(),
      stderr,
    })

    expect(code).toBe(0)
    const pkg = JSON.parse(await readFile(join(externalRoot, 'exp_external/package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
    }
    expect(pkg.devDependencies['fh2-plugin-sdk']).toMatch(/^file:/)
    expect(pkg.devDependencies['fh2-plugin-toolchain']).toMatch(/^file:/)
    expect(pkg.devDependencies).not.toHaveProperty('@4f2e/fh2-plugin-engine')
    expect(stderr.text).toContain(`依赖来源：本地平台仓 ${platformRoot}`)
  })

  it('平台仓仅需 SDK/Toolchain，生成工程不包含 contract 覆盖', async () => {
    const root = await temporaryRoot()
    await createPlatformRepositoryRoot(root)

    const code = await runCreatePlugin({
      args: ['legacy', '--template', 'frontend-basic', '--plugin-id', 'exp_legacy_demo', '--no-install'],
      cwd: root,
      stdinIsTTY: false,
      stdout: captureWriter(),
      stderr: captureWriter(),
    })

    expect(code).toBe(0)
    const workspace = await readFile(join(root, 'legacy/pnpm-workspace.yaml'), 'utf8')
    expect(workspace).toContain('fh2-plugin-sdk: file:../packages/fh2-plugin-sdk')
    expect(workspace).toContain('fh2-plugin-toolchain: file:../packages/fh2-plugin-toolchain')
    expect(workspace).not.toContain('fh2-plugin-contract')
  })

  it('npm link 的 bin package root 在仓外自动发现平台仓', async () => {
    const platformRoot = await temporaryRoot()
    await createPlatformRepositoryRoot(platformRoot)
    const externalRoot = await temporaryRoot()
    const stderr = captureWriter()

    const code = await runCreatePlugin({
      args: ['exp_linked', '--no-install'],
      cwd: externalRoot,
      env: {
        FH2_TOOLCHAIN_PACKAGE_ROOT: join(platformRoot, 'packages/fh2-plugin-toolchain'),
      },
      stdinIsTTY: false,
      stdout: captureWriter(),
      stderr,
    })

    expect(code).toBe(0)
    const pkg = JSON.parse(await readFile(join(externalRoot, 'exp_linked/package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
    }
    expect(pkg.devDependencies['fh2-plugin-sdk']).toMatch(/^file:/)
    expect(pkg.devDependencies['fh2-plugin-toolchain']).toMatch(/^file:/)
    expect(stderr.text).toContain(`依赖来源：本地平台仓 ${platformRoot}`)
  })

  it.each(['bin', 'platform-root'] as const)('仓外交互创建从 %s 取得 SOURCE 时默认直接创建并安装', async (source) => {
    const platformRoot = await temporaryRoot()
    await createPlatformRepositoryRoot(platformRoot)
    const externalRoot = await temporaryRoot()
    const prompts: Array<{ message: string; defaultValue?: string }> = []
    const commands: Array<{ command: string; args: readonly string[]; cwd: string }> = []
    const code = await runCreatePlugin({
      args: source === 'platform-root' ? ['--platform-root', platformRoot] : [],
      cwd: externalRoot,
      env: source === 'bin'
        ? { FH2_TOOLCHAIN_PACKAGE_ROOT: join(platformRoot, 'packages/fh2-plugin-toolchain') }
        : {},
      stdinIsTTY: true,
      stdout: captureWriter(),
      stderr: captureWriter(),
      ask: async (message, defaultValue) => {
        prompts.push({ message, ...(defaultValue === undefined ? {} : { defaultValue }) })
        return defaultValue ?? ''
      },
      detectPackageManagerVersion: () => '10.15.0',
      runCommand: async (command, args, cwd) => {
        commands.push({ command, args, cwd })
      },
    })

    expect(code).toBe(0)
    expect(prompts.find(prompt => prompt.message.startsWith('工作区目录'))?.defaultValue).toBe('exp_capability')
    expect(prompts.find(prompt => prompt.message.startsWith('是否立即安装'))?.defaultValue).toBe('是')
    const project = join(externalRoot, 'exp_capability')
    expect(commands).toEqual([
      { command: 'pnpm', args: ['install'], cwd: project },
      { command: 'pnpm', args: ['run', 'generate'], cwd: project },
    ])
    const pkg = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))
    expect(pkg.devDependencies['fh2-plugin-toolchain']).toMatch(/^file:/)
    expect(existsSync(join(externalRoot, 'examples'))).toBe(false)
  })

  it('cli 强制模式拒绝在仓外使用未发布源码基线生成依赖', async () => {
    const root = await temporaryRoot()
    const stderr = captureWriter()

    const code = await runCreatePlugin({
      args: ['exp_unpublished', '--no-install'],
      cwd: root,
      stdinIsTTY: false,
      stdout: captureWriter(),
      stderr,
      enforceDependencySource: true,
    })

    expect(code).toBe(1)
    expect(stderr.text).toContain('未携带发布标记')
    expect(existsSync(join(root, 'exp_unpublished'))).toBe(false)
  })

  it('完整能力向导在目录名非法时即时重问，而非安装前才报 ID 错误', async () => {
    const root = await temporaryRoot()
    const stderr = captureWriter()
    const prompts: string[] = []
    const responses = ['0', 'my-project', 'exp_hello', '', '', '否']
    const code = await runCreatePlugin({
      args: [],
      cwd: root,
      env: {},
      stdinIsTTY: true,
      stdout: captureWriter(),
      stderr,
      ask: async (message, defaultValue) => {
        prompts.push(message)
        return responses.shift() || defaultValue || ''
      },
    })
    expect(code).toBe(0)
    expect(prompts.filter(message => message.startsWith('工作区目录'))).toHaveLength(2)
    expect(stderr.text).toContain('目录名也作为能力 ID，请使用 exp_ 或 official_')
    expect(existsSync(join(root, 'my-project'))).toBe(false)
    expect(existsSync(join(root, 'exp_hello/exp_hello/capabilities.json'))).toBe(true)
  })

  it('受控场景用环境变量显式放行未发布基线', async () => {
    const root = await temporaryRoot()

    const code = await runCreatePlugin({
      args: ['exp_sanctioned', '--no-install'],
      cwd: root,
      env: { FH2_CREATE_ALLOW_UNPUBLISHED_BASELINE: '1' },
      stdinIsTTY: false,
      stdout: captureWriter(),
      stderr: captureWriter(),
      enforceDependencySource: true,
    })

    expect(code).toBe(0)
    expect(existsSync(join(root, 'exp_sanctioned/exp_sanctioned/capabilities.json'))).toBe(true)
  })

  it('isUnpublishedSourceBaseline：无标记拦截、有 CI 发布标记放行、缺损坏保守拦截', async () => {
    const root = await temporaryRoot()

    // 本地源码基线：package.json 无 fh2 标记
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fh2-plugin-toolchain', version: '0.1.0' }))
    expect(isUnpublishedSourceBaseline(root)).toBe(true)

    // CI 发布物：fh2.published = true
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fh2-plugin-toolchain', version: '0.1.0', fh2: { published: true } }))
    expect(isUnpublishedSourceBaseline(root)).toBe(false)

    // package.json 缺失（目录不存在）：保守拦截
    expect(isUnpublishedSourceBaseline(join(root, 'missing'))).toBe(true)

    // package.json 损坏（非法 JSON）：保守拦截
    await writeFile(join(root, 'package.json'), '{ broken')
    expect(isUnpublishedSourceBaseline(root)).toBe(true)
  })

  it('不安装依赖也生成完整独立工程和类型', async () => {
    const root = await temporaryRoot()
    const output = captureWriter()
    const code = await runCreatePlugin({
      args: ['my-plugin', '--plugin-id', 'exp_my_plugin', '--template', 'frontend-basic', '--package-manager', 'pnpm', '--no-install'],
      cwd: root,
      stdinIsTTY: false,
      stdout: output,
      stderr: output,
      detectPackageManagerVersion: () => '10.17.0',
    })

    expect(code).toBe(0)
    const project = join(root, 'my-plugin')
    const manifest = JSON.parse(await readFile(join(project, 'fh2-plugin.json'), 'utf8')) as Record<string, unknown>
    const pkg = JSON.parse(await readFile(join(project, 'package.json'), 'utf8')) as Record<string, any>
    const generated = await readFile(join(project, 'src/generated/plugin-types.ts'), 'utf8')

    expect(manifest).toMatchObject({
      id: 'exp_my_plugin',
      name: 'My Plugin',
      entry: './plugin.js',
      permissions: ['platform:dialog'],
      extensions: [
        { id: 'hello-action', point: 'cockpit.ui.toolbar-actions' },
        { id: 'hello-panel', point: 'cockpit.ui.left-panel' },
        { id: 'issue-entry', point: 'cockpit.ui.toolbar-actions', anchor: 'footer-toolbar:before-ai' },
        { id: 'issue-panel', point: 'cockpit.ui.left-bottom-panels' },
      ],
    })
    expect(manifest.views).toEqual({
      'hello-panel': { entry: './views/hello-panel.js' },
      'issue-panel': { entry: './views/issue-panel.js' },
      'issue-dialog': { entry: './views/issue-dialog.js' },
    })
    expect(manifest).not.toHaveProperty('manifestVersion')
    expect(pkg.packageManager).toBe('pnpm@10.17.0')
    expect(pkg.name).toBe('exp_my_plugin')
    expect(pkg.dependencies).not.toHaveProperty('@4f2e/fh2-plugin-engine')
    expect(pkg.dependencies['fh2-plugin-sdk']).toBe(sdkPackage.version)
    expect(pkg.devDependencies).not.toHaveProperty('@4f2e/fh2-plugin-engine')
    expect(pkg.devDependencies['fh2-plugin-toolchain']).toBe(toolchainPackage.version)
    expect(pkg.scripts.preview).toBe('fh2-plugin preview')
    expect(pkg.scripts).not.toHaveProperty('pack')
    expect(generated).toContain('\'hello-action\'')
    expect(generated).toContain('\'hello-panel\'')
    expect(generated).toContain('\'issue-entry\'')
    expect(generated).toBe(generatePluginTypes({
      manifest: manifest as unknown as PluginManifest,
      outDir: join(project, 'src/generated'),
    }).source)
    expect(await readFile(join(project, '.npmrc'), 'utf8')).not.toMatch(/auth|token/i)
    expect(await readFile(join(project, 'README.md'), 'utf8')).toContain('`pack` 由包含该插件的行业包统一执行')
    const vscodeSettings = JSON.parse(await readFile(join(project, '.vscode/settings.json'), 'utf8')) as {
      'json.schemas': readonly { fileMatch: readonly string[]; url: string }[];
    }
    expect(vscodeSettings['json.schemas']).toHaveLength(1)
    expect(vscodeSettings['json.schemas'][0]!.fileMatch).toContain('**/fh2-plugin.json')
    expect(vscodeSettings['json.schemas'][0]!.url).toBe('./node_modules/fh2-plugin-sdk/dist/schema/manifest.schema.json')
    expect(output.text).toContain('类型已生成')
  })

  it('pnpm 版本低于 10 时固定到支持 workspace overrides 的版本', async () => {
    const root = await temporaryRoot()
    const code = await runCreatePlugin({
      args: ['plugin', '--plugin-id', 'exp_plugin', '--template', 'frontend-basic', '--package-manager', 'pnpm', '--no-install'],
      cwd: root,
      stdinIsTTY: false,
      stdout: captureWriter(),
      stderr: captureWriter(),
      detectPackageManagerVersion: () => '8.3.1',
    })

    expect(code).toBe(0)
    const pkg = JSON.parse(await readFile(join(root, 'plugin/package.json'), 'utf8')) as { packageManager?: string }
    expect(pkg.packageManager).toBe('pnpm@10.15.0')
  })

  it.each([
    ['11.22.0', '10.15.0'],
    ['11.0.0', '10.15.0'],
    ['10.0.0', '10.15.0'],
    ['10.14.99', '10.15.0'],
    ['10.15.0', '10.15.0'],
    ['10.17.0', '10.17.0'],
    ['10.99.0', '10.99.0'],
    ['10.15.0-rc.1', '10.15.0'],
    ['10.invalid', '10.15.0'],
    ['9.15.0', '10.15.0'],
    [undefined, '10.15.0'],
  ])('探测 pnpm %s 时生成受支持的版本 %s', async (detectedVersion, expectedVersion) => {
    const root = await temporaryRoot()
    const code = await runCreatePlugin({
      args: ['plugin', '--plugin-id', 'exp_plugin', '--package-manager', 'pnpm', '--no-install'],
      cwd: root,
      stdinIsTTY: false,
      stdout: captureWriter(),
      stderr: captureWriter(),
      detectPackageManagerVersion: () => detectedVersion,
    })

    expect(code).toBe(0)
    const pkg = JSON.parse(await readFile(join(root, 'plugin/package.json'), 'utf8'))
    expect(pkg.packageManager).toBe(`pnpm@${expectedVersion}`)
    expect(semver.satisfies(pkg.packageManager.slice('pnpm@'.length), packageManagerPolicy.pnpm.range)).toBe(true)
  })

  it.each(['frontend-basic', 'backend-basic', 'capability-fullstack'] as const)('%s 探测旧 pnpm 时在安装回调前写入支持版本（非真实首装）', async (template) => {
    const root = await temporaryRoot()
    const commands: string[][] = []
    const code = await runCreatePlugin({
      args: ['exp_plugin', '--plugin-id', 'exp_plugin', '--template', template, '--package-manager', 'pnpm', '--install'],
      cwd: root,
      stdinIsTTY: false,
      stdout: captureWriter(),
      stderr: captureWriter(),
      detectPackageManagerVersion: () => '10.0.0',
      runCommand: async (command, args, cwd) => {
        const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'))
        expect(pkg.packageManager).toBe('pnpm@10.15.0')
        commands.push([command, ...args])
      },
    })

    expect(code).toBe(0)
    expect(commands).toEqual([['pnpm', 'install'], ['pnpm', 'run', 'generate']])
    if (template === 'capability-fullstack') {
      for (const pluginId of ['exp_plugin', 'exp_plugin_issues']) {
        const pkg = JSON.parse(await readFile(join(root, 'exp_plugin/exp_plugin/frontend', pluginId, 'package.json'), 'utf8'))
        expect(pkg.packageManager).toBe('pnpm@10.15.0')
      }
    }
  })

  it.each([['npm', '11.6.1'], ['yarn', '1.22.21']] as const)('%s 不受 pnpm 支持范围影响，保留探测版本', async (packageManager, version) => {
    const root = await temporaryRoot()
    const code = await runCreatePlugin({
      args: ['plugin', '--plugin-id', 'exp_plugin', '--package-manager', packageManager, '--no-install'],
      cwd: root,
      stdinIsTTY: false,
      stdout: captureWriter(),
      stderr: captureWriter(),
      detectPackageManagerVersion: () => version,
    })

    expect(code).toBe(0)
    const pkg = JSON.parse(await readFile(join(root, 'plugin/package.json'), 'utf8'))
    expect(pkg.packageManager).toBe(`${packageManager}@${version}`)
  })

  it('交互提示 Plugin ID 用途、即时重问非法输入，并默认安装依赖', async () => {
    const root = await temporaryRoot()
    const stderr = captureWriter()
    const prompts: Array<{ message: string; defaultValue?: string }> = []
    const responses = ['1', 'invalid', 'exp_interactive_plugin', '', '', '', '']
    const commands: Array<{ command: string; args: readonly string[] }> = []

    const code = await runCreatePlugin({
      args: [],
      cwd: root,
      env: { npm_config_user_agent: 'yarn/1.22.21 node/v22.0.0 darwin arm64' },
      stdinIsTTY: true,
      stdout: captureWriter(),
      stderr,
      ask: async (message, defaultValue) => {
        prompts.push({ message, ...(defaultValue === undefined ? {} : { defaultValue }) })
        const response = responses.shift()
        return response === '' ? defaultValue ?? '' : response ?? ''
      },
      runCommand: async (command, args) => {
        commands.push({ command, args })
      },
    })

    expect(code).toBe(0)
    expect(stderr.text).toContain('Plugin ID 不合法')
    expect(prompts).toEqual([
      { message: '工程类型（0=完整 Capability，1=前端插件，2=后端插件）', defaultValue: 'capability-fullstack' },
      { message: 'Plugin ID（扩展插件使用 exp_ 前缀；例如 exp_workbench_demo）' },
      { message: 'Plugin ID（扩展插件使用 exp_ 前缀；例如 exp_workbench_demo）' },
      { message: '项目目录（默认使用 Plugin ID，仅决定生成路径）', defaultValue: 'exp_interactive_plugin' },
      { message: '插件名称（Workbench 显示名称）', defaultValue: 'Interactive Plugin' },
      { message: '包管理器（pnpm/npm/yarn）', defaultValue: 'yarn' },
      { message: '是否立即安装依赖（是/否）', defaultValue: '是' },
    ])
    expect(commands).toEqual([
      { command: 'yarn', args: ['install'] },
      { command: 'yarn', args: ['run', 'generate'] },
    ])

    const pkg = JSON.parse(await readFile(join(root, 'exp_interactive_plugin/package.json'), 'utf8')) as {
      name: string;
    }
    expect(pkg.name).toBe('exp_interactive_plugin')
    // frontend-basic 单插件工程：无 backend/ 目录，Manifest 为双示例前端。
    expect(existsSync(join(root, 'exp_interactive_plugin/backend'))).toBe(false)
    expect(JSON.parse(await readFile(join(root, 'exp_interactive_plugin/fh2-plugin.json'), 'utf8'))).toMatchObject({
      id: 'exp_interactive_plugin',
      permissions: ['platform:dialog'],
    })
  })

  it('允许目录名与 Plugin ID 不同且不产生包名漂移', async () => {
    const root = await temporaryRoot()
    const code = await runCreatePlugin({
      args: ['Workbench Demo', '--plugin-id', 'exp_workbench_demo', '--no-install'],
      cwd: root,
      stdinIsTTY: false,
      stdout: captureWriter(),
      stderr: captureWriter(),
    })

    expect(code).toBe(0)
    const pkg = JSON.parse(await readFile(join(root, 'Workbench Demo/package.json'), 'utf8')) as {
      name: string;
    }
    expect(pkg.name).toBe('exp_workbench_demo')
  })

  it.each(['pnpm', 'npm', 'yarn'] as const)('为 %s 执行安装和类型复验', async (packageManager) => {
    const root = await temporaryRoot()
    const commands: Array<{ command: string; args: readonly string[] }> = []
    const code = await runCreatePlugin({
      args: ['plugin', '--plugin-id', 'exp_plugin', '--package-manager', packageManager, '--install'],
      cwd: root,
      stdinIsTTY: false,
      stdout: captureWriter(),
      stderr: captureWriter(),
      detectPackageManagerVersion: () => undefined,
      runCommand: async (command, args) => {
        commands.push({ command, args })
      },
    })

    expect(code).toBe(0)
    expect(commands).toEqual([
      { command: packageManager, args: ['install'] },
      { command: packageManager, args: ['run', 'generate'] },
    ])
    const pkg = JSON.parse(await readFile(join(root, 'plugin/package.json'), 'utf8')) as {
      scripts: Record<string, string>;
      packageManager?: string;
    }
    expect(pkg.packageManager).toBe(packageManager === 'pnpm' ? 'pnpm@10.15.0' : undefined)
    expect(pkg.scripts).not.toHaveProperty('pack')
  })

  it('根据 npm user-agent 选择包管理器', async () => {
    const root = await temporaryRoot()
    const code = await runCreatePlugin({
      args: ['plugin', '--plugin-id', 'exp_plugin', '--no-install'],
      cwd: root,
      env: { npm_config_user_agent: 'npm/11.6.1 node/v22.0.0 darwin arm64' },
      stdinIsTTY: false,
      stdout: captureWriter(),
      stderr: captureWriter(),
    })

    expect(code).toBe(0)
    expect(await readFile(join(root, 'plugin/README.md'), 'utf8')).toContain('npm run dev')
  })

  it('在写文件前拒绝非法 Plugin ID 和非空目录', async () => {
    const root = await temporaryRoot()
    for (const [directory, pluginId] of [
      ['invalid-uppercase', 'INVALID'],
      ['invalid-legacy', 'com.example.plugin'],
      ['invalid-prefix', 'plugin'],
    ] as const) {
      const invalidCode = await runCreatePlugin({
        args: [directory, '--plugin-id', pluginId, '--no-install'],
        cwd: root,
        stdinIsTTY: false,
        stdout: captureWriter(),
        stderr: captureWriter(),
      })
      expect(invalidCode).toBe(1)
      await expect(readFile(join(root, directory, 'fh2-plugin.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    }

    await mkdir(join(root, 'existing'))
    await writeFile(join(root, 'existing/keep.txt'), 'keep')
    const oldPackage = `${JSON.stringify({
      scripts: { 'dev:cockpit': 'custom cockpit', 'dev:cockpit:frontend': 'custom frontend', legacy: 'keep me' },
    }, null, 2)}\n`
    await writeFile(join(root, 'existing/package.json'), oldPackage)
    const existingCode = await runCreatePlugin({
      args: ['existing', '--plugin-id', 'exp_existing', '--no-install'],
      cwd: root,
      stdinIsTTY: false,
      stdout: captureWriter(),
      stderr: captureWriter(),
    })
    expect(existingCode).toBe(1)
    expect(await readFile(join(root, 'existing/keep.txt'), 'utf8')).toBe('keep')
    expect(await readFile(join(root, 'existing/package.json'), 'utf8')).toBe(oldPackage)
  })

  it('安装失败时保留完整源码工程', async () => {
    const root = await temporaryRoot()
    const output = captureWriter()
    const code = await runCreatePlugin({
      args: ['plugin', '--plugin-id', 'exp_plugin', '--package-manager', 'npm', '--install'],
      cwd: root,
      stdinIsTTY: false,
      stdout: output,
      stderr: output,
      runCommand: async () => {
        throw new Error('registry unavailable')
      },
    })

    expect(code).toBe(1)
    expect(await readFile(join(root, 'plugin/src/plugin.ts'), 'utf8')).toContain('definePlugin')
    expect(await readFile(join(root, 'plugin/src/generated/plugin-types.ts'), 'utf8')).toContain('ExtensionId')
    expect(output.text).toContain('工程已保留')
    expect(output.text).toContain('npm install')
  })

  it('安装后 generate 失败时提示重新执行 generate', async () => {
    const root = await temporaryRoot()
    const output = captureWriter()
    let commandCount = 0
    const code = await runCreatePlugin({
      args: ['plugin', '--plugin-id', 'exp_plugin', '--package-manager', 'npm', '--install'],
      cwd: root,
      stdinIsTTY: false,
      stdout: output,
      stderr: output,
      runCommand: async () => {
        commandCount += 1
        if (commandCount === 2) throw new Error('generator failed')
      },
    })

    expect(code).toBe(1)
    expect(commandCount).toBe(2)
    expect(output.text).toContain('npm run generate')
    expect(output.text).not.toContain('重新执行 npm install')
  })

  it('首次类型生成失败时也保留源码工程', async () => {
    const root = await temporaryRoot()
    const output = captureWriter()
    const code = await runCreatePlugin({
      args: ['plugin', '--plugin-id', 'exp_plugin', '--no-install'],
      cwd: root,
      stdinIsTTY: false,
      stdout: output,
      stderr: output,
      generateTypes: () => {
        throw new Error('generator mismatch')
      },
    })

    expect(code).toBe(1)
    expect(await readFile(join(root, 'plugin/src/plugin.ts'), 'utf8')).toContain('definePlugin')
    expect(output.text).toContain('首次类型生成失败')
    expect(output.text).toContain('工程已保留')
  })

  it('已有空目录在 staging 期间出现文件时不删除竞态文件', async () => {
    const root = await temporaryRoot()
    const target = join(root, 'plugin')
    await mkdir(target)
    const code = await runCreatePlugin({
      args: ['plugin', '--plugin-id', 'exp_plugin', '--no-install'],
      cwd: root,
      stdinIsTTY: false,
      stdout: captureWriter(),
      stderr: captureWriter(),
      generateTypes: (options) => {
        writeFileSync(join(target, 'raced.txt'), 'keep')
        return generatePluginTypes(options)
      },
    })

    expect(code).toBe(1)
    expect(await readFile(join(target, 'raced.txt'), 'utf8')).toBe('keep')
    await expect(readFile(join(target, 'src/plugin.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('非交互模式缺少必填参数时不询问', async () => {
    let asked = false
    const code = await runCreatePlugin({
      args: [],
      cwd: await temporaryRoot(),
      stdinIsTTY: false,
      stdout: captureWriter(),
      stderr: captureWriter(),
      ask: async () => {
        asked = true
        return ''
      },
    })

    expect(code).toBe(1)
    expect(asked).toBe(false)
  })

  it('交互取消映射为退出码 130', async () => {
    const abort = new Error('cancelled')
    abort.name = 'AbortError'
    const code = await runCreatePlugin({
      args: [],
      cwd: await temporaryRoot(),
      stdinIsTTY: true,
      stdout: captureWriter(),
      stderr: captureWriter(),
      ask: async () => {
        throw abort
      },
    })

    expect(code).toBe(130)
  })
})

describe('示例图标资源', () => {
  it('生成的前端示例声明真实 plugin SVG，保留现场问题图标且与模板一致', async () => {
    // 公开源码不包含私有 Workbench demo；用实际 create 产物验证相同图标契约。
    const root = await temporaryRoot()
    const code = await runCreatePlugin({
      args: ['frontend', '--template', 'frontend-basic', '--plugin-id', 'exp_icon_fixture', '--no-install'],
      cwd: root,
      stdinIsTTY: false,
      stdout: captureWriter(),
      stderr: captureWriter(),
      detectPackageManagerVersion: () => undefined,
    })
    expect(code).toBe(0)
    const exampleRoot = join(root, 'frontend')
    const iconIds = ['plugin', 'issue', 'issue-active']
    await expectDeclaredIcons(exampleRoot, iconIds)
    for (const id of iconIds) {
      expect(await readFile(join(exampleRoot, 'public/icons', `${id}.svg`), 'utf8'))
        .toBe(await readFile(join(toolchainRoot, 'template/public/icons', `${id}.svg`), 'utf8'))
    }
  })
})

async function expectDeclaredIcons (pluginRoot: string, expectedIds: readonly string[]): Promise<void> {
  const manifest = JSON.parse(await readFile(join(pluginRoot, 'fh2-plugin.json'), 'utf8')) as PluginManifest
  const icons = manifest.contributes?.icons ?? []
  expect(icons.map(icon => icon.id)).toEqual(expectedIds)
  for (const icon of icons) {
    expect(icon.src).toBe(`./icons/${icon.id}.svg`)
    const svg = await readFile(resolve(pluginRoot, 'public', icon.src), 'utf8')
    expect(svg).toContain('<svg')
    expect(svg).toContain('viewBox="0 0 24 24"')
    expect(svg).not.toMatch(/<script\b|<foreignObject\b|(?:href|src)=/i)
  }
}

async function temporaryRoot (): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'create-fh2-plugin-test-'))
  temporaryDirectories.push(path)
  return path
}

async function createPlatformRepositoryRoot (root: string): Promise<void> {
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fh2-plugin-platform' }))
  await mkdir(join(root, 'examples'))
  await mkdir(join(root, 'packages/fh2-plugin-sdk'), { recursive: true })
  await mkdir(join(root, 'packages/fh2-plugin-toolchain'), { recursive: true })
  await writeFile(join(root, 'packages/fh2-plugin-sdk/package.json'), '{}')
  await writeFile(join(root, 'packages/fh2-plugin-toolchain/package.json'), '{}')
}

function captureWriter (): { text: string; write: (chunk: string | Uint8Array) => boolean } {
  return {
    text: '',
    write (chunk) {
      this.text += String(chunk)
      return true
    },
  }
}

describe('packageManagerSpawnPlan（Windows spawn 兼容）', () => {
  it('posix：命令与参数原样、shell:false 直启', () => {
    expect(packageManagerSpawnPlan('pnpm', ['install'], 'darwin')).toEqual({ command: 'pnpm', args: ['install'], shell: false })
    expect(packageManagerSpawnPlan('npm', ['run', 'generate'], 'linux')).toEqual({ command: 'npm', args: ['run', 'generate'], shell: false })
  })

  it('win32：shell:true 经 cmd.exe 解析 .cmd shim（shell:false 会抛 EINVAL），参数经 quoteShellArg 包裹', () => {
    expect(packageManagerSpawnPlan('pnpm', ['install'], 'win32')).toEqual({ command: 'pnpm', args: ['"install"'], shell: true })
    const plan = packageManagerSpawnPlan('pnpm', ['run', 'generate'], 'win32')
    expect(plan.shell).toBe(true)
    expect(plan.args).toEqual(['"run"', '"generate"'])
  })

  it('win32：含空格/引号的参数被包裹转义', () => {
    expect(packageManagerSpawnPlan('npm', ['a b', 'c"d'], 'win32').args).toEqual(['"a b"', '"c""d"'])
  })
})
