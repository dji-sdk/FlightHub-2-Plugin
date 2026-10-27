// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import type { FileSnapshot } from '../../contracts/index.js'
import { IdeRequestError } from '../../contracts/ide.js'
import type {
  IdeFileData,
  IdeFsCopyData,
  IdeFsCreateData,
  IdeFsDeleteData,
  IdeFsRenameData,
  IdeTreeChildrenData,
  IdeTreeData,
  IdeTreeNode,
  IdeWriteData,
} from '../../contracts/ide.js'
import { WorkspaceGitIgnore } from './gitignore.js'

/** 契约 2.3：读文件上限 2 MiB。 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024
/** 契约 2.4：写文件同样受上限约束，避免浏览器把巨型 buffer 灌进磁盘。 */
export const MAX_WRITE_BYTES = MAX_FILE_BYTES
/** 契约 2.2：深度上限 12、节点总数上限 5000。 */
export const MAX_TREE_DEPTH = 12
export const MAX_TREE_NODES = 5000

const IGNORED_NAMES: ReadonlySet<string> = new Set(['.git', '.DS_Store'])
/** 生成目录：整树里只出名字（generated 标记 + 空 children），展开时惰性拉取。 */
const GENERATED_NAMES: ReadonlySet<string> = new Set(['node_modules', 'dist'])

/** 仅隐藏Git内部目录、系统垃圾与IDE临时文件；点开头配置目录可见。 */
export function isIgnoredTreeEntry (name: string, isDirectory: boolean): boolean {
  void isDirectory
  return IGNORED_NAMES.has(name) || name.endsWith('.fh2-ide-tmp')
}

/** 生成目录（node_modules / dist）：树里可见但置灰、不递归（预算保护）。 */
export function isGeneratedTreeEntry (name: string, isDirectory: boolean): boolean {
  return isDirectory && GENERATED_NAMES.has(name)
}

export interface ResolvedWorkspacePath {
  /** 相对工作根的 POSIX 路径，回包时原样返回给前端。 */
  readonly relativePath: string;
  readonly absolutePath: string;
}

/**
 * 把请求里的相对路径收敛到工作根内。
 *
 * 比 dev/static-server.ts 的 `serveFrom` 更严：那里越界只是「找不到资源」，
 * 这里必须显式区分 `FH2_IDE_BAD_REQUEST`（参数本身不合法）与
 * `FH2_IDE_PATH_ESCAPE`（形式合法但逃出工作根），且对尚不存在的写入目标
 * 也要用最近的真实祖先做 realpath 复核，堵住 symlink 逃逸。
 *
 * `field` 只影响报错文案：契约 6.3 的入参叫 `from`/`to`，报「缺少 path」会误导前端。
 */
export function resolveWorkspacePath (root: string, rawPath: unknown, field = 'path'): ResolvedWorkspacePath {
  if (typeof rawPath !== 'string' || rawPath === '') {
    throw new IdeRequestError('FH2_IDE_BAD_REQUEST', `缺少 ${field} 参数。Missing "${field}" parameter.`)
  }
  // NUL 会让底层 syscall 截断路径，先于任何 normalize 拒掉。
  if (rawPath.includes('\0')) {
    throw new IdeRequestError('FH2_IDE_BAD_REQUEST', `${field} 含非法字符。The "${field}" parameter contains an illegal character.`)
  }
  // 契约要求 POSIX 相对路径：反斜杠在 POSIX 上是合法文件名字符，放过去会让
  // Windows 与 POSIX 的判定结果不一致，直接拒绝。
  if (rawPath.includes('\\')) {
    throw new IdeRequestError(
      'FH2_IDE_BAD_REQUEST',
      `${field} 必须使用 / 分隔的 POSIX 相对路径。The "${field}" parameter must be a POSIX relative path separated by "/".`,
    )
  }
  if (isAbsolute(rawPath) || rawPath.startsWith('/')) {
    throw new IdeRequestError('FH2_IDE_PATH_ESCAPE', `${field} 不允许绝对路径。Absolute paths are not allowed for "${field}".`)
  }

  const normalizedRoot = resolve(root)
  const normalizedRelative = normalize(rawPath)
  if (isAbsolute(normalizedRelative) || isEscaping(normalizedRelative)) {
    throw new IdeRequestError('FH2_IDE_PATH_ESCAPE', `${field} 逃逸出工作根。Path "${field}" escapes the workspace root.`)
  }
  const absolutePath = resolve(normalizedRoot, normalizedRelative)
  if (!isContained(normalizedRoot, absolutePath)) {
    throw new IdeRequestError('FH2_IDE_PATH_ESCAPE', `${field} 逃逸出工作根。Path "${field}" escapes the workspace root.`)
  }

  // symlink 复核：工作根与目标都取真实路径再比一次。目标可能尚不存在（新建文件），
  // 此时退回到最近的已存在祖先。
  let realRoot: string
  try {
    realRoot = realpathSync(normalizedRoot)
  } catch {
    throw new IdeRequestError('FH2_IDE_INTERNAL', '工作根不可访问。Workspace root is not accessible.')
  }
  const anchor = nearestExistingAncestor(absolutePath)
  if (anchor === undefined) {
    throw new IdeRequestError('FH2_IDE_PATH_ESCAPE', `${field} 逃逸出工作根。Path "${field}" escapes the workspace root.`)
  }
  let realAnchor: string
  try {
    realAnchor = realpathSync(anchor)
  } catch {
    throw new IdeRequestError('FH2_IDE_PATH_ESCAPE', `${field} 逃逸出工作根。Path "${field}" escapes the workspace root.`)
  }
  const suffix = relative(anchor, absolutePath)
  const realTarget = suffix === '' ? realAnchor : resolve(realAnchor, suffix)
  if (!isContained(realRoot, realTarget)) {
    throw new IdeRequestError('FH2_IDE_PATH_ESCAPE', `${field} 逃逸出工作根。Path "${field}" escapes the workspace root.`)
  }

  return {
    relativePath: toPosix(normalizedRelative),
    absolutePath,
  }
}

export interface ReadWorkspaceTreeOptions {
  readonly root: string;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
}

/** 契约 2.2：整棵已过滤文件树；超出深度/节点上限时截断并置 `truncated`。 */
export async function readWorkspaceTree (options: ReadWorkspaceTreeOptions): Promise<IdeTreeData> {
  const root = resolve(options.root)
  const maxDepth = options.maxDepth ?? MAX_TREE_DEPTH
  const maxNodes = options.maxNodes ?? MAX_TREE_NODES
  const budget = { remaining: maxNodes, truncated: false }
  const rules = new WorkspaceGitIgnore(root)
  const tree = await readDirectory(root, '', 1, maxDepth, budget, rules)
  return { truncated: budget.truncated, tree, ...(rules.warnings.length ? { warnings: rules.warnings } : {}) }
}

/**
 * 惰性单层子树（GET /api/tree/children）：供前端展开生成目录（node_modules/dist）
 * 或任意目录。所有子目录均标记childrenLoaded:false，生成属性按完整路径继承；不设节点预算
 * （单层条目量 = 目录本身大小，可控）。
 */
export async function readTreeChildren (root: string, rawPath: unknown): Promise<IdeTreeChildrenData> {
  const target = resolveWorkspacePath(root, rawPath)
  const stats = await lstat(target.absolutePath).catch(() => undefined)
  if (stats === undefined || !stats.isDirectory()) {
    throw new IdeRequestError(
      'FH2_IDE_NOT_FOUND',
      `目录不存在：${target.relativePath}。Directory not found: ${target.relativePath}.`,
    )
  }
  const budget = { remaining: Number.MAX_SAFE_INTEGER, truncated: false }
  // child path 需要相对工作根（前端按 path 拼进整树），故传 target.relativePath 作前缀
  const rules = new WorkspaceGitIgnore(resolve(root))
  const children = await readDirectory(target.absolutePath, target.relativePath === '.' ? '' : target.relativePath, 1, 1, budget, rules, true)
  return { path: target.relativePath, children, ...(rules.warnings.length ? { warnings: rules.warnings } : {}) }
}

async function readDirectory (
  absoluteDirectory: string,
  relativeDirectory: string,
  depth: number,
  maxDepth: number,
  budget: { remaining: number; truncated: boolean },
  rules: WorkspaceGitIgnore,
  singleLayer = false,
): Promise<readonly IdeTreeNode[]> {
  let entries
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true })
  } catch (error) {
    if (singleLayer) throw new IdeRequestError('FH2_IDE_INTERNAL', `读取目录 ${relativeDirectory} 失败：${errorMessage(error)}`)
    rules.warnings.push(`读取目录 ${relativeDirectory} 失败：${errorMessage(error)}`)
    return []
  }
  const directories: IdeTreeNode[] = []
  const files: IdeTreeNode[] = []
  const visible = entries
    // 生成目录（node_modules/dist）不忽略：置灰可见（generated 标记），见主循环
    .filter(entry => !isIgnoredTreeEntry(entry.name, entry.isDirectory()))
    // symlink 不跟随：既避免环，也避免把工作根外的内容暴露进文件树。
    .filter(entry => entry.isDirectory() || entry.isFile())
    .sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of visible) {
    if (budget.remaining <= 0) {
      budget.truncated = true
      break
    }
    budget.remaining -= 1
    const childRelative = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`
    const childAbsolute = join(absoluteDirectory, entry.name)
    const generated = childRelative.split('/').slice(0, entry.isDirectory() ? undefined : -1).some(segment => GENERATED_NAMES.has(segment))
    const ignored = await rules.ignores(childRelative, entry.isDirectory())
    const attributes = { ...(generated ? { generated: true } : {}), ...(ignored ? { ignored: true } : {}) }
    if (entry.isDirectory()) {
      // 生成目录：只出名字（generated + 空 children），内容等展开时惰性拉取
      if (generated || singleLayer) {
        directories.push({ name: entry.name, path: childRelative, kind: 'dir', children: [], childrenLoaded: false, ...attributes })
        continue
      }
      if (depth >= maxDepth) {
        budget.truncated = true
        directories.push({ name: entry.name, path: childRelative, kind: 'dir', children: [], childrenLoaded: false, ...attributes })
        continue
      }
      const remainingBefore = budget.remaining
      const warningsBefore = rules.warnings.length
      const children = await readDirectory(childAbsolute, childRelative, depth + 1, maxDepth, budget, rules)
      directories.push({
        name: entry.name,
        path: childRelative,
        kind: 'dir',
        children,
        childrenLoaded: remainingBefore > 0 && budget.remaining > 0 && rules.warnings.length === warningsBefore,
        ...attributes,
      })
      continue
    }
    let size = 0
    try {
      size = (await stat(childAbsolute)).size
    } catch {
      continue
    }
    files.push({ name: entry.name, path: childRelative, kind: 'file', size, ...attributes })
  }
  // 契约 2.2：目录在前、文件在后，各自按名称 localeCompare。
  return [...directories, ...files]
}

/** 契约 2.3：读文件（F2：附带内容 hash revision），超限 `FH2_IDE_TOO_LARGE`，含 NUL 的二进制 `FH2_IDE_NOT_A_FILE`。 */
export async function readWorkspaceFile (
  root: string,
  rawPath: unknown,
  maxBytes: number = MAX_FILE_BYTES,
): Promise<IdeFileData & { readonly revision: string }> {
  const target = resolveWorkspacePath(root, rawPath)
  let stats
  try {
    stats = await stat(target.absolutePath)
  } catch {
    throw new IdeRequestError(
      'FH2_IDE_NOT_FOUND',
      `文件不存在：${target.relativePath}。File not found: ${target.relativePath}.`,
    )
  }
  if (!stats.isFile()) {
    throw new IdeRequestError(
      'FH2_IDE_NOT_A_FILE',
      `目标不是文件：${target.relativePath}。Target is not a file: ${target.relativePath}.`,
    )
  }
  if (stats.size > maxBytes) {
    throw new IdeRequestError(
      'FH2_IDE_TOO_LARGE',
      `文件超过 ${maxBytes} 字节上限：${target.relativePath}。File exceeds the ${maxBytes}-byte limit: ${target.relativePath}.`,
    )
  }
  let content: Buffer
  try {
    content = await readFile(target.absolutePath)
  } catch (error) {
    throw new IdeRequestError(
      'FH2_IDE_INTERNAL',
      `读取文件失败：${errorMessage(error)}。Failed to read file: ${errorMessage(error)}.`,
    )
  }
  // 读到 NUL 说明不是可编辑文本；Monaco 拿到会渲染成乱码，按契约拒绝。
  if (content.includes(0)) {
    throw new IdeRequestError(
      'FH2_IDE_NOT_A_FILE',
      `二进制文件不可编辑：${target.relativePath}。Binary files cannot be edited: ${target.relativePath}.`,
    )
  }
  return {
    path: target.relativePath,
    content: content.toString('utf8'),
    encoding: 'utf-8',
    revision: revisionOf(content),
  }
}

/** 文件内容 revision：sha256 hex（F2 文件一致性契约）。 */
export function revisionOf (content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * F2 冲突错误：携带当前磁盘快照，供前端提供 Diff、采用磁盘、保留本地、另存副本。
 * HTTP 状态 409；错误信封附带 `conflict` 载荷（见 ide-server sendError）。
 */
export class IdeFileConflictError extends IdeRequestError {
  constructor (
    message: string,
    readonly disk: FileSnapshot,
  ) {
    super('FH2_FILE_CONFLICT', message)
  }
}

export interface WriteWorkspaceFileOptions {
  readonly maxBytes?: number;
  /**
   * 期望的磁盘 revision（来自上次读取/保存回包）。
   * - 目标已存在：必须提供且必须与磁盘一致，否则 409 冲突（禁止无条件覆盖）；
   * - 目标不存在：省略或空串 = 允许新建；非空 = 文件已被外部删除，按 NOT_FOUND 报错。
   */
  readonly expectedRevision?: unknown;
}

/** 同一路径的写入串行区：revision 校验与临时文件替换必须在同一段临界区内完成。 */
const pathWriteQueues = new Map<string, Promise<unknown>>()

function enqueuePathWrite<T> (absolutePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = pathWriteQueues.get(absolutePath) ?? Promise.resolve()
  const next = previous.then(operation, operation)
  pathWriteQueues.set(absolutePath, next.catch(() => undefined))
  return next
}

/**
 * 契约 2.4 + F2：写文件，先写临时文件再 rename；写入在期望 revision 校验通过后提交。
 *
 * - 已存在文件必须携带匹配的 expectedRevision（内容 hash），不匹配返回 409 + 磁盘快照；
 * - 不自动创建多级目录——Web IDE 里「保存到不存在的目录」几乎总是路径写错，
 *   静默造目录只会留下垃圾。
 */
export async function writeWorkspaceFile (
  root: string,
  rawPath: unknown,
  rawContent: unknown,
  options: WriteWorkspaceFileOptions = {},
): Promise<IdeWriteData & { readonly revision: string }> {
  const maxBytes = options.maxBytes ?? MAX_WRITE_BYTES
  const target = resolveWorkspacePath(root, rawPath)
  if (typeof rawContent !== 'string') {
    throw new IdeRequestError('FH2_IDE_BAD_REQUEST', 'content 必须是字符串。"content" must be a string.')
  }
  const payload = Buffer.from(rawContent, 'utf8')
  if (payload.byteLength > maxBytes) {
    throw new IdeRequestError(
      'FH2_IDE_TOO_LARGE',
      `内容超过 ${maxBytes} 字节上限。Content exceeds the ${maxBytes}-byte limit.`,
    )
  }
  const expectedRevision = typeof options.expectedRevision === 'string' ? options.expectedRevision : ''

  return await enqueuePathWrite(target.absolutePath, async () => {
    const parent = dirname(target.absolutePath)
    if (!existsSync(parent)) {
      throw new IdeRequestError(
        'FH2_IDE_NOT_FOUND',
        `父目录不存在：${target.relativePath}。Parent directory does not exist: ${target.relativePath}.`,
      )
    }
    let existing: Buffer | undefined
    try {
      const stats = lstatSync(target.absolutePath)
      if (stats.isDirectory()) {
        throw new IdeRequestError(
          'FH2_IDE_NOT_A_FILE',
          `目标是目录：${target.relativePath}。Target is a directory: ${target.relativePath}.`,
        )
      }
      existing = await readFile(target.absolutePath)
    } catch (error) {
      if (error instanceof IdeRequestError) throw error
      // 读取失败 = 目标尚不存在，属于新建文件的正常路径。
    }

    if (existing === undefined) {
      if (expectedRevision !== '') {
        throw new IdeRequestError(
          'FH2_IDE_NOT_FOUND',
          `文件已被外部删除：${target.relativePath}。File was removed externally: ${target.relativePath}.`,
        )
      }
    } else {
      const currentRevision = revisionOf(existing)
      if (expectedRevision === '' || expectedRevision !== currentRevision) {
        throw new IdeFileConflictError(
          `文件已被外部修改：${target.relativePath}。File was changed externally: ${target.relativePath}.`,
          {
            path: target.relativePath,
            content: existing.toString('utf8'),
            revision: currentRevision,
            encoding: 'utf-8',
          },
        )
      }
    }

    // 临时文件与目标同目录，保证 rename 是同分区的原子替换。
    const temporaryPath = join(parent, `.${randomUUID()}.fh2-ide-tmp`)
    try {
      await writeFile(temporaryPath, payload)
      await rename(temporaryPath, target.absolutePath)
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      throw new IdeRequestError(
        'FH2_IDE_WRITE_FAILED',
        `写入失败：${errorMessage(error)}。Write failed: ${errorMessage(error)}.`,
      )
    }
    return { path: target.relativePath, bytesWritten: payload.byteLength, revision: revisionOf(payload) }
  })
}

/**
 * 契约 6.1：新建文件或目录。
 *
 * 与 {@link writeWorkspaceFile} 同一条纪律——不自动创建多级目录，父目录不存在
 * 直接 404；已存在则 409，绝不静默覆盖用户已有的内容。
 */
export async function createWorkspaceEntry (
  root: string,
  rawPath: unknown,
  rawKind: unknown,
  rawContent: unknown,
  maxBytes: number = MAX_WRITE_BYTES,
): Promise<IdeFsCreateData> {
  if (rawKind !== 'file' && rawKind !== 'dir') {
    throw new IdeRequestError('FH2_IDE_BAD_REQUEST', 'kind 必须是 "file" 或 "dir"。"kind" must be "file" or "dir".')
  }
  const target = resolveWorkspacePath(root, rawPath)
  // 新建不允许落在工作根自身：`path: "."` 语义上是「重建工作根」，没有意义。
  if (target.relativePath === '.') {
    throw new IdeRequestError('FH2_IDE_BAD_REQUEST', 'path 不能是工作根自身。Path must not be the workspace root.')
  }
  const parent = dirname(target.absolutePath)
  if (!existsSync(parent)) {
    throw new IdeRequestError(
      'FH2_IDE_NOT_FOUND',
      `父目录不存在：${target.relativePath}。Parent directory does not exist: ${target.relativePath}.`,
    )
  }
  // lstat 而非 stat：悬空 symlink 也算「已存在」，覆盖它同样是破坏性操作。
  if (existsLstat(target.absolutePath)) {
    throw new IdeRequestError(
      'FH2_IDE_ALREADY_EXISTS',
      `目标已存在：${target.relativePath}。Target already exists: ${target.relativePath}.`,
    )
  }

  if (rawKind === 'dir') {
    if (rawContent !== undefined && rawContent !== null) {
      throw new IdeRequestError(
        'FH2_IDE_BAD_REQUEST',
        'kind 为 "dir" 时不接受 content。"content" is not accepted when "kind" is "dir".',
      )
    }
    try {
      await mkdir(target.absolutePath)
    } catch (error) {
      throw new IdeRequestError(
        'FH2_IDE_WRITE_FAILED',
        `创建目录失败：${errorMessage(error)}。Failed to create directory: ${errorMessage(error)}.`,
      )
    }
    return { path: target.relativePath, kind: 'dir' }
  }

  const content = rawContent === undefined || rawContent === null ? '' : rawContent
  if (typeof content !== 'string') {
    throw new IdeRequestError('FH2_IDE_BAD_REQUEST', 'content 必须是字符串。"content" must be a string.')
  }
  const payload = Buffer.from(content, 'utf8')
  if (payload.byteLength > maxBytes) {
    throw new IdeRequestError(
      'FH2_IDE_TOO_LARGE',
      `内容超过 ${maxBytes} 字节上限。Content exceeds the ${maxBytes}-byte limit.`,
    )
  }
  try {
    // wx：内核层保证「不存在才创建」，堵住上面 lstat 与这里之间的竞态窗口。
    await writeFile(target.absolutePath, payload, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new IdeRequestError(
        'FH2_IDE_ALREADY_EXISTS',
        `目标已存在：${target.relativePath}。Target already exists: ${target.relativePath}.`,
      )
    }
    throw new IdeRequestError(
      'FH2_IDE_WRITE_FAILED',
      `写入失败：${errorMessage(error)}。Write failed: ${errorMessage(error)}.`,
    )
  }
  return { path: target.relativePath, kind: 'file' }
}

/**
 * 契约 6.2：删除文件或目录。
 *
 * 递归删除不做默认值：Web IDE 里误点一次目录删除就能抹掉整个 src，
 * `recursive` 必须由前端显式带上。
 */
export async function deleteWorkspaceEntry (
  root: string,
  rawPath: unknown,
  rawRecursive: unknown,
): Promise<IdeFsDeleteData> {
  if (rawRecursive !== undefined && typeof rawRecursive !== 'boolean') {
    throw new IdeRequestError('FH2_IDE_BAD_REQUEST', 'recursive 必须是布尔值。"recursive" must be a boolean.')
  }
  const target = resolveWorkspacePath(root, rawPath)
  if (target.relativePath === '.') {
    throw new IdeRequestError('FH2_IDE_BAD_REQUEST', '不允许删除工作根自身。Deleting the workspace root is not allowed.')
  }
  let stats
  try {
    stats = lstatSync(target.absolutePath)
  } catch {
    throw new IdeRequestError(
      'FH2_IDE_NOT_FOUND',
      `目标不存在：${target.relativePath}。Target not found: ${target.relativePath}.`,
    )
  }

  if (!stats.isDirectory()) {
    try {
      await unlink(target.absolutePath)
    } catch (error) {
      throw new IdeRequestError(
        'FH2_IDE_WRITE_FAILED',
        `删除失败：${errorMessage(error)}。Delete failed: ${errorMessage(error)}.`,
      )
    }
    return { path: target.relativePath, kind: 'file' }
  }

  if (rawRecursive === true) {
    try {
      await rm(target.absolutePath, { recursive: true, force: true })
    } catch (error) {
      throw new IdeRequestError(
        'FH2_IDE_WRITE_FAILED',
        `删除失败：${errorMessage(error)}。Delete failed: ${errorMessage(error)}.`,
      )
    }
    return { path: target.relativePath, kind: 'dir' }
  }

  try {
    await rmdir(target.absolutePath)
  } catch (error) {
    // rmdir 对非空目录报 ENOTEMPTY（部分平台是 EEXIST），两者都映射到契约的 409。
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOTEMPTY' || code === 'EEXIST') {
      throw new IdeRequestError(
        'FH2_IDE_NOT_EMPTY',
        `目录非空，需显式传 recursive：${target.relativePath}。`
        + `Directory is not empty; pass "recursive": true: ${target.relativePath}.`,
      )
    }
    throw new IdeRequestError(
      'FH2_IDE_WRITE_FAILED',
      `删除失败：${errorMessage(error)}。Delete failed: ${errorMessage(error)}.`,
    )
  }
  return { path: target.relativePath, kind: 'dir' }
}

/**
 * 契约 6.3：重命名 / 跨目录移动。
 *
 * `from` 与 `to` 各自独立过 {@link resolveWorkspacePath}——只校验一侧等于把另一侧
 * 当成可信输入，而重命名恰恰是「两个都能写」的操作。
 */
export async function renameWorkspaceEntry (
  root: string,
  rawFrom: unknown,
  rawTo: unknown,
  rawOverwrite: unknown,
): Promise<IdeFsRenameData> {
  if (rawOverwrite !== undefined && typeof rawOverwrite !== 'boolean') {
    throw new IdeRequestError('FH2_IDE_BAD_REQUEST', 'overwrite 必须是布尔值。"overwrite" must be a boolean.')
  }
  const from = resolveWorkspacePath(root, rawFrom, 'from')
  const to = resolveWorkspacePath(root, rawTo, 'to')
  if (from.relativePath === '.' || to.relativePath === '.') {
    throw new IdeRequestError('FH2_IDE_BAD_REQUEST', 'from/to 不能是工作根自身。"from"/"to" must not be the workspace root.')
  }
  if (from.absolutePath === to.absolutePath) {
    throw new IdeRequestError('FH2_IDE_BAD_REQUEST', 'from 与 to 相同。"from" and "to" are identical.')
  }
  if (!existsLstat(from.absolutePath)) {
    throw new IdeRequestError(
      'FH2_IDE_NOT_FOUND',
      `源不存在：${from.relativePath}。Source not found: ${from.relativePath}.`,
    )
  }
  const parent = dirname(to.absolutePath)
  if (!existsSync(parent)) {
    throw new IdeRequestError(
      'FH2_IDE_NOT_FOUND',
      `目标父目录不存在：${to.relativePath}。Destination parent directory does not exist: ${to.relativePath}.`,
    )
  }
  const destinationExists = existsLstat(to.absolutePath)
  if (destinationExists && rawOverwrite !== true) {
    throw new IdeRequestError(
      'FH2_IDE_ALREADY_EXISTS',
      `目标已存在，需显式传 overwrite：${to.relativePath}。`
      + `Destination already exists; pass "overwrite": true: ${to.relativePath}.`,
    )
  }
  // rename 不会把目录搬进它自己的子目录，但错误码是 EINVAL，提前拦下给出可读原因。
  if (isInside(from.absolutePath, to.absolutePath)) {
    throw new IdeRequestError(
      'FH2_IDE_BAD_REQUEST',
      `不能把目录移动到自身内部：${to.relativePath}。Cannot move a directory into itself: ${to.relativePath}.`,
    )
  }

  try {
    // 覆盖目录时 rename 会失败（ENOTEMPTY/EISDIR），显式先删——overwrite 已经是
    // 前端确认过的破坏性意图。
    if (destinationExists && lstatSync(to.absolutePath).isDirectory()) {
      await rm(to.absolutePath, { recursive: true, force: true })
    }
    await rename(from.absolutePath, to.absolutePath)
  } catch (error) {
    throw new IdeRequestError(
      'FH2_IDE_WRITE_FAILED',
      `重命名失败：${errorMessage(error)}。Rename failed: ${errorMessage(error)}.`,
    )
  }
  return { from: from.relativePath, to: to.relativePath }
}

/**
 * 契约 6.4：复制文件 / 目录（递归）。
 *
 * 服务端 `fs.cp` 整体复制而不是「前端读再写」：读写通道只收 UTF-8 文本
 * （含 NUL 的二进制会被 2.3 拒绝），前端搬运会毁掉图标 / 字体等二进制资源。
 *
 * 防护与 6.3 同纪律：两侧各自过 {@link resolveWorkspacePath}；目标已存在直接
 * 409（重名改名由调用方决定，服务端不静默覆盖）；不允许把目录复制进自身。
 */
export async function copyWorkspaceEntry (
  root: string,
  rawFrom: unknown,
  rawTo: unknown,
): Promise<IdeFsCopyData> {
  const from = resolveWorkspacePath(root, rawFrom, 'from')
  const to = resolveWorkspacePath(root, rawTo, 'to')
  if (from.relativePath === '.' || to.relativePath === '.') {
    throw new IdeRequestError('FH2_IDE_BAD_REQUEST', 'from/to 不能是工作根自身。"from"/"to" must not be the workspace root.')
  }
  if (from.absolutePath === to.absolutePath) {
    throw new IdeRequestError('FH2_IDE_BAD_REQUEST', 'from 与 to 相同。"from" and "to" are identical.')
  }
  if (!existsLstat(from.absolutePath)) {
    throw new IdeRequestError(
      'FH2_IDE_NOT_FOUND',
      `源不存在：${from.relativePath}。Source not found: ${from.relativePath}.`,
    )
  }
  const parent = dirname(to.absolutePath)
  if (!existsSync(parent)) {
    throw new IdeRequestError(
      'FH2_IDE_NOT_FOUND',
      `目标父目录不存在：${to.relativePath}。Destination parent directory does not exist: ${to.relativePath}.`,
    )
  }
  if (existsLstat(to.absolutePath)) {
    throw new IdeRequestError(
      'FH2_IDE_ALREADY_EXISTS',
      `目标已存在：${to.relativePath}。Destination already exists: ${to.relativePath}.`,
    )
  }
  if (isInside(from.absolutePath, to.absolutePath)) {
    throw new IdeRequestError(
      'FH2_IDE_BAD_REQUEST',
      `不能把目录复制到自身内部：${to.relativePath}。Cannot copy a directory into itself: ${to.relativePath}.`,
    )
  }

  try {
    await cp(from.absolutePath, to.absolutePath, { recursive: true })
  } catch (error) {
    // 失败时清掉半成品，不留残缺副本（rm 对不存在的路径 force 静默）。
    await rm(to.absolutePath, { recursive: true, force: true }).catch(() => undefined)
    throw new IdeRequestError(
      'FH2_IDE_WRITE_FAILED',
      `复制失败：${errorMessage(error)}。Copy failed: ${errorMessage(error)}.`,
    )
  }
  return { from: from.relativePath, to: to.relativePath }
}

function existsLstat (absolutePath: string): boolean {
  try {
    lstatSync(absolutePath)
    return true
  } catch {
    return false
  }
}

function isInside (parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate)
  return fromParent !== '' && !isAbsolute(fromParent) && !fromParent.startsWith(`..${sep}`) && fromParent !== '..'
}

function nearestExistingAncestor (absolutePath: string): string | undefined {
  let current = absolutePath
  for (;;) {
    if (existsSync(current)) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function isContained (root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
}

function isEscaping (normalizedRelative: string): boolean {
  return normalizedRelative === '..'
    || normalizedRelative.startsWith(`..${sep}`)
    || normalizedRelative.startsWith('../')
}

function toPosix (value: string): string {
  return value.replaceAll(sep, '/')
}

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
