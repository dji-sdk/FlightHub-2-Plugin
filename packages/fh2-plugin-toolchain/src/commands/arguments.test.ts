// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { cliDefinition } from '../cli-definitions.js'
import { parseCommandArguments } from './arguments.js'
import { runKnowledgeCommand } from './knowledge-command.js'

describe('production CLI syntax', () => {
  it('preserves knowledge legacy syntax, last root wins, repeated switches and help-anywhere', () => {
    const definition = cliDefinition('knowledge')
    expect(parseCommandArguments(['status', '--root', 'first', '--root', 'last', '--force', '--force', '--json', '--json'], definition))
      .toMatchObject({ values: { root: 'last' }, positional: ['status'] })
    expect(() => parseCommandArguments(['status', '--root=directory'], definition)).toThrow('未知参数')
    expect(parseCommandArguments(['--root', '--help'], definition).flag('help')).toBe(true)
    expect(parseCommandArguments(['status', '--root', ''], definition).values.root).toBe('')
    expect(parseCommandArguments(['use', '-legacy-id'], definition).positional).toEqual(['use', '-legacy-id'])
  })

  it('knowledge -h is a real execution help path; omitted/unknown subcommands are still errors', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const options = { cwd: '/missing', stdout: { write: (text: string) => stdout.push(text) }, stderr: { write: (text: string) => stderr.push(text) } }
    expect(await runKnowledgeCommand({ ...options, args: ['bad', '-h'] })).toBe(0)
    expect(stdout.join('')).toContain('--help, -h')
    expect(stderr).toEqual([])
    expect(await runKnowledgeCommand({ ...options, args: [] })).toBe(2)
    expect(await runKnowledgeCommand({ ...options, args: ['unknown'] })).toBe(2)
  })

  it('knowledge rejects a bare separator instead of using it as a knowledge ID', async () => {
    const stderr: string[] = []
    expect(() => parseCommandArguments(['use', '--'], cliDefinition('knowledge'))).toThrow('未知参数：--')
    expect(await runKnowledgeCommand({ args: ['use', '--'], cwd: '/missing', stdout: { write: () => {} }, stderr: { write: text => stderr.push(text) } })).toBe(2)
    expect(stderr.join('')).toContain('未知参数：--')
    expect(await runKnowledgeCommand({ args: ['use', '--', '-h'], cwd: '/missing', stdout: { write: () => {} }, stderr: { write: () => {} } })).toBe(0)
  })

  it('preserves create end-options, enum shortcuts and input validation before help', () => {
    const definition = cliDefinition('create')
    expect(parseCommandArguments(['--', '-h'], definition).positional).toEqual(['-h'])
    expect(parseCommandArguments(['--help', '-h'], definition).flag('help')).toBe(true)
    expect(parseCommandArguments(['--template', '2'], definition).values.template).toBe('backend-basic')
    expect(() => parseCommandArguments(['--help', '--template', '3'], definition)).toThrow('未知插件模板')
    expect(() => parseCommandArguments(['--name=--bad'], definition)).toThrow('缺少值')
  })

  it('preserves MCP help ordering and strict root/positionals', () => {
    const definition = cliDefinition('mcp')
    expect(parseCommandArguments(['-h', '--bad'], definition).flag('help')).toBe(true)
    expect(() => parseCommandArguments(['--bad', '-h'], definition)).toThrow()
    expect(() => parseCommandArguments(['--root', '--help'], definition)).toThrow('缺少值')
    expect(() => parseCommandArguments(['--'], definition)).toThrow()
    expect(parseCommandArguments(['--root=--path'], definition).values.root).toBe('--path')
  })

  it('ports enforce explicit ranges while omitted serve uses its 0 default', () => {
    const serve = cliDefinition('serve')
    expect(parseCommandArguments([], serve).value('port')).toBe('0')
    expect(() => parseCommandArguments(['--port=0'], serve)).toThrow()
    for (const name of ['serve', 'dev', 'preview']) {
      const definition = cliDefinition(name)
      expect(parseCommandArguments(['--port=1'], definition).value('port')).toBe('1')
      expect(parseCommandArguments(['--port=65535'], definition).value('port')).toBe('65535')
      for (const value of ['0', '65536', '1.5', '-1', 'abc']) expect(() => parseCommandArguments(['--port', value], definition)).toThrow()
    }
    expect(() => parseCommandArguments(['--port=443'], cliDefinition('preview'))).toThrow()
  })

  it('repeatable filter values retain the old rejection of inline flag-looking values', () => {
    for (const [command, flag] of [['build', '--frontend'], ['build', '--backend'], ['dev', '--frontend'], ['dev', '--backend'], ['preview', '--frontend']] as const) {
      expect(() => parseCommandArguments([`${flag}=--help`], cliDefinition(command))).toThrow('缺少值')
      expect(parseCommandArguments([flag, 'a', `${flag}=b`], cliDefinition(command)).multiple[flag.slice(2)]).toEqual(['a', 'b'])
    }
    expect(parseCommandArguments(['--manifest=--path'], cliDefinition('dev')).values.manifest).toBe('--path')
    for (const command of ['build', 'dev', 'preview']) {
      expect(() => parseCommandArguments(['--root', '-w'], cliDefinition(command))).toThrow('缺少值')
      expect(parseCommandArguments(['--root=-w'], cliDefinition(command)).values.root).toBe('-w')
    }
    expect(parseCommandArguments(['--root', '-h'], cliDefinition('mcp')).values.root).toBe('-h')
  })
})
