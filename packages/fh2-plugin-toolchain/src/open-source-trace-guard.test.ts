// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repository = resolve(import.meta.dirname, '../../..')

/** 与 scripts/public-export/scope.json 的公开范围对齐：只扫描随 SOURCE 树分发的目录。 */
const SCAN_ROOTS = [
  'packages/fh2-plugin-sdk/src',
  'packages/fh2-plugin-toolchain/src',
  'packages/fh2-plugin-toolchain/scripts',
  'packages/fh2-plugin-toolchain/bin',
  'packages/fh2-plugin-toolchain/ide/src',
  'packages/fh2-plugin-toolchain/ide/scripts',
  'packages/fh2-plugin-toolchain/template',
  'packages/fh2-plugin-toolchain/template-backend',
  'packages/fh2-plugin-toolchain/template-capability',
  'packages/fh2-plugin-toolchain/template-variants',
  'packages/fh2-plugin-toolchain/developer-runtime',
  'packages/fh2-traffic-capabilities',
  'packages/fh2-plugin-dev-skill',
  // 公开树中 Skill 位于 skills/fh2-plugin-dev（主仓为 packages/fh2-plugin-dev-skill）；
  // walk 对不存在的目录静默跳过，两个条目双向兼容两种布局。
  'skills/fh2-plugin-dev',
]

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'apps', '.fh2', 'release', 'coverage', '.cache', '.git'])
const SCAN_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.mjs', '.js', '.cjs', '.vue', '.json', '.md', '.yaml', '.yml', '.html', '.css', '.svg', '.sql'])

/**
 * 命中后仍属可接受的显式白名单（substring 误报、防御性反向断言）：
 * - `--issues-plugin-id` 含子串 "es-plugin-id"（CLI 参数名）。
 * - 防泄露反向断言正则本身需要写出禁词（如 `not.toMatch(/nexus|djicorp/)`）。
 */
const ALLOWED_LINE_PATTERNS: readonly RegExp[] = [
  /--issues-plugin-id/,
  /(?:doesNotMatch|not\.toMatch|not\.includes|not\.toHaveProperty)/,
  // RFC 5737 文档保留段（192.0.2.x / 198.51.100.x / 203.0.113.x）：无主权的测试假地址，可写。
  /:\/\/(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}/,
]

const FORBIDDEN_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: '内部 Go 服务仓名 es-plugin-*', pattern: /\bes-plugin-[a-z0-9_-]+/i },
  { name: '宿主仓代号 uranus/oberon', pattern: /\b(?:uranus|oberon)\b/i },
  { name: '内部域名', pattern: /djicorp\.com|\bnexus\b.*djicorp/i },
  { name: '内部 npm 坐标 @dji/', pattern: /@dji\// },
  { name: '内部 npm scope @4f2e', pattern: /@4f2e/ },
  { name: '工程师邮箱', pattern: /[A-Za-z0-9._%+-]+@(?:dji|djicorp)\.(?:com|cn)/ },
  { name: 'AWS 凭据形态', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: '私钥块', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  // 环境坐标零写死：源码（含测试）不得在 URL/origin 上下文写死公网 IPv4。
  // 匹配限定 `://host` 上下文——环境坐标的本质是"出现在 URL 里"，SVG 曲线数字、
  // 版本号串不会以该形态出现。本地回环 127.0.0.1 属代码逻辑，豁免。
  {
    name: 'URL 内公网 IPv4 字面量',
    pattern: /:\/\/(?!(?:127|0)(?:\.|$))(?:[1-9]|[1-9]\d|1\d{2}|2[0-4]\d|25[0-5])\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})(?![\d.])/,
  },
]

function * walk (root: string): Generator<string> {
  let entries
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry)) continue
    const full = join(root, entry)
    let stats
    try {
      stats = statSync(full)
    } catch {
      continue
    }
    if (stats.isDirectory()) yield * walk(full)
    else if (SCAN_EXTENSIONS.has(extnameOf(entry))) yield full
  }
}

function extnameOf (entry: string): string {
  const dot = entry.lastIndexOf('.')
  return dot === -1 ? '' : entry.slice(dot)
}

function isAllowed (line: string): boolean {
  return ALLOWED_LINE_PATTERNS.some(allowed => allowed.test(line))
}

const HEADER_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.mjs', '.js', '.cjs', '.vue', '.sql', '.sh', '.html', '.css'])
const SPDX_RE = /SPDX-License-Identifier:\s*\S/
const COPYRIGHT_RE = /Copyright \(c\)\s*\d{4}/

describe('公开源码内部痕迹门禁', () => {
  it('公开扫描范围内不存在内部仓库名、内部域名、内部包坐标与凭据形态', () => {
    const violations: string[] = []
    let scannedFiles = 0
    for (const scanRoot of SCAN_ROOTS) {
      const absoluteRoot = join(repository, scanRoot)
      for (const file of walk(absoluteRoot)) {
        if (file.endsWith('open-source-trace-guard.test.ts')) continue
        scannedFiles += 1
        const content = readFileSync(file, 'utf8')
        for (const { name, pattern } of FORBIDDEN_PATTERNS) {
          for (const [index, line] of content.split('\n').entries()) {
            if (pattern.test(line) && !isAllowed(line)) {
              violations.push(`${relative(repository, file)}:${index + 1} [${name}] ${line.trim().slice(0, 120)}`)
            }
          }
        }
      }
    }
    expect(scannedFiles).toBeGreaterThan(1000)
    expect(violations, JSON.stringify(violations.slice(0, 20), null, 2)).toEqual([])
  })

  /**
   * 版权头覆盖率渐进门禁：注入前全树无头（基线 0）也通过；一旦任一文件带了头
   * （正式注入由 X2/D3 拍板后执行），全部 eligible 文件必须带头——半吊子状态（部分有、
   * 部分无）立即红。防止将来增量文件逃过批量注入工具。
   */
  it('版权头覆盖率要么为零要么为满：不允许部分文件带头', () => {
    let withHeader = 0
    let eligible = 0
    const missing: string[] = []
    for (const scanRoot of SCAN_ROOTS) {
      const absoluteRoot = join(repository, scanRoot)
      for (const file of walk(absoluteRoot)) {
        if (!HEADER_EXTENSIONS.has(extnameOf(basename(file)))) continue
        eligible += 1
        const content = readFileSync(file, 'utf8')
        const window = content.split('\n').slice(0, 16).join('\n')
        const has = SPDX_RE.test(window) || COPYRIGHT_RE.test(window)
        if (has) {
          withHeader += 1
        } else if (withHeader > 0) {
          missing.push(relative(repository, file))
        }
      }
    }
    if (withHeader > 0) {
      expect(withHeader, `带头文件 ${withHeader}/${eligible}，缺失 ${JSON.stringify(missing.slice(0, 10))}`).toBe(eligible)
    }
  })
})
