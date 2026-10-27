// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatClientConfigGuide } from './guide.js'
import { parseMcpArgs, resolveRootArg } from './main.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempDir (): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fh2-mcp-root-'))
  temporaryRoots.push(dir)
  return dir
}

describe('mcp 参数严格解析（parseMcpArgs）', () => {
  it('空参数 = 开放模式（无 rootArg）', () => {
    expect(parseMcpArgs([])).toEqual({ kind: 'run' })
  })

  it.each([
    ['分离形式', ['--root', 'project'], 'project'],
    ['等号形式', ['--root=project'], 'project'],
    ['等号绝对路径', ['--root=/workspace/project'], '/workspace/project'],
  ])('%s解析出 rootArg（收纳模式）', (_name, args, expected) => {
    expect(parseMcpArgs(args)).toEqual({ kind: 'run', rootArg: expected })
  })

  it('help 优先：任何位置出现 --help/-h 都返回用法请求', () => {
    expect(parseMcpArgs(['--help'])).toEqual({ kind: 'help' })
    expect(parseMcpArgs(['-h'])).toEqual({ kind: 'help' })
    expect(parseMcpArgs(['--root', 'x', '--help'])).toEqual({ kind: 'help' })
  })

  it.each([
    ['未知旗标', ['--foo']],
    ['未知旗标（等号）', ['--foo=bar']],
    ['位置参数', ['project']],
    ['重复 --root（分离）', ['--root', 'a', '--root', 'b']],
    ['重复 --root（混合）', ['--root=a', '--root', 'b']],
    ['缺值', ['--root']],
    ['值是旗标', ['--root', '--help']],
    ['等号空值', ['--root=']],
  ])('%s返回错误', (_name, args) => {
    const result = parseMcpArgs(args)
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.message).not.toBe('')
  })
})

describe('mcp --root 解析（收纳模式 canonicalize）', () => {
  it('未传 --root 属调用错误（开放模式不经此函数）', () => {
    const result = resolveRootArg([], '/workspace')
    expect(result.ok).toBe(false)
  })

  it('相对路径按 cwd 解析并 canonicalize', async () => {
    const cwd = await tempDir()
    const project = join(cwd, 'project')
    await mkdir(project)
    expect(resolveRootArg(['--root', 'project'], cwd)).toEqual({ ok: true, root: realpathSync(project) })
    expect(resolveRootArg(['--root', '.'], cwd)).toEqual({ ok: true, root: realpathSync(cwd) })
  })

  it('symlink root 解析为真实路径（工具随后可用）', async () => {
    const real = await tempDir()
    const linkParent = await tempDir()
    const link = join(linkParent, 'link')
    await symlink(real, link, 'dir')
    const resolved = resolveRootArg(['--root', link], '/elsewhere')
    expect(resolved).toEqual({ ok: true, root: realpathSync(real) })
  })

  it('目录不存在时快速失败', () => {
    const result = resolveRootArg(['--root', 'missing'], '/workspace')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('/workspace/missing')
  })

  it('指向文件而非目录时快速失败', async () => {
    const cwd = await tempDir()
    await writeFile(join(cwd, 'fh2-plugin.json'), '{}')
    const result = resolveRootArg(['--root', 'fh2-plugin.json'], cwd)
    expect(result.ok).toBe(false)
  })
})

describe('客户端配置指南（formatClientConfigGuide，双形态）', () => {
  const devInput = { form: 'dev' as const, nodePath: '/usr/local/bin/node', binPath: '/opt/bin/fh2-plugin.mjs' }
  const installedInput = { form: 'installed' as const, nodePath: '/usr/local/bin/node', binPath: '/npm-global/bin/fh2-plugin' }

  it('dev 形态：主推绝对 node + bin，JSON 可解析', () => {
    const guide = formatClientConfigGuide(devInput)
    const opencodeBlock = extractJsonBlock(guide, 0)
    const parsed = JSON.parse(opencodeBlock) as { mcp: { fh2: { command: string[] } } }
    expect(parsed.mcp.fh2.command).toEqual(['/usr/local/bin/node', '/opt/bin/fh2-plugin.mjs', 'mcp'])

    const claudeBlock = extractJsonBlock(guide, opencodeBlock.length)
    const claude = JSON.parse(claudeBlock) as { mcpServers: { fh2: { command: string; args: string[] } } }
    expect(claude.mcpServers.fh2.command).toBe('/usr/local/bin/node')
    expect(claude.mcpServers.fh2.args).toEqual(['/opt/bin/fh2-plugin.mjs', 'mcp'])
    expect(guide).toContain('claude mcp add fh2 -- /usr/local/bin/node /opt/bin/fh2-plugin.mjs mcp')
  })

  it('installed 形态：主推简洁命令名 ["fh2-plugin","mcp"]，不出现深绝对路径', () => {
    const guide = formatClientConfigGuide(installedInput)
    const opencodeBlock = extractJsonBlock(guide, 0)
    const parsed = JSON.parse(opencodeBlock) as { mcp: { fh2: { command: string[] } } }
    expect(parsed.mcp.fh2.command).toEqual(['fh2-plugin', 'mcp'])

    const claudeBlock = extractJsonBlock(guide, opencodeBlock.length)
    const claude = JSON.parse(claudeBlock) as { mcpServers: { fh2: { command: string; args: string[] } } }
    expect(claude.mcpServers.fh2.command).toBe('fh2-plugin')
    expect(claude.mcpServers.fh2.args).toEqual(['mcp'])
    expect(guide).toContain('claude mcp add fh2 -- fh2-plugin mcp')
    // 主推 JSON 块不出现深绝对 bin（realpath 路径只在备选段）。
    expect(claudeBlock).not.toContain('/npm-global/')
  })

  it('两形态备选段恒定保留绝对路径兜底（GUI 客户端 PATH 场景）', () => {
    for (const input of [devInput, installedInput]) {
      const guide = formatClientConfigGuide(input)
      expect(guide).toContain('备选')
      expect(guide).toContain(JSON.stringify([input.nodePath, input.binPath, 'mcp']))
    }
  })

  it.each([
    ['/workspace/source fixture/bin/node', '/workspace/source fixture/bin/fh2-plugin.mjs'],
    ['C:\\workspace\\source fixture\\node.exe', 'C:\\workspace\\source fixture\\fh2-plugin.mjs'],
  ])('dev 形态路径含空格时 JSON 正确转义：%s', (nodePath, binPath) => {
    const guide = formatClientConfigGuide({ form: 'dev', nodePath, binPath })
    const opencodeBlock = extractJsonBlock(guide, 0)
    const parsed = JSON.parse(opencodeBlock) as { mcp: { fh2: { command: string[] } } }
    expect(parsed.mcp.fh2.command).toEqual([nodePath, binPath, 'mcp'])
  })

  it('两形态都提及开放模式与 --root 收纳选项', () => {
    for (const input of [devInput, installedInput]) {
      const guide = formatClientConfigGuide(input)
      expect(guide).toContain('开放模式')
      expect(guide).toContain('--root')
    }
  })
})

/** 从指南文本自偏移处切出下一个完整 JSON 对象块。 */
function extractJsonBlock (text: string, from: number): string {
  const start = text.indexOf('{', from)
  if (start === -1) throw new Error('指南缺少 JSON 块')
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') {
      depth++
    } else if (text[i] === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  throw new Error('JSON 块未闭合')
}
