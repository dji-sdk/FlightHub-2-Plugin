#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const defaultPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const digestPattern = /^sha256:[a-f0-9]{64}$/
const require = createRequire(import.meta.url)

export const MOCK_HOST_APPS = Object.freeze([
  { resource: 'shell', directory: 'mock-host-workbench-shell', entry: 'index.html' },
  { resource: 'vue2', directory: 'mock-host-vue2', entry: 'container.html' },
  { resource: 'vue3', directory: 'mock-host-vue3', entry: 'container.html' },
])

export function canonicalJson (value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function sha256 (content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

export function assetError (code, message, path) {
  return Object.assign(new Error(message), { code, path, exitCode: 1 })
}

export function readAssetJson (path) {
  assertRegularFile(path)
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'))
  } catch {
    throw assetError('FH2_ASSET_JSON', '资源元数据不是有效 JSON。', basename(path))
  }
}

export function assertDirectory (path) {
  const stat = fs.lstatSync(path, { throwIfNoEntry: false })
  if (!stat?.isDirectory() || fs.realpathSync(path) !== resolve(path)) {
    throw assetError('FH2_ASSET_DIRECTORY', '资源目录缺失或包含符号链接。', basename(path))
  }
}

function assertRegularFile (path) {
  const stat = fs.lstatSync(path, { throwIfNoEntry: false })
  if (!stat?.isFile() || fs.realpathSync(path) !== resolve(path)) {
    throw assetError('FH2_ASSET_FILE', '资源文件缺失或包含符号链接。', basename(path))
  }
}

function assertKeys (value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw assetError('FH2_ASSET_FORMAT', `${label} 字段不符合资源格式。`, 'manifest.json')
  }
}

function assertRelativePath (path) {
  if (typeof path !== 'string' || /[\\:]/.test(path) || [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw assetError('FH2_ASSET_PATH', '资源清单必须使用安全的 POSIX 相对路径。', 'manifest.json')
  }
}

export function listAssetFiles (directory, { ignore = () => false } = {}) {
  assertDirectory(directory)
  const files = []
  const names = new Set()
  const visit = (current, excluded = false) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const absolute = join(current, entry.name)
      const path = relative(directory, absolute).split(sep).join('/')
      assertRelativePath(path)
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw assetError('FH2_ASSET_SPECIAL_FILE', '资源不允许符号链接或特殊文件。', path)
      }
      const ignored = excluded || ignore(path, entry)
      if (!ignored) {
        const folded = path.toLowerCase()
        if (names.has(folded)) throw assetError('FH2_ASSET_CASE_CONFLICT', '资源存在大小写路径冲突。', path)
        names.add(folded)
      }
      if (entry.isDirectory()) visit(absolute, ignored)
      else if (!ignored) files.push(path)
    }
  }
  visit(directory)
  return files.sort()
}

export function verifyFileManifest ({ directory, kind, digestField, expectedDigest }) {
  assertDirectory(directory)
  const manifest = readAssetJson(join(directory, 'manifest.json'))
  if (manifest?.kind !== kind || manifest.formatVersion !== 1 || !Array.isArray(manifest.files)) {
    throw assetError('FH2_ASSET_FORMAT', '资源清单 kind、formatVersion 或 files 无效。', 'manifest.json')
  }
  const { [digestField]: digest, ...content } = manifest
  if (!digestPattern.test(digest ?? '') || sha256(canonicalJson(content)) !== digest
    || (expectedDigest !== undefined && expectedDigest !== digest)) {
    throw assetError('FH2_ASSET_DIGEST', '资源清单摘要与内容或指定摘要不匹配。', 'manifest.json')
  }
  let previous = ''
  for (const file of manifest.files) {
    assertKeys(file, ['path', 'sha256', 'bytes'], 'files 条目')
    assertRelativePath(file.path)
    if (file.path === 'manifest.json' || file.path <= previous || !digestPattern.test(file.sha256 ?? '')
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw assetError('FH2_ASSET_FILE_LIST', '资源清单必须有序、唯一，且包含有效 hash/bytes。', 'manifest.json')
    }
    previous = file.path
  }
  const files = listAssetFiles(directory).filter(path => path !== 'manifest.json')
  if (JSON.stringify(files) !== JSON.stringify(manifest.files.map(file => file.path))) {
    throw assetError('FH2_ASSET_FILE_LIST', '资源实际文件集合与清单不完全一致。', 'manifest.json')
  }
  for (const file of manifest.files) {
    const content = fs.readFileSync(join(directory, file.path))
    if (content.byteLength !== file.bytes || sha256(content) !== file.sha256) {
      throw assetError('FH2_ASSET_FILE_DIGEST', '资源文件 hash/bytes 与清单不一致。', file.path)
    }
  }
  return manifest
}

export function stripSourceMappingURL (source, extension) {
  if (!source.includes('sourceMappingURL')) return source
  if (extension === '.html') {
    return source.replace(/<!--[\s\S]*?-->|(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi, (match, open, tag, content, close) => {
      if (open !== undefined) return `${open}${stripSourceMappingURL(content, tag.toLowerCase() === 'script' ? '.js' : '.css')}${close}`
      return /^<!--\s*[#@]\s*sourceMappingURL\s*=/.test(match) ? '' : match
    })
  }
  const ranges = new Map()
  const record = (start, end) => {
    if (/^(?:\/\/|\/\*)\s*[#@]\s*sourceMappingURL\s*=/.test(source.slice(start, end))) ranges.set(start, end)
  }
  if (extension === '.css') {
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] === '"' || source[index] === '\'') {
        const quote = source[index++]
        for (; index < source.length && source[index] !== quote; index += 1) {
          if (source[index] === '\\') index += 1
        }
      } else if (source.slice(index, index + 4).toLowerCase() === 'url(' && !/^\s*["']/.test(source.slice(index + 4))) {
        // Unquoted URLs are CSS tokens too; comment-like bytes inside them are payload.
        for (index += 4; index < source.length && source[index] !== ')'; index += 1) {
          if (source[index] === '\\') index += 1
        }
      } else if (source.startsWith('/*', index)) {
        const close = source.indexOf('*/', index + 2)
        const end = close === -1 ? source.length : close + 2
        record(index, end)
        index = end - 1
      }
    }
  } else {
    // Parse comment locations, not string contents (including embedded runner JS).
    const ts = require('typescript')
    const file = ts.createSourceFile('asset.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const pending = [file]
    while (pending.length > 0) {
      const node = pending.pop()
      for (const range of [...(ts.getLeadingCommentRanges(source, node.pos) ?? []), ...(ts.getTrailingCommentRanges(source, node.end) ?? [])]) {
        record(range.pos, range.end)
      }
      for (const child of node.getChildren(file)) pending.push(child)
    }
  }
  for (const [start, end] of [...ranges].sort((a, b) => b[0] - a[0])) {
    const newlines = source.slice(start, end).replace(/[^\r\n\u2028\u2029]/g, '')
    const whitespace = newlines || (source.startsWith('/*', start) ? ' ' : '')
    source = source.slice(0, start) + whitespace + source.slice(end)
  }
  return source
}

export function verifyMockHostAssets ({ packageRoot = defaultPackageRoot, assetRoot, sdkRoot, expectedResourceDigest } = {}) {
  packageRoot = fs.realpathSync(packageRoot)
  assetRoot ??= join(packageRoot, 'runtime-assets/mock-host')
  sdkRoot ??= resolve(packageRoot, '../fh2-plugin-sdk')
  assertDirectory(sdkRoot)
  const manifest = verifyFileManifest({
    directory: assetRoot,
    kind: 'fh2-mock-host-assets',
    digestField: 'resourceDigest',
    expectedDigest: expectedResourceDigest,
  })
  assertKeys(manifest, ['kind', 'formatVersion', 'inputSourceDigest', 'versions', 'runtimeContract', 'files', 'resourceDigest'], 'Mock Host 清单')
  assertKeys(manifest.versions, ['sdk', 'engine', 'toolchain'], 'versions')
  assertKeys(manifest.runtimeContract, ['schemaVersion', 'manifestVersion', 'platformVersion', 'platformRange'], 'runtimeContract')
  if (!digestPattern.test(manifest.inputSourceDigest ?? '')
    || Object.values(manifest.versions).some(version => typeof version !== 'string' || version.trim() === '')
    || manifest.runtimeContract.schemaVersion !== 1 || !Number.isSafeInteger(manifest.runtimeContract.manifestVersion)
    || manifest.runtimeContract.manifestVersion < 1 || typeof manifest.runtimeContract.platformVersion !== 'string'
    || typeof manifest.runtimeContract.platformRange !== 'string') {
    throw assetError('FH2_ASSET_FORMAT', 'Mock Host 来源版本或运行协议格式无效。', 'manifest.json')
  }
  const semver = require('semver')
  if (Object.values(manifest.versions).some(version => semver.valid(version) === null)
    || semver.valid(manifest.runtimeContract.platformVersion) === null
    || semver.validRange(manifest.runtimeContract.platformRange) === null
    || !semver.satisfies(manifest.runtimeContract.platformVersion, manifest.runtimeContract.platformRange, { includePrerelease: true })) {
    throw assetError('FH2_ASSET_FORMAT', 'Mock Host 制品版本或运行协议不是有效的 SemVer 契约。', 'manifest.json')
  }
  const sdk = readAssetJson(join(sdkRoot, 'package.json'))
  const toolchain = readAssetJson(join(packageRoot, 'package.json'))
  if (manifest.versions.sdk !== sdk.version || manifest.versions.toolchain !== toolchain.version
    || manifest.versions.engine !== manifest.versions.sdk || sdk.version !== toolchain.version) {
    throw assetError('FH2_ASSET_VERSION', 'Mock Host 资源与当前 SDK/Toolchain 制品版本不匹配；需要重新准备资源。', 'manifest.json')
  }
  if (canonicalJson(manifest.runtimeContract) !== canonicalJson(readAssetJson(join(sdkRoot, 'runtime-contract.json')))) {
    throw assetError('FH2_ASSET_RUNTIME_CONTRACT', 'Mock Host 资源与当前 SDK 运行协议不匹配；不能只改资源版本。', 'manifest.json')
  }
  for (const app of MOCK_HOST_APPS) {
    if (!manifest.files.some(file => file.path === `${app.resource}/dist/${app.entry}`)) {
      throw assetError('FH2_ASSET_ENTRY', 'Mock Host 缺少必需的 HTML 构建入口。', `${app.resource}/dist/${app.entry}`)
    }
  }
  for (const file of manifest.files) {
    if (!MOCK_HOST_APPS.some(app => file.path.startsWith(`${app.resource}/dist/`)) && !['LICENSE', 'NOTICE'].includes(file.path)) {
      throw assetError('FH2_ASSET_LAYOUT', 'Mock Host 文件不在批准的运行资源布局中。', file.path)
    }
    if (/(?:^|\/)(?:node_modules|\.git|\.cache)(?:\/|$)|\.(?:map|[cm]?tsx?|vue)$/i.test(file.path)) {
      throw assetError('FH2_ASSET_SOURCE', 'Mock Host 不允许源码、source map 或嵌套依赖目录。', file.path)
    }
    const extension = /\.[^.\/]+$/.exec(file.path)?.[0].toLowerCase()
    if (['.js', '.mjs', '.cjs', '.css', '.html'].includes(extension)) {
      const source = fs.readFileSync(join(assetRoot, file.path), 'utf8')
      if (stripSourceMappingURL(source, extension) !== source) {
        throw assetError('FH2_ASSET_SOURCE_MAP', 'Mock Host 资源仍包含 sourceMappingURL 注释。', file.path)
      }
    }
  }
  return manifest
}

export function replaceAssetDirectory (target, assemble) {
  assertDirectory(dirname(target))
  const staging = fs.mkdtempSync(join(dirname(target), `.${basename(target)}-next-`))
  const backup = join(dirname(target), `.${basename(target)}-old-${randomUUID()}`)
  let stagingOwned = true
  let targetMoved = false
  let committed = false
  try {
    assemble(staging)
    if (fs.lstatSync(backup, { throwIfNoEntry: false })) throw assetError('FH2_ASSET_CONFLICT', '资源备份路径已被占用。')
    if (fs.lstatSync(target, { throwIfNoEntry: false })) {
      assertDirectory(target)
      fs.renameSync(target, backup)
      targetMoved = true
    }
    fs.renameSync(staging, target)
    stagingOwned = false
    committed = true
  } catch (error) {
    if (targetMoved && !fs.lstatSync(target, { throwIfNoEntry: false })) {
      try {
        fs.renameSync(backup, target)
        targetMoved = false
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `资源提交和回滚均失败；旧副本保留在 ${backup}`)
      }
    }
    throw error
  } finally {
    if (stagingOwned) fs.rmSync(staging, { recursive: true, force: true })
    if (committed && targetMoved) fs.rmSync(backup, { recursive: true, force: true })
  }
}

export function copyWorkbench ({ packageRoot = defaultPackageRoot, expectedResourceDigest } = {}) {
  packageRoot = fs.realpathSync(packageRoot)
  const assetRoot = join(packageRoot, 'runtime-assets/mock-host')
  const manifest = verifyMockHostAssets({ packageRoot, expectedResourceDigest })
  const ideRoot = join(packageRoot, 'apps/fh2-web-ide/dist')
  assertDirectory(ideRoot)
  assertRegularFile(join(ideRoot, 'index.html'))
  const ideFiles = listAssetFiles(ideRoot)
  replaceAssetDirectory(join(packageRoot, 'apps'), (staging) => {
    // IDE was just built inside apps/: preserve it before replacing the whole tree.
    for (const path of ideFiles) {
      const content = fs.readFileSync(join(ideRoot, path))
      const target = join(staging, 'fh2-web-ide/dist', path)
      fs.mkdirSync(dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
      if (sha256(fs.readFileSync(target)) !== sha256(content)) throw assetError('FH2_ASSET_COPY', 'Web IDE 复制校验失败。', path)
    }
    for (const file of manifest.files) {
      const app = MOCK_HOST_APPS.find(app => file.path.startsWith(`${app.resource}/dist/`))
      const path = app ? `${app.directory}/${file.path.slice(app.resource.length + 1)}` : file.path
      const target = join(staging, path)
      const content = fs.readFileSync(join(assetRoot, file.path))
      if (content.byteLength !== file.bytes || sha256(content) !== file.sha256) {
        throw assetError('FH2_ASSET_FILE_DIGEST', '装配时资源输入已变化。', file.path)
      }
      fs.mkdirSync(dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
      if (sha256(fs.readFileSync(target)) !== file.sha256) throw assetError('FH2_ASSET_COPY', 'Mock Host 复制校验失败。', file.path)
    }
    fs.writeFileSync(join(staging, 'runtime-contract.json'), `${JSON.stringify({
      schemaVersion: manifest.runtimeContract.schemaVersion,
      sdkVersion: manifest.versions.sdk,
      engineVersion: manifest.versions.engine,
      toolchainVersion: manifest.versions.toolchain,
      manifestVersion: manifest.runtimeContract.manifestVersion,
      platformVersion: manifest.runtimeContract.platformVersion,
      platformRange: manifest.runtimeContract.platformRange,
    }, null, 2)}\n`)
  })
  return manifest
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    copyWorkbench()
    process.stdout.write('Workbench 和 Web IDE 已从包内资源原子装配到 apps/。\n')
  } catch (error) {
    process.stderr.write(`[${error.code ?? 'FH2_ASSET_COPY'}] ${error.message}\n请检查包内 runtime-assets/mock-host，并重新执行 pnpm build:tooling。\n`)
    process.exitCode = 1
  }
}
