// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLI_COMMANDS } from '../cli-commands.js'
import { CLI_DEFINITIONS, cliDefault, cliDefinition, renderCliOptions } from '../cli-definitions.js'
import type { CliDefinition } from '../cli-definitions.js'
import { parseCommandArguments } from '../commands/arguments.js'
import { BUILD_HELP } from '../commands/build-command.js'
import { DEV_HELP } from '../commands/dev-command.js'
import { KNOWLEDGE_HELP } from '../commands/knowledge-command.js'
import { GENERATE_HELP } from '../commands/generate-command.js'
import { PACK_HELP } from '../commands/pack-command.js'
import { PREVIEW_CLI_METADATA, PREVIEW_HELP } from '../commands/preview-command.js'
import { SERVE_HELP } from '../commands/serve-command.js'
import { SIGN_HELP } from '../commands/sign-command.js'
import { TYPES_HELP } from '../commands/types-command.js'
import { VALIDATE_HELP } from '../commands/validate-command.js'
import { CREATE_USAGE } from '../create/run.js'
import { MCP_USAGE } from '../mcp/main.js'
import { CONTEXT_DISCOVERY_CONTRACT } from './context.js'
import { CLI_CONTRACT, projectCliCommand, renderCliUsage, serializeCliContract } from './cli.js'
import type { CliContract } from './cli.js'
import { CLI_USAGE } from './usage.js'

/** Help renders the production options; operational introductions remain manual. */
const HELP_BY_COMMAND: Readonly<Record<string, string>> = {
  create: CREATE_USAGE,
  validate: VALIDATE_HELP,
  generate: GENERATE_HELP,
  types: TYPES_HELP,
  build: BUILD_HELP,
  pack: PACK_HELP,
  sign: SIGN_HELP,
  dev: DEV_HELP,
  preview: PREVIEW_HELP,
  serve: SERVE_HELP,
  knowledge: KNOWLEDGE_HELP,
  mcp: MCP_USAGE,
}

const roots: string[] = []

afterEach(() => {
  vi.doUnmock('../cli-definitions.js')
  vi.doUnmock('../build/policy.js')
  vi.resetModules()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('cli production parameter projection', () => {
  it('命令名与摘要与 CLI_COMMANDS 完全一致', () => {
    expect(CLI_CONTRACT.commands.map(command => ({ name: command.name, summary: command.summary })))
      .toEqual(CLI_COMMANDS.map(command => ({ name: command.name, summary: command.summary })))
  })

  it('validate 帮助和投影说明显式 manifest 只选择前端校验', () => {
    const validate = CLI_CONTRACT.commands.find(command => command.name === 'validate')!
    expect(validate.summary).toContain('--manifest 仅用于前端')
    expect(VALIDATE_HELP).toContain('后端插件使用 --root <后端目录>')
    expect(VALIDATE_HELP).toContain('不要传 --manifest 或 --config')
    expect(validate.notes?.join('\n')).toContain('仅使用前端清单校验')
  })

  it('每个 option（含别名）出现在对应命令的帮助文本中', () => {
    for (const command of CLI_CONTRACT.commands) {
      const help = HELP_BY_COMMAND[command.name]
      expect(help, `缺少 ${command.name} 的帮助文本`).toBeDefined()
      expect(help).toContain(renderCliOptions(cliDefinition(command.name)))
      for (const option of command.options) {
        expect(help, `${command.name} ${option.name} 未出现在帮助文本`).toContain(option.name)
        if (option.alias !== undefined) {
          expect(help, `${command.name} ${option.alias} 未出现在帮助文本`).toContain(option.alias)
        }
      }
    }
  })

  it('execution metadata and usage are explicitly manual, not machine dispatch rules', () => {
    for (const command of CLI_CONTRACT.commands) {
      const codes = command.exitCodes.map(entry => entry.code)
      expect(codes.every(code => [0, 1, 2, 3, 130].includes(code)), `${command.name} 出现未定义退出码`).toBe(true)
      expect(command.behaviorKind).toBe('manual-description')
      for (const entry of command.exitCodes) {
        expect(entry.meaning.trim().length, `${command.name} 退出码 ${entry.code} 缺少含义`).toBeGreaterThan(0)
      }
      for (const usage of command.usage ?? []) expect(usage.kind).toBe('manual-guide')
    }
  })

  it('preview guide is exported as manual prose independently of the production parameter inventory', () => {
    const exported = JSON.parse(serializeCliContract()) as CliContract
    const preview = exported.commands.find(command => command.name === 'preview')!
    expect(preview.usage).toEqual(CLI_USAGE.preview!.map(guide => ({ ...guide, kind: 'manual-guide' })))
    expect(preview.behaviorKind).toBe('manual-description')
    expect(preview.parameterSource).toBe('src/cli-definitions.ts#CLI_DEFINITIONS')
    const withoutParameters = projectCliCommand({ ...cliDefinition('preview'), options: [] }, PREVIEW_CLI_METADATA)
    expect(withoutParameters.options).toEqual([])
    expect(withoutParameters.usage).toEqual(preview.usage)

    const guide = preview.usage![0]!
    expect(guide.summary).toContain('仅支持 HTTP 目标')
    expect(guide.preconditions.join('\n')).toMatch(/HTTPS.*已放弃.*--local-protocol.*撤项/)
    expect(guide.steps.join('\n')).toMatch(/先登录.*项目[\s\S]*fh2-plugin-debug=1[\s\S]*不携带.*source.*session[\s\S]*手动填写.*资源根 URL[\s\S]*不是.*Entry.*Manifest[\s\S]*校验.*权限.*同意.*重载/)
    expect(guide.limits.join('\n')).toMatch(/就绪.*本地.*不代表.*加载/)
    expect(guide.sources).toContain('packages/fh2-plugin-toolchain/src/tooling-contract/usage.ts#CLI_USAGE')
  })

  it('contexts cover discovery metadata; newer workspace validate/generate are reported by execution', () => {
    for (const context of CONTEXT_DISCOVERY_CONTRACT.contexts) {
      const commandsWithContext = CLI_CONTRACT.commands
        .filter(command => command.contexts.includes(context.id))
        .map(command => command.name)
        .sort()
      // Execution metadata may describe commands newer than this manual discovery list.
      expect(commandsWithContext).toEqual(expect.arrayContaining([...context.supportedCommands]))
    }
    // create/serve/mcp 不依赖已识别的插件工程上下文。
    for (const name of ['create', 'serve', 'mcp']) {
      expect(CLI_CONTRACT.commands.find(command => command.name === name)?.contexts).toEqual([])
    }
  })

  it('all exported options are accepted by the production parser with the same aliases/ranges/defaults', () => {
    for (const definition of CLI_DEFINITIONS) {
      const descriptor = CLI_CONTRACT.commands.find(command => command.name === definition.name)!
      expect(descriptor.syntax).toEqual(definition.syntax)
      expect(descriptor.parameterSource).toContain('cli-definitions.ts')
      for (const option of descriptor.options) {
        const prefix = definition.name === 'knowledge' ? ['status'] : []
        const sample = option.values?.[0] ?? (option.numericRange ? String(option.numericRange.min) : 'fixture')
        const input = option.valueType === 'boolean' ? [] : [sample!]
        const parsed = parseCommandArguments([...prefix, option.name, ...input], definition)
        if (option.valueType === 'boolean') expect(parsed.switches.has(option.name.slice(2))).toBe(true)
        else expect(parsed.values[option.name.slice(2)]).toBe(sample)
        if (option.alias) {
          expect(parseCommandArguments([...prefix, option.alias, ...input], definition).switches)
            .toEqual(parsed.switches)
        }
        for (const [alias, canonical] of Object.entries(option.valueAliases ?? {})) {
          expect(parseCommandArguments([...prefix, option.name, alias], definition).values[option.name.slice(2)]).toBe(canonical)
        }
        const rule = option.defaultRule
        if (rule?.kind === 'literal') expect(parseCommandArguments(prefix, definition).value(option.name.slice(2))).toBe(String(rule.value))
        if (rule?.kind === 'mode') {
          for (const [mode, value] of Object.entries(rule.values)) expect(cliDefault(definition, option.name.slice(2), { mode })).toBe(value)
        }
      }
    }
  })

  it('changing one definition changes real serve parsing, rendered help and contract export together', async () => {
    const changed: CliDefinition = {
      ...cliDefinition('serve'),
      options: cliDefinition('serve').options.map(option => option.name === '--port'
        ? { ...option, alias: '-p', defaultRule: { kind: 'literal', value: 2345 }, numericRange: { min: 2000, max: 3000, integer: true } }
        : option.name === '--no-open'
          ? { ...option, defaultRule: { kind: 'literal', value: true } }
          : option),
    }
    await replaceDefinition(changed)
    const { parseServeArguments, runServeCommand } = await import('../commands/serve-command.js')
    const { CLI_CONTRACT: exported } = await import('./cli.js')
    expect(parseServeArguments([], '/project').port).toBe(2345)
    expect(parseServeArguments([], '/project').noOpen).toBe(true)
    expect(parseServeArguments(['-p', '2500'], '/project').port).toBe(2500)
    expect(() => parseServeArguments(['--port', '1999'], '/project')).toThrow()
    expect(() => parseServeArguments(['--port', '3001'], '/project')).toThrow()
    const io = capturedIo()
    expect(await runServeCommand({
      args: ['--help'],
      cwd: '/missing-project',
      ...io,
      signals: { on: vi.fn(), off: vi.fn() },
      serve: vi.fn(() => {
        throw new Error('help must not start server')
      }),
    })).toBe(0)
    expect(io.stdout.text).toContain('--port, -p <2000..3000>')
    expect(io.stdout.text).toContain('默认 2345')
    expect(exported.commands.find(command => command.name === 'serve')!.options.find(option => option.name === '--port'))
      .toMatchObject({ alias: '-p', default: '2345', defaultRule: { kind: 'literal', value: 2345 }, numericRange: { min: 2000, max: 3000, integer: true } })
    const serve = vi.fn(async () => {
      throw new Error('stop after capturing server input')
    })
    expect(await runServeCommand({ args: [], cwd: '/project', ...capturedIo(), signals: { on: vi.fn(), off: vi.fn() }, resolveWebRoot: () => '/web', serve })).toBe(1)
    expect(serve).toHaveBeenCalledWith({ root: '/project', webRoot: '/web', port: 2345 })
  })

  it('changing enum values/aliases in one definition changes the real create parser and export', async () => {
    const changed: CliDefinition = {
      ...cliDefinition('create'),
      options: cliDefinition('create').options.map(option => option.name === '--template'
        ? { ...option, values: ['frontend-basic'], valueAliases: { quick: 'frontend-basic' } }
        : option),
    }
    await replaceDefinition(changed)
    const { parseCreateArgs, CREATE_USAGE } = await import('../create/run.js')
    const { CLI_CONTRACT: exported } = await import('./cli.js')
    expect(parseCreateArgs(['project', '--template', 'quick']).template).toBe('frontend-basic')
    expect(() => parseCreateArgs(['project', '--template', 'capability-fullstack'])).toThrow()
    expect(() => parseCreateArgs(['project', '--template', '0'])).toThrow()
    expect(CREATE_USAGE).toContain('--template <frontend-basic>')
    expect(CREATE_USAGE).toContain('quick=frontend-basic')
    expect(exported.commands.find(command => command.name === 'create')!.options[0])
      .toMatchObject({ values: ['frontend-basic'], valueAliases: { quick: 'frontend-basic' } })
  })

  it('changing the output default affects ordinary generate with no explicit manifest/out and Capability fan-out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fh2-generate-default-'))
    roots.push(root)
    const capability = join(root, 'capability')
    const projects = [root, ...['exp_first', 'exp_second'].map(id => join(capability, 'frontend', id))]
    const toolchainRoot = resolve(import.meta.dirname, '../..')
    const require = createRequire(join(toolchainRoot, 'package.json'))
    const sdkRoot = dirname(require.resolve('fh2-plugin-sdk/package.json'))
    const sdkVersion = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8')).version as string
    const toolchainVersion = JSON.parse(readFileSync(join(toolchainRoot, 'package.json'), 'utf8')).version as string
    for (const [index, project] of projects.entries()) {
      mkdirSync(join(project, 'node_modules'), { recursive: true })
      symlinkSync(sdkRoot, join(project, 'node_modules/fh2-plugin-sdk'), 'dir')
      symlinkSync(toolchainRoot, join(project, 'node_modules/fh2-plugin-toolchain'), 'dir')
      writeFileSync(join(project, 'package.json'), JSON.stringify({ name: ['exp_standalone', 'exp_first', 'exp_second'][index], type: 'module', dependencies: { 'fh2-plugin-sdk': sdkVersion }, devDependencies: { 'fh2-plugin-toolchain': toolchainVersion } }))
      writeFileSync(join(project, 'fh2-plugin.json'), JSON.stringify({ id: ['exp_standalone', 'exp_first', 'exp_second'][index], name: 'fixture', version: '1.0.0', entry: './plugin.js', extensions: [] }))
      const projectRequire = createRequire(join(project, 'package.json'))
      expect(projectRequire.resolve('fh2-plugin-sdk/package.json')).toBe(join(sdkRoot, 'package.json'))
      expect(projectRequire.resolve('fh2-plugin-toolchain/package.json')).toBe(join(toolchainRoot, 'package.json'))
    }
    writeFileSync(join(capability, 'capabilities.json'), JSON.stringify({ name: 'fixture', description: 'fixture' }))
    await replaceDefinition({
      ...cliDefinition('generate'),
      options: cliDefinition('generate').options.map(option => option.name === '--out'
        ? { ...option, defaultRule: { kind: 'literal', value: './source-types' } }
        : option),
    })
    const { runGenerateCommand, GENERATE_HELP } = await import('../commands/generate-command.js')
    const { CLI_CONTRACT: exported } = await import('./cli.js')
    for (const cwd of [root, capability]) {
      const io = capturedIo()
      expect(runGenerateCommand({ args: ['--check'], cwd, ...io }), io.stderr.text).toBe(1)
      expect(io.stderr.text).toContain('FH2_GENERATE_OUTDATED')
      expect(io.stderr.text).not.toContain('FH2_SDK_VERSION_MISMATCH')
    }
    for (const project of projects) {
      expect(existsSync(join(project, 'source-types/plugin-types.ts'))).toBe(false)
      expect(existsSync(join(project, 'src/generated/plugin-types.ts'))).toBe(false)
    }
    for (const cwd of [root, capability]) {
      const io = capturedIo()
      expect(runGenerateCommand({ args: [], cwd, ...io }), io.stderr.text).toBe(0)
      expect(runGenerateCommand({ args: ['--check'], cwd, ...capturedIo() })).toBe(0)
    }
    for (const project of projects) {
      expect(readFileSync(join(project, 'source-types/plugin-types.ts'), 'utf8')).toContain('export')
      expect(existsSync(join(project, 'src/generated/plugin-types.ts'))).toBe(false)
    }
    expect(GENERATE_HELP).toContain('默认 ./source-types')
    expect(exported.commands.find(command => command.name === 'generate')!.options.find(option => option.name === '--out')?.default).toBe('./source-types')
  })

  it.each(['task', 'compatibility'] as const)('the shared Capability config gate runs before %s dispatch', async (route) => {
    const root = mkdtempSync(join(tmpdir(), 'fh2-build-gate-'))
    roots.push(root)
    const frontendRoot = join(root, 'frontend/exp_front')
    mkdirSync(frontendRoot, { recursive: true })
    writeFileSync(join(root, 'capabilities.json'), JSON.stringify({ name: 'fixture', description: 'fixture' }))
    writeFileSync(join(frontendRoot, 'fh2-plugin.json'), JSON.stringify({ id: 'exp_front' }))
    const buildProject = vi.fn(async () => ({ root, kind: 'capability-project' as const, ok: true, diagnostics: [], members: [], outputs: [], artifacts: [], typechecked: true }))
    const buildCapability = vi.fn(async () => ({ ok: true, diagnostics: [] }))
    const io = capturedIo()
    const options = {
      args: ['--config', 'custom.ts', '--frontend', 'exp_front'],
      cwd: root,
      ...io,
      signals: { on: vi.fn(), off: vi.fn() },
      ...(route === 'task' ? { buildProject } : { buildCapability }),
    }
    const { runBuildCommand: baseline } = await import('../commands/build-command.js')
    expect(await baseline(options), io.stderr.text).toBe(0)
    expect(route === 'task' ? buildProject : buildCapability).toHaveBeenCalledOnce()
    buildProject.mockClear()
    buildCapability.mockClear()
    vi.resetModules()
    vi.doMock('../build/policy.js', async (importOriginal) => {
      const original = await importOriginal<typeof import('../build/policy.js')>()
      return { ...original, BUILD_CONTEXT_OPTIONS: { ...original.BUILD_CONTEXT_OPTIONS, 'capability-project': { ...original.BUILD_CONTEXT_OPTIONS['capability-project'], supportsConfig: false } } }
    })
    const { runBuildCommand } = await import('../commands/build-command.js')
    expect(await runBuildCommand(options)).toBe(2)
    expect(io.stderr.text).toContain('Capability 根使用 --config')
    expect(buildProject).not.toHaveBeenCalled()
    expect(buildCapability).not.toHaveBeenCalled()
  })

  it('usage 渲染与历史 CLI_COMMANDS 渲染字节一致，且序列化确定、对象冻结', () => {
    const expected = `FH2 插件工具链\n\n${
      CLI_COMMANDS.map(c => `  fh2-plugin ${c.name.padEnd(10)} ${c.summary}`).join('\n')}\n`
    expect(renderCliUsage()).toBe(expected)
    expect(renderCliUsage()).toBe(renderCliUsage())
    expect(serializeCliContract()).toBe(serializeCliContract())
    expect(Object.isFrozen(CLI_CONTRACT)).toBe(true)
    expect(Object.isFrozen(CLI_CONTRACT.commands)).toBe(true)
  })
})

async function replaceDefinition (definition: CliDefinition): Promise<void> {
  vi.resetModules()
  vi.doMock('../cli-definitions.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../cli-definitions.js')>()
    return {
      ...original,
      CLI_DEFINITIONS: original.CLI_DEFINITIONS.map(command => command.name === definition.name ? definition : command),
      cliDefinition: (name: string) => name === definition.name ? definition : original.cliDefinition(name),
    }
  })
}

function capturedIo (): { stdout: { text: string; write: (chunk: string) => void }; stderr: { text: string; write: (chunk: string) => void } } {
  const writer = () => ({
    text: '',
    write (chunk: string) {
      this.text += chunk
    },
  })
  return { stdout: writer(), stderr: writer() }
}
