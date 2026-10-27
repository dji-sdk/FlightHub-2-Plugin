// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 知识包安装：把 worker 产出的知识包放进 Toolchain 受控缓存，并逐文件校验完整性。
 *
 * ★★ 安装的全部意义是**让后面所有消费都不必再怀疑内容**：装进来之后
 * catalog / schema / types 都按身份读，不再每次校验。所以校验必须在这里做足：
 *   ① knowledge.json 能解析、格式与协议版本本 Toolchain 支持
 *   ② files[] 里每一份都存在、字节数与 SHA-256 都对
 *   ③ 目录里没有 files[] 之外的多余文件（多出来的那份不受摘要保护）
 *   ④ 路径不逃逸、不是 symlink、不重复
 *
 * ⚠️ 摘要验证的是【完整性】，不是【来源可信】(方案 §3.2.2)。本地导入由用户在 CLI
 * 显式发起；服务端**绝不**接受网页提交的任意路径去安装，那条路不存在。
 */

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import {
  SUPPORTED_KNOWLEDGE_FORMAT_VERSION,
  SUPPORTED_TOOLCHAIN_PROTOCOL_VERSION,
} from '../contracts/knowledge.js'
import type { InstalledKnowledge, KnowledgeManifest } from '../contracts/knowledge.js'

/** 安装失败的原因是给人看的：每一条都要说清「哪份文件、哪里不对」。 */
export class KnowledgeInstallError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'KnowledgeInstallError'
  }
}

/** 单份载荷上限 8 MiB：知识包里最大的是 host-api.json（几十 KB），留足余量仍能拦住异常包。 */
const MAX_ENTRY_BYTES = 8 * 1024 * 1024
/** 整包上限 64 MiB。 */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
/** 文件数上限：当前 89 份，留足余量。 */
const MAX_ENTRIES = 2000

/**
 * 受控缓存根。
 *
 * 放在用户级缓存而不是工程内：同一台机器上多个插件工程共用同一份知识包，
 * 装进工程会让每个工程各存一份几百 KB 的同样内容，且极易被误提交进 Git。
 */
export function knowledgeCacheRoot (): string {
  const override = process.env.FH2_KNOWLEDGE_CACHE
  if (override !== undefined && override !== '') return resolve(override)
  return join(homedir(), '.cache', 'fh2-plugin-toolchain', 'knowledge')
}

/** `sha256(knowledge.json 原始字节)` —— 与 worker 的 bundleDigest 同值（见契约注释）。 */
export function computeBundleDigest (manifestBytes: Buffer | Uint8Array): string {
  return createHash('sha256').update(manifestBytes).digest('hex')
}

function sha256File (file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * 解析并校验 knowledge.json 本身。
 * ⚠️ 只做形状与版本判断，不碰载荷文件 —— 载荷校验见 verifyPayload。
 */
export function parseManifest (bytes: Buffer): { manifest: KnowledgeManifest; bundleDigest: string } {
  let raw: unknown
  try {
    raw = JSON.parse(bytes.toString('utf8')) as unknown
  } catch (error) {
    throw new KnowledgeInstallError(`knowledge.json 不是合法 JSON：${(error as Error).message}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new KnowledgeInstallError('knowledge.json 顶层不是对象')
  }
  const record = raw as Record<string, unknown>

  const formatVersion = record.formatVersion
  if (formatVersion !== SUPPORTED_KNOWLEDGE_FORMAT_VERSION) {
    throw new KnowledgeInstallError(
      `知识包格式版本 ${String(formatVersion)} 不受支持（本 Toolchain 只认 ${SUPPORTED_KNOWLEDGE_FORMAT_VERSION}）。`
      + '拒绝安装而不是尽力解析：猜着读一份未来格式的包，错的地方会以「某个字段恰好是空的」出现。',
    )
  }
  const protocolVersion = record.toolchainProtocolVersion
  if (protocolVersion !== SUPPORTED_TOOLCHAIN_PROTOCOL_VERSION) {
    throw new KnowledgeInstallError(
      `知识包声明 toolchainProtocolVersion=${String(protocolVersion)}，本 Toolchain 只支持 ${SUPPORTED_TOOLCHAIN_PROTOCOL_VERSION}`,
    )
  }
  for (const key of ['knowledgeId', 'workerRevision', 'contractsVersion', 'gojaVersion'] as const) {
    if (typeof record[key] !== 'string' || record[key] === '') {
      throw new KnowledgeInstallError(`knowledge.json 缺少 ${key}`)
    }
  }
  if (!Array.isArray(record.files) || record.files.length === 0) {
    throw new KnowledgeInstallError('knowledge.json 的 files[] 为空：一份没有载荷清单的知识包无法校验完整性')
  }
  // checkers 必须在场（可以是空数组）。缺字段与空数组是两件事：
  // 前者说明这份包的生产者根本没表达过 checker 这件事，后者是显式的「没有」。
  if (!Array.isArray(record.checkers)) {
    throw new KnowledgeInstallError('knowledge.json 缺少 checkers 字段（空数组是合法的「没有」，缺字段不是）')
  }
  return { manifest: record as unknown as KnowledgeManifest, bundleDigest: computeBundleDigest(bytes) }
}

/** 一条路径能否安全地落进缓存目录。 */
function assertSafeRelativePath (path: string): void {
  if (path === '' || path.includes('\0')) throw new KnowledgeInstallError(`载荷路径非法：${JSON.stringify(path)}`)
  if (path.includes('\\')) throw new KnowledgeInstallError(`载荷路径必须用 / 分隔：${path}`)
  if (isAbsolute(path) || path.startsWith('/')) throw new KnowledgeInstallError(`载荷路径不允许绝对路径：${path}`)
  const segments = path.split('/')
  if (segments.some(segment => segment === '..' || segment === '.' || segment === '')) {
    throw new KnowledgeInstallError(`载荷路径含 . / .. 或空段：${path}`)
  }
  if (path === 'knowledge.json') {
    // files[] 刻意不含 knowledge.json 自身（避免循环哈希）。它出现在清单里说明生产侧口径变了。
    throw new KnowledgeInstallError('files[] 不该包含 knowledge.json 自身')
  }
}

/** 列出目录下所有普通文件的相对路径（POSIX 分隔），顺带拒掉 symlink。 */
async function listFiles (root: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isSymbolicLink()) {
      throw new KnowledgeInstallError(`知识包里有 symlink：${rel}。它可能指向包外的任意文件，一律拒绝。`)
    }
    if (entry.isDirectory()) {
      out.push(...await listFiles(root, rel))
      continue
    }
    if (!entry.isFile()) throw new KnowledgeInstallError(`知识包里有非普通文件：${rel}`)
    out.push(rel)
  }
  return out
}

/**
 * 校验一个知识包目录：逐文件对摘要，并确认目录内容与 files[] **恰好一致**。
 *
 * ★ 「恰好一致」这一条不能省。只查 files[] 里的那些，等于允许包里躺着一份
 * 不受摘要保护的多余文件 —— 而 docs/ 与 skill/references/ 都是按目录读的，
 * 多出来的那份会被当成知识内容读进去。
 */
export async function verifyPayload (directory: string, manifest: KnowledgeManifest): Promise<void> {
  const expected = new Map<string, { sha256: string; bytes: number }>()
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || typeof entry.sha256 !== 'string' || typeof entry.bytes !== 'number') {
      throw new KnowledgeInstallError('files[] 里有条目缺 path / sha256 / bytes')
    }
    assertSafeRelativePath(entry.path)
    if (expected.has(entry.path)) throw new KnowledgeInstallError(`files[] 里 ${entry.path} 重复`)
    if (entry.bytes > MAX_ENTRY_BYTES) {
      throw new KnowledgeInstallError(`${entry.path} 声明 ${entry.bytes} 字节，超过单文件上限 ${MAX_ENTRY_BYTES}`)
    }
    expected.set(entry.path, { sha256: entry.sha256, bytes: entry.bytes })
  }
  if (expected.size > MAX_ENTRIES) {
    throw new KnowledgeInstallError(`载荷文件 ${expected.size} 份，超过上限 ${MAX_ENTRIES}`)
  }
  const total = manifest.files.reduce((sum, entry) => sum + entry.bytes, 0)
  if (total > MAX_TOTAL_BYTES) {
    throw new KnowledgeInstallError(`载荷合计 ${total} 字节，超过整包上限 ${MAX_TOTAL_BYTES}`)
  }

  const actual = await listFiles(directory)
  const actualSet = new Set(actual)
  if (!actualSet.has('knowledge.json')) throw new KnowledgeInstallError('目录里没有 knowledge.json')

  const problems: string[] = []
  for (const [path, want] of expected) {
    if (!actualSet.has(path)) {
      problems.push(`清单里有 ${path} 但目录里没有`)
      continue
    }
    const file = join(directory, path)
    const info = lstatSync(file)
    if (info.size !== want.bytes) {
      problems.push(`${path} 实际 ${info.size} 字节，清单说 ${want.bytes}`)
      continue
    }
    const digest = sha256File(file)
    if (digest !== want.sha256) problems.push(`${path} 摘要不符（内容被改过？）`)
  }
  for (const path of actual) {
    if (path === 'knowledge.json') continue
    if (!expected.has(path)) problems.push(`目录里有 ${path} 但清单里没有它 —— 它不受摘要保护，拒绝安装`)
  }
  if (problems.length > 0) {
    throw new KnowledgeInstallError(`知识包完整性校验失败（${problems.length} 条）：\n  ${problems.join('\n  ')}`)
  }
}

/** 一份知识包在缓存里的目录名。用 knowledgeId 而不是摘要：人要能看懂缓存目录。 */
function cacheDirFor (knowledgeId: string): string {
  if (!/^[\w.-]+$/.test(knowledgeId)) {
    throw new KnowledgeInstallError(`knowledgeId 含不安全字符，拒绝当目录名：${knowledgeId}`)
  }
  return join(knowledgeCacheRoot(), knowledgeId)
}

export interface ImportOptions {
  /**
   * 知识包来源：解包后的目录，或 `.tar.gz` 归档。
   *
   * ⓘ 支持目录是**刻意的**：worker 侧的确定性归档入口（计划 A5）尚未落地，
   * 而 `build --out` 产出的就是目录。只支持 tar 会让整条消费链在 A5 之前无法试用。
   * 两种来源走同一套校验，目录来源不因此享受任何豁免。
   */
  readonly source: string;
  /** 已存在同 knowledgeId 的安装时是否覆盖。默认不覆盖（同 ID 不可变）。 */
  readonly force?: boolean;
}

/** 把知识包装进受控缓存。回安装结果；任何校验失败都不留下半截目录。 */
export async function importKnowledge (options: ImportOptions): Promise<InstalledKnowledge> {
  const source = resolve(options.source)
  if (!existsSync(source)) throw new KnowledgeInstallError(`来源不存在：${source}`)

  const info = await stat(source)
  /**
   * 归档来源：先解到临时目录，再走与目录来源**完全相同**的那条校验。
   *
   * ★ 刻意不给归档单开一条快路：两条校验路径迟早会漂，而漂掉的那一侧
   *   正是「从网上下回来的包」—— 风险最高的那一条。
   */
  let extracted: string | undefined
  let directory = source
  if (!info.isDirectory()) {
    extracted = await extractArchive(source)
    directory = extracted
  }

  try {
    return await installFromDirectory(directory, options.force === true)
  } finally {
    if (extracted !== undefined) await rm(extracted, { recursive: true, force: true })
  }
}

/**
 * 解开 `backend-plugin-knowledge-<id>.tar.gz`。
 *
 * ⚠️⚠️ 解包是**信任边界**：包可能来自任何地方。三件事必须在写盘**之前**判：
 *   ① 路径逃逸（`../`、绝对路径）—— 否则一个条目就能写到目标目录之外
 *   ② 非普通文件（symlink / 硬链接 / 设备）—— symlink 能把后续写入导到包外
 *   ③ 大小上限（单条 + 总量）—— 否则一个 gzip 炸弹就能占满磁盘
 * 只靠解包后的摘要校验是**不够的**：那时文件已经写出去了。
 */
async function extractArchive (archivePath: string): Promise<string> {
  const target = await mkdtemp(join(tmpdir(), 'fh2-knowledge-'))
  try {
    const entries = await readTarGz(archivePath)
    // 顶层目录名由包决定（<knowledgeId>/…）；去掉它，让解出来的形状与目录来源一致。
    const prefix = commonTopLevel(entries.map(entry => entry.name))
    if (prefix === null) {
      throw new KnowledgeInstallError('归档里的条目不在同一个顶层目录下，不像一个知识包')
    }
    for (const entry of entries) {
      const relative = entry.name.slice(prefix.length + 1)
      if (relative === '') continue
      assertSafeRelativePath(relative === 'knowledge.json' ? 'knowledge.json.ok' : relative)
      const absolute = join(target, relative)
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, entry.bytes)
    }
    return target
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    throw error
  }
}

/** 取所有条目共同的顶层目录；不一致或没有则回 null。 */
function commonTopLevel (names: readonly string[]): string | null {
  if (names.length === 0) return null
  const first = names[0]!.split('/')[0]
  if (first === undefined || first === '') return null
  return names.every(name => name.split('/')[0] === first) ? first : null
}

async function installFromDirectory (source: string, force: boolean): Promise<InstalledKnowledge> {
  const manifestFile = join(source, 'knowledge.json')
  if (!existsSync(manifestFile)) {
    throw new KnowledgeInstallError(`${source} 里没有 knowledge.json，它不像一个知识包目录`)
  }
  const { manifest, bundleDigest } = parseManifest(readFileSync(manifestFile))
  // 先在来源处校验：装进缓存再校验的话，失败时缓存里会留下一份坏包。
  await verifyPayload(source, manifest)

  const target = cacheDirFor(manifest.knowledgeId)
  if (existsSync(target)) {
    const existing = parseManifest(readFileSync(join(target, 'knowledge.json')))
    if (existing.bundleDigest === bundleDigest) {
      // 同 ID 同内容：幂等成功，不报错也不重复拷贝。
      return { knowledgeId: manifest.knowledgeId, bundleDigest, directory: target, manifest }
    }
    if (!force) {
      throw new KnowledgeInstallError(
        `缓存里已有 ${manifest.knowledgeId}，但内容不同（已装 ${existing.bundleDigest.slice(0, 12)}，本次 ${bundleDigest.slice(0, 12)}）。\n`
        + '  同一个 knowledgeId 本该对应同一份内容。两份不同的内容用同一个 ID，说明其中至少一份出自脏工作区。\n'
        + '  确认要替换请加 --force。',
      )
    }
    await rm(target, { recursive: true, force: true })
  }

  await mkdir(join(target, '..'), { recursive: true })
  await cp(source, target, { recursive: true, dereference: false, verbatimSymlinks: false })
  try {
    // 拷完再校验一遍：拷贝本身也可能出错（磁盘满、被并发改动）。
    await verifyPayload(target, manifest)
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    throw error
  }
  return { knowledgeId: manifest.knowledgeId, bundleDigest, directory: target, manifest }
}

/** 列出缓存里所有已安装的知识包（坏掉的那些跳过，不让一份坏包挡住整个列表）。 */
export async function listInstalled (): Promise<InstalledKnowledge[]> {
  const root = knowledgeCacheRoot()
  if (!existsSync(root)) return []
  const out: InstalledKnowledge[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = join(root, entry.name)
    const manifestFile = join(directory, 'knowledge.json')
    if (!existsSync(manifestFile)) continue
    try {
      const { manifest, bundleDigest } = parseManifest(readFileSync(manifestFile))
      out.push({ knowledgeId: manifest.knowledgeId, bundleDigest, directory, manifest })
    } catch {
      // 缓存里的坏包不算致命：status 会把它显示成「未安装」，用户重新 import 即可。
    }
  }
  out.sort((left, right) => left.knowledgeId.localeCompare(right.knowledgeId))
  return out
}

/** 按 knowledgeId 取一份已安装的知识包。 */
export async function findInstalled (knowledgeId: string): Promise<InstalledKnowledge | undefined> {
  return (await listInstalled()).find(item => item.knowledgeId === knowledgeId)
}

/** 缓存目录是否把某个路径包住（给测试与诊断用）。 */
export function isInsideCache (path: string): boolean {
  const root = resolve(knowledgeCacheRoot())
  const target = resolve(path)
  return target === root || target.startsWith(`${root}${sep}`) || !relative(root, target).startsWith('..')
}

/** 一条 tar 条目。 */
interface TarEntry {
  readonly name: string;
  readonly bytes: Buffer;
}

/** tar 块大小（USTAR/PAX 固定 512 字节）。 */
const TAR_BLOCK = 512

/**
 * 读一个 .tar.gz，回全部**普通文件**条目。
 *
 * ★ 自己解而不是引一个 tar 库：本仓不想为一次解包新增运行时依赖，
 *   而这里只需要读 USTAR/PAX 的普通文件 —— 那是一段可审的定长格式。
 *
 * ⚠️⚠️ 遇到 symlink / 硬链接 / 设备 / 目录以外的任何类型一律**报错而不是跳过**：
 * 跳过的话，一个恶意包会安静地少几份文件，然后在摘要校验时报「缺文件」——
 * 那句话会把排查引向「包坏了」，而真相是「包里有攻击载荷」。
 */
async function readTarGz (archivePath: string): Promise<readonly TarEntry[]> {
  const chunks: Buffer[] = []
  let total = 0
  const gunzip = createGunzip()
  gunzip.on('data', (chunk: Buffer) => {
    total += chunk.byteLength
    // gzip 炸弹：解压后体积在写盘**之前**就要拦住。
    if (total > MAX_TOTAL_BYTES) {
      gunzip.destroy(new KnowledgeInstallError(`归档解压后超过 ${MAX_TOTAL_BYTES} 字节上限`))
      return
    }
    chunks.push(chunk)
  })
  try {
    await pipeline(createReadStream(archivePath), gunzip)
  } catch (error) {
    if (error instanceof KnowledgeInstallError) throw error
    throw new KnowledgeInstallError(`归档解压失败：${(error as Error).message}`)
  }

  const buffer = Buffer.concat(chunks)
  const entries: TarEntry[] = []
  let offset = 0
  /** PAX 扩展头给出的长路径；只对**紧随其后**的那一条生效。 */
  let pendingLongName: string | undefined

  while (offset + TAR_BLOCK <= buffer.byteLength) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK)
    // 连续两个空块 = 归档结束。
    if (header.every(byte => byte === 0)) break
    offset += TAR_BLOCK

    const name = pendingLongName ?? readTarString(header, 0, 100)
    const size = readTarOctal(header, 124, 12)
    const typeFlag = String.fromCharCode(header[156] ?? 0)
    const dataBlocks = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
    const data = buffer.subarray(offset, offset + size)
    offset += dataBlocks
    pendingLongName = undefined

    // PAX 扩展头：本身不是文件，它描述下一条。
    if (typeFlag === 'x' || typeFlag === 'X') {
      pendingLongName = readPaxPath(data)
      continue
    }
    // 全局扩展头：忽略（它不描述具体条目）。
    if (typeFlag === 'g') continue
    // 目录：不需要显式建，写文件时按需建。
    if (typeFlag === '5') continue
    if (typeFlag !== '0' && typeFlag !== '\0' && typeFlag !== '') {
      throw new KnowledgeInstallError(
        `归档里有非普通文件条目（类型 ${JSON.stringify(typeFlag)}，路径 ${name}）。`
        + 'symlink / 硬链接 / 设备一律拒绝：它们能把后续写入导到目标目录之外。',
      )
    }
    if (size > MAX_ENTRY_BYTES) {
      throw new KnowledgeInstallError(`归档条目 ${name} 有 ${size} 字节，超过单文件上限 ${MAX_ENTRY_BYTES}`)
    }
    entries.push({ name, bytes: Buffer.from(data) })
  }
  if (entries.length === 0) throw new KnowledgeInstallError('归档里没有任何文件')
  return entries
}

function readTarString (header: Buffer, start: number, length: number): string {
  const raw = header.subarray(start, start + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8')
}

function readTarOctal (header: Buffer, start: number, length: number): number {
  const text = readTarString(header, start, length).trim()
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  if (!Number.isFinite(value) || value < 0) {
    throw new KnowledgeInstallError(`归档头里的数字字段无法解析：${JSON.stringify(text)}`)
  }
  return value
}

/** 从 PAX 扩展头里取 `path=` 记录（长路径走这条）。 */
function readPaxPath (data: Buffer): string | undefined {
  for (const line of data.toString('utf8').split('\n')) {
    // 形如 `<长度> path=<值>`
    const match = /^\d+ path=(.*)$/.exec(line)
    if (match !== null) return match[1]
  }
  return undefined
}
