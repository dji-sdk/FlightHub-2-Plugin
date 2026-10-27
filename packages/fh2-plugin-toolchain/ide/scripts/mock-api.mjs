#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * fh2-web-ide 的本地 Mock API —— 按 WebIDE/API契约.md v1 + v2 增补实现，供前端在
 * `serve` 就绪前独立联调。**不是产品代码**，`fh2-plugin serve` 才是唯一正式实现。
 *
 * 用法：
 *   node scripts/mock-api.mjs            # 127.0.0.1:35321，工作根 .mock-workspace（自动播种）
 *   node scripts/mock-api.mjs --root DIR --port 4000 --token abc
 *
 * 与 vite.config.ts 的 `/api` 代理配套：`pnpm dev` + `pnpm mock` 即可在浏览器里跑通全链路。
 */

import { createReadStream, existsSync, statSync, watch } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import process from 'node:process'

const HERE = dirname(fileURLToPath(import.meta.url))

function parseArgs (argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    if (typeof key !== 'string' || !key.startsWith('--')) continue
    out[key.slice(2)] = argv[i + 1]
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
// 契约 §7 的工作区切换会改这个值，因此不能是 const
let ROOT = resolve(args.root ?? join(HERE, '..', '.mock-workspace'))
const PORT = Number(args.port ?? 35321)
const TOKEN = args.token ?? 'dev-token'
const IGNORED = new Set(['node_modules', 'dist', '.git', '.DS_Store'])
const MAX_FILE_BYTES = 2 * 1024 * 1024

// ── 响应封装（契约 §1） ───────────────────────────────

function sendJson (res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

const ok = (res, data) => sendJson(res, 200, { schemaVersion: 1, ok: true, data })
function fail (res, status, code, message, conflict) {
  return sendJson(res, status, { schemaVersion: 1, ok: false, error: { code, message }, ...(conflict === undefined ? {} : { conflict }) })
}

function revisionOf (content) {
  return createHash('sha256').update(content).digest('hex')
}

// ── 路径安全（契约 §0） ───────────────────────────────

function resolveInRoot (relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return { error: ['FH2_IDE_BAD_REQUEST', 400, 'path 缺失。Missing path.'] }
  const absolute = resolve(ROOT, relPath)
  if (absolute !== ROOT && !absolute.startsWith(ROOT + sep)) {
    return { error: ['FH2_IDE_PATH_ESCAPE', 400, '路径逃逸出工作根。Path escapes workspace root.'] }
  }
  return { absolute }
}

const toPosix = abs => relative(ROOT, abs).split(sep).join(posix.sep)

// ── 文件树（契约 §2.2） ───────────────────────────────

async function readTree (absDir, depth = 0) {
  if (depth >= 12) return []
  const entries = await readdir(absDir, { withFileTypes: true })
  const dirs = []
  const files = []
  for (const entry of entries) {
    if (IGNORED.has(entry.name) || entry.name.startsWith('.')) continue
    const abs = join(absDir, entry.name)
    if (entry.isDirectory()) {
      dirs.push({ name: entry.name, path: toPosix(abs), kind: 'dir', children: await readTree(abs, depth + 1) })
    } else if (entry.isFile()) {
      files.push({ name: entry.name, path: toPosix(abs), kind: 'file', size: (await stat(abs)).size })
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name)
  return [...dirs.sort(byName), ...files.sort(byName)]
}

// ── Schemas（契约 §2.7） ──────────────────────────────

async function loadSchemas () {
  // Use the compiled public consumer, including projection validation and member matching.
  const { resolveIdeSchemas } = await import('../../dist/index.js')
  return resolveIdeSchemas({ root: ROOT }).schemas
}

// ── 假校验：把 manifest 的几条硬规则跑一遍，产出带行列的诊断 ──

/** 在源文本里定位一个顶层 JSON key，返回 1-based 行列。 */
function locateKey (text, key) {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const column = lines[i].indexOf(`"${key}"`)
    if (column !== -1) return { line: i + 1, column: column + 1 }
  }
  return { line: 1, column: 1 }
}

async function fakeValidate () {
  const diagnostics = []
  const manifestPath = join(ROOT, 'fh2-plugin.json')
  if (existsSync(manifestPath)) {
    const text = await readFile(manifestPath, 'utf8')
    let manifest = null
    try {
      manifest = JSON.parse(text)
    } catch (error) {
      diagnostics.push({
        code: 'FH2_MANIFEST_PARSE_FAILED',
        phase: 'parse',
        file: 'fh2-plugin.json',
        line: 1,
        column: 1,
        message: `Manifest 不是合法 JSON：${error.message}`,
        hint: '检查逗号与引号。',
        severity: 'error',
      })
    }
    if (manifest !== null) {
      if (typeof manifest.id !== 'string' || !/^(?:official|exp)_[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(manifest.id)) {
        const at = locateKey(text, 'id')
        diagnostics.push({
          code: 'FH2_MANIFEST_ID_INVALID',
          phase: 'semantic',
          file: 'fh2-plugin.json',
          line: at.line,
          column: at.column,
          path: '/id',
          message: `插件 ID ${JSON.stringify(manifest.id)} 不符合命名规则。`,
          hint: '顶层 Plugin ID 必须以 official_ 或 exp_ 前缀开头，且为小写短名。',
          severity: 'error',
        })
      }
      if (!Array.isArray(manifest.extensions) || manifest.extensions.length === 0) {
        const at = locateKey(text, 'extensions')
        diagnostics.push({
          code: 'FH2_MANIFEST_NO_EXTENSIONS',
          phase: 'semantic',
          file: 'fh2-plugin.json',
          line: at.line,
          column: at.column,
          path: '/extensions',
          message: '插件未声明任何扩展点贡献。',
          hint: '至少声明一个 extensions 条目，否则插件装上也不会出现在任何 Host。',
          severity: 'warning',
        })
      }
    }
  }

  // 后端脚本的 Goja ES5.1 门禁：出现 const/let/箭头函数就报错
  const backendDir = join(ROOT, 'backend')
  if (existsSync(backendDir)) {
    const walk = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name)
        if (entry.isDirectory()) await walk(abs)
        else if (extname(entry.name) === '.js') await checkEs5(abs, diagnostics)
      }
    }
    await walk(backendDir)
  }
  return diagnostics
}

async function checkEs5 (abs, diagnostics) {
  const lines = (await readFile(abs, 'utf8')).split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const match = /\b(const|let)\s|=>/.exec(lines[i])
    if (match === null) continue
    diagnostics.push({
      code: 'FH2_BACKEND_ES5_ONLY',
      phase: 'code',
      file: toPosix(abs),
      line: i + 1,
      column: match.index + 1,
      message: `后端脚本运行在 Goja（ES5.1），不支持 ${match[0].trim() || '箭头函数'}。`,
      hint: '改用 var 与 function 表达式。',
      severity: 'error',
    })
  }
}

// ── SSE（契约 §2.8） ──────────────────────────────────

const sseClients = new Set()

function broadcast (event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  for (const client of sseClients) client.write(frame)
}

let watcher = null

function startWatcher () {
  // 契约要求 chokidar；mock 不引依赖，用 fs.watch recursive（macOS/Windows 支持）
  try {
    watcher = watch(ROOT, { recursive: true }, (eventType, filename) => {
      if (typeof filename !== 'string') return
      const relPath = filename.split(sep).join(posix.sep)
      if (relPath.split(posix.sep).some(seg => IGNORED.has(seg) || seg.startsWith('.'))) return
      const abs = join(ROOT, filename)
      const exists = existsSync(abs)
      const type = !exists
        ? 'unlink'
        : eventType === 'rename'
          ? (statSync(abs).isDirectory() ? 'addDir' : 'add')
          : 'change'
      broadcast('fs', { schemaVersion: 1, type, path: relPath })
    })
  } catch (error) {
    process.stderr.write(`[mock-api] 文件监听不可用：${error.message}\n`)
  }
}

function restartWatcher () {
  watcher?.close()
  watcher = null
  startWatcher()
}

// ── 工作区（契约 §7） ────────────────────────────────

function workspaceInfo (root = ROOT) {
  return {
    root,
    name: basename(root),
    kind: existsSync(join(root, 'fh2-plugin.json'))
      ? 'frontend-plugin'
      : existsSync(join(root, 'plugin.json')) || existsSync(join(root, 'backend', 'plugin.json'))
        ? 'backend-plugin'
        : 'unknown',
    toolchainVersion: '1.0.0-alpha.0',
  }
}

/** 进程内维护，不落盘（契约 §7.2）。 */
const recentRoots = []

function rememberRoot (root) {
  const index = recentRoots.indexOf(root)
  if (index !== -1) recentRoots.splice(index, 1)
  recentRoots.unshift(root)
  if (recentRoots.length > 8) recentRoots.length = 8
}

/** mock 版的 tryDiscoverCommandContext：目录存在且能看出是插件工程即可。 */
function isPluginProject (root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) return false
  return ['fh2-plugin.json', 'plugin.json', 'backend/plugin.json', 'package.json']
    .some(marker => existsSync(join(root, marker)))
}

// ── 运行 / 预览（契约 §8） ───────────────────────────

/**
 * mock 不真的起进程 —— 那会把联调变成「调 dev server」。
 * 这里只模拟状态机与日志流：starting → running（dev 给一个假 URL），stop → stopped。
 */
const runProcesses = new Map()
const runTimers = new Map()

function emitRun (mode) {
  const current = runProcesses.get(mode)
  if (current === undefined) return
  broadcast('run', {
    schemaVersion: 1,
    mode,
    status: current.status,
    ...(current.url === undefined ? {} : { url: current.url }),
  })
}

function emitRunLog (mode, line, stream = 'stdout') {
  broadcast('run-log', { schemaVersion: 1, mode, stream, line })
}

function clearRunTimers (mode) {
  for (const timer of runTimers.get(mode) ?? []) clearTimeout(timer)
  runTimers.set(mode, [])
}

function scheduleRun (mode, delay, fn) {
  const timer = setTimeout(fn, delay)
  timer.unref?.()
  const list = runTimers.get(mode)
  if (list === undefined) runTimers.set(mode, [timer])
  else list.push(timer)
}

function startMockProcess (mode, target) {
  clearRunTimers(mode)
  const url = mode === 'dev' ? 'http://127.0.0.1:35399' : ''
  runProcesses.set(mode, { mode, status: 'starting', since: Date.now(), ...(url === '' ? {} : { url }) })
  emitRun(mode)
  emitRunLog(mode, `[mock] 正在启动 ${mode}${target === '' ? '' : ` → ${target}`}…`)

  scheduleRun(mode, 400, () => emitRunLog(mode, '[mock] 解析工作区…'))
  scheduleRun(mode, 900, () => {
    emitRunLog(mode, mode === 'preview' ? '[mock] 构建前端并启动本地预览服务…' : '[mock] 编译 Mock Host…')
  })
  scheduleRun(mode, 1500, () => {
    const current = runProcesses.get(mode)
    if (current === undefined || current.status !== 'starting') return
    runProcesses.set(mode, { ...current, status: 'running' })
    emitRun(mode)
    emitRunLog(mode, mode === 'dev' ? `[mock] 已就绪：${url}` : '[mock] 前端预览已就绪')
  })
  // 持续刷日志，用来验证日志面板的自动滚动与行数上限
  let tick = 0
  const interval = setInterval(() => {
    if (runProcesses.get(mode)?.status !== 'running') return
    tick += 1
    emitRunLog(mode, `[mock] ${mode} heartbeat #${tick} ${new Date().toISOString()}`)
    if (tick % 7 === 0) emitRunLog(mode, `[mock] ${mode} 一条模拟的 stderr 输出`, 'stderr')
  }, 2000)
  interval.unref?.()
  runTimers.get(mode)?.push(interval)
  return runProcesses.get(mode)
}

function stopMockProcess (mode) {
  clearRunTimers(mode)
  emitRunLog(mode, `[mock] 正在停止 ${mode}…`)
  runProcesses.set(mode, { mode, status: 'stopped' })
  emitRun(mode)
  return { mode, status: 'stopped' }
}

function startPing () {
  setInterval(() => broadcast('ping', { schemaVersion: 1, ts: Date.now() }), 30_000).unref()
}

// ── 路由 ─────────────────────────────────────────────

async function readBody (req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

let cachedSchemas = null

async function handle (req, res, url) {
  switch (`${req.method} ${url.pathname}`) {
    case 'GET /api/workspace':
      return ok(res, workspaceInfo())

    case 'GET /api/tree':
      return ok(res, { truncated: false, tree: await readTree(ROOT) })

    case 'GET /api/schemas':
      cachedSchemas ??= await loadSchemas()
      return ok(res, { schemas: cachedSchemas })

    case 'GET /api/file': {
      const { absolute, error } = resolveInRoot(url.searchParams.get('path'))
      if (error !== undefined) return fail(res, error[1], error[0], error[2])
      if (!existsSync(absolute)) return fail(res, 404, 'FH2_IDE_NOT_FOUND', '文件不存在。File not found.')
      const info = await stat(absolute)
      if (!info.isFile()) return fail(res, 400, 'FH2_IDE_NOT_A_FILE', '目标不是文件。Not a file.')
      if (info.size > MAX_FILE_BYTES) return fail(res, 413, 'FH2_IDE_TOO_LARGE', '文件超过 2 MiB。File too large.')
      const buffer = await readFile(absolute)
      if (buffer.includes(0)) return fail(res, 400, 'FH2_IDE_NOT_A_FILE', '二进制文件不可编辑。Binary file.')
      return ok(res, { path: toPosix(absolute), content: buffer.toString('utf8'), encoding: 'utf-8', revision: revisionOf(buffer) })
    }

    case 'PUT /api/file': {
      const body = await readBody(req)
      if (body === null || typeof body.content !== 'string') {
        return fail(res, 400, 'FH2_IDE_BAD_REQUEST', 'content 缺失。Missing content.')
      }
      const { absolute, error } = resolveInRoot(body.path)
      if (error !== undefined) return fail(res, error[1], error[0], error[2])
      // F2：revision 一致性（mock 与真实 serve 契约一致）
      const expected = typeof body.expectedRevision === 'string' ? body.expectedRevision : ''
      const existing = existsSync(absolute) ? await readFile(absolute) : undefined
      if (existing !== undefined) {
        const current = revisionOf(existing)
        if (expected === '' || expected !== current) {
          return fail(res, 409, 'FH2_FILE_CONFLICT', '文件已被外部修改。File changed externally.', {
            code: 'FH2_FILE_CONFLICT',
            message: '文件已被外部修改。File changed externally.',
            disk: { path: toPosix(absolute), content: existing.toString('utf8'), revision: current, encoding: 'utf-8' },
          })
        }
      } else if (expected !== '') {
        return fail(res, 404, 'FH2_IDE_NOT_FOUND', '文件已被外部删除。File removed externally.')
      }
      try {
        const temporary = `${absolute}.tmp-${process.pid}-${Date.now()}`
        await writeFile(temporary, body.content, 'utf8')
        await rename(temporary, absolute)
      } catch (cause) {
        return fail(res, 500, 'FH2_IDE_WRITE_FAILED', `写入失败：${cause.message}`)
      }
      return ok(res, { path: toPosix(absolute), bytesWritten: Buffer.byteLength(body.content), revision: revisionOf(body.content) })
    }

    case 'POST /api/validate': {
      const started = Date.now()
      await readBody(req)
      const diagnostics = await fakeValidate()
      return ok(res, {
        ok: !diagnostics.some(d => d.severity === 'error'),
        diagnostics,
        durationMs: Date.now() - started,
      })
    }

    case 'POST /api/build': {
      const started = Date.now()
      await readBody(req)
      const diagnostics = await fakeValidate()
      const failed = diagnostics.some(d => d.severity === 'error')
      return ok(res, {
        ok: !failed,
        diagnostics,
        outputs: failed ? [] : ['dist/fh2-plugin.json', 'dist/entry.js'],
        durationMs: Date.now() - started,
      })
    }

    // ── 契约 §6 文件管理 ──────────────────────────

    case 'POST /api/fs/create': {
      const body = await readBody(req)
      if (body === null || (body.kind !== 'file' && body.kind !== 'dir')) {
        return fail(res, 400, 'FH2_IDE_BAD_REQUEST', 'kind 必须是 file 或 dir。')
      }
      const { absolute, error } = resolveInRoot(body.path)
      if (error !== undefined) return fail(res, error[1], error[0], error[2])
      if (existsSync(absolute)) return fail(res, 409, 'FH2_IDE_ALREADY_EXISTS', '目标已存在。Already exists.')
      // 契约 §6.1：父目录不存在不自动创建
      if (!existsSync(dirname(absolute))) {
        return fail(res, 404, 'FH2_IDE_NOT_FOUND', '父目录不存在。Parent directory not found.')
      }
      try {
        if (body.kind === 'dir') await mkdir(absolute)
        else await writeFile(absolute, typeof body.content === 'string' ? body.content : '', 'utf8')
      } catch (cause) {
        return fail(res, 500, 'FH2_IDE_WRITE_FAILED', `创建失败：${cause.message}`)
      }
      return ok(res, { path: toPosix(absolute), kind: body.kind })
    }

    case 'POST /api/fs/delete': {
      const body = await readBody(req)
      if (body === null) return fail(res, 400, 'FH2_IDE_BAD_REQUEST', '请求体不是 JSON。')
      const { absolute, error } = resolveInRoot(body.path)
      if (error !== undefined) return fail(res, error[1], error[0], error[2])
      if (absolute === ROOT) return fail(res, 400, 'FH2_IDE_BAD_REQUEST', '不能删除工作根。')
      if (!existsSync(absolute)) return fail(res, 404, 'FH2_IDE_NOT_FOUND', '目标不存在。Not found.')
      const info = await stat(absolute)
      const kind = info.isDirectory() ? 'dir' : 'file'
      if (kind === 'dir' && body.recursive !== true && (await readdir(absolute)).length > 0) {
        return fail(res, 409, 'FH2_IDE_NOT_EMPTY', '目录非空且未传 recursive。Directory not empty.')
      }
      try {
        // rm 对目录必须带 recursive（空目录也一样），但「能否递归」的门禁上面已经做过了
        await rm(absolute, { recursive: kind === 'dir', force: false })
      } catch (cause) {
        return fail(res, 500, 'FH2_IDE_INTERNAL', `删除失败：${cause.message}`)
      }
      return ok(res, { path: toPosix(absolute), kind })
    }

    case 'POST /api/fs/rename': {
      const body = await readBody(req)
      if (body === null) return fail(res, 400, 'FH2_IDE_BAD_REQUEST', '请求体不是 JSON。')
      const from = resolveInRoot(body.from)
      if (from.error !== undefined) return fail(res, from.error[1], from.error[0], from.error[2])
      const to = resolveInRoot(body.to)
      if (to.error !== undefined) return fail(res, to.error[1], to.error[0], to.error[2])
      if (!existsSync(from.absolute)) return fail(res, 404, 'FH2_IDE_NOT_FOUND', '源不存在。Source not found.')
      if (existsSync(to.absolute) && body.overwrite !== true) {
        return fail(res, 409, 'FH2_IDE_ALREADY_EXISTS', '目标已存在且未传 overwrite。Target exists.')
      }
      if (!existsSync(dirname(to.absolute))) {
        return fail(res, 404, 'FH2_IDE_NOT_FOUND', '目标父目录不存在。Target parent not found.')
      }
      try {
        if (existsSync(to.absolute)) await rm(to.absolute, { recursive: true, force: true })
        await rename(from.absolute, to.absolute)
      } catch (cause) {
        return fail(res, 500, 'FH2_IDE_INTERNAL', `重命名失败：${cause.message}`)
      }
      return ok(res, { from: toPosix(from.absolute), to: toPosix(to.absolute) })
    }

    // ── 契约 §7 工作区切换 ────────────────────────

    case 'POST /api/workspace/open': {
      const body = await readBody(req)
      if (body === null || typeof body.root !== 'string' || body.root === '') {
        return fail(res, 400, 'FH2_IDE_BAD_REQUEST', 'root 缺失。Missing root.')
      }
      if (!isAbsolute(body.root)) {
        return fail(res, 400, 'FH2_IDE_BAD_REQUEST', 'root 必须是绝对路径。Root must be absolute.')
      }
      const next = resolve(body.root)
      if (!isPluginProject(next)) {
        return fail(res, 400, 'FH2_IDE_ROOT_INVALID', '目标不存在或不是插件工程。Not a plugin project.')
      }
      rememberRoot(ROOT)
      ROOT = next
      cachedSchemas = null
      rememberRoot(ROOT)
      restartWatcher()
      const info = workspaceInfo()
      broadcast('workspace', { schemaVersion: 1, root: info.root, name: info.name, kind: info.kind })
      return ok(res, info)
    }

    case 'GET /api/workspace/recent':
      return ok(res, {
        roots: recentRoots.map((root) => {
          const { name, kind } = workspaceInfo(root)
          return { root, name, kind }
        }),
      })

      // ── 契约 §8 运行 / 预览 ───────────────────────

    case 'POST /api/run/start': {
      const body = await readBody(req)
      if (body === null || (body.mode !== 'dev' && body.mode !== 'preview')) {
        return fail(res, 400, 'FH2_IDE_BAD_REQUEST', 'mode 必须是 dev 或 preview。')
      }
      const existing = runProcesses.get(body.mode)
      if (existing !== undefined && existing.status !== 'stopped' && existing.status !== 'failed') {
        return fail(res, 409, 'FH2_IDE_PROCESS_RUNNING', '同类进程已在运行，请先 stop。Already running.')
      }
      const started = startMockProcess(body.mode, typeof body.target === 'string' ? body.target : '')
      return ok(res, {
        mode: started.mode,
        status: started.status,
        ...(started.url === undefined ? {} : { url: started.url }),
      })
    }

    case 'POST /api/run/stop': {
      const body = await readBody(req)
      if (body === null || (body.mode !== 'dev' && body.mode !== 'preview')) {
        return fail(res, 400, 'FH2_IDE_BAD_REQUEST', 'mode 必须是 dev 或 preview。')
      }
      return ok(res, stopMockProcess(body.mode))
    }

    case 'GET /api/run/status':
      return ok(res, { processes: [...runProcesses.values()] })

    default:
      return fail(res, 404, 'FH2_IDE_NOT_FOUND', '接口不存在。Unknown endpoint.')
  }
}

// ── 静态资源（契约 §3）：若存在 dist/ 就托管，模拟 serve 的注入行为 ──

const DIST = join(HERE, '..', 'dist')
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
}

async function serveStatic (req, res, url) {
  if (!existsSync(DIST)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('dist 不存在，请先 pnpm build，或使用 vite dev + /api 代理。')
    return
  }
  const candidate = resolve(DIST, `.${url.pathname}`)
  const isFile = candidate.startsWith(DIST) && existsSync(candidate) && statSync(candidate).isFile()
  const target = isFile ? candidate : join(DIST, 'index.html')

  if (target.endsWith('index.html')) {
    const html = (await readFile(target, 'utf8')).replace(
      '</head>',
      `<script>window.__FH2_IDE_TOKEN__=${JSON.stringify(TOKEN)};window.__FH2_IDE_BASE__="";</script></head>`,
    )
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' })
    res.end(html)
    return
  }
  res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' })
  createReadStream(target).pipe(res)
}

// ── 启动 ─────────────────────────────────────────────

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)

  if (url.pathname === '/api/events') {
    if (url.searchParams.get('token') !== TOKEN) {
      return fail(res, 401, 'FH2_IDE_UNAUTHORIZED', 'token 不匹配。Invalid token.')
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write(`event: ping\ndata: ${JSON.stringify({ schemaVersion: 1, ts: Date.now() })}\n\n`)
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return undefined
  }

  if (url.pathname.startsWith('/api/')) {
    if (req.headers['x-fh2-ide-token'] !== TOKEN) {
      return fail(res, 401, 'FH2_IDE_UNAUTHORIZED', 'token 缺失或不匹配。Missing or invalid token.')
    }
    return handle(req, res, url).catch(error =>
      fail(res, 500, 'FH2_IDE_INTERNAL', `内部错误：${error.message}`))
  }

  return serveStatic(req, res, url).catch(() => {
    res.writeHead(500)
    res.end()
  })
})

await mkdir(ROOT, { recursive: true })
await seedIfEmpty()
rememberRoot(ROOT)
startWatcher()
startPing()
server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`[mock-api] http://127.0.0.1:${server.address().port}  root=${ROOT}  token=${TOKEN}\n`)
})

/** 播种一份「故意有错」的示例工作区，覆盖 schema 报错 / 深层目录 / 后端 ES5 门禁。 */
async function seedIfEmpty () {
  if ((await readdir(ROOT)).length > 0) return
  const files = {
    'fh2-plugin.json': `${JSON.stringify({
      id: 'BadPluginID',
      name: '现场问题协同（Mock）',
      version: '0.1.0',
      entry: './src/plugin.ts',
      permissions: ['platform:http', 'platform:not-a-real-permission'],
      extensions: [
        { id: 'issue-panel', point: 'cockpit.ui.left-panel', view: 'issue-panel' },
      ],
      views: { 'issue-panel': { entry: './src/views/issue-panel/index.ts' } },
    }, null, 2)}\n`,
    'README.md': '# Mock 工作区\n\n由 `scripts/mock-api.mjs` 播种，用于 Web IDE 联调。\n',
    'src/plugin.ts': `import type { PluginContext } from 'fh2-plugin-sdk'\n\nexport function activate (ctx: PluginContext): void {\n  ctx.logger.info('mock plugin activated')\n}\n`,
    'src/shared/issue-api.ts': 'export interface Issue {\n  id: string\n  title: string\n}\n',
    'src/views/issue-panel/index.ts': 'export const viewId = \'issue-panel\'\n',
    'src/views/issue-panel/contract.ts': 'export interface PanelProps {\n  readonly issueId: string\n}\n',
    'src/hosts/cockpit/activate.ts': 'export function activateCockpit (): void {}\n',
    'backend/plugin.json': `${JSON.stringify({
      pluginId: 'exp_mock_backend',
      name: 'Mock 后端插件',
      version: '0.1.0',
      contractsRange: '>=1.1.0 <2.0.0',
      handlers: [{ name: 'issue.list', path: 'handlers/issue.js', entry: 'listIssues' }],
    }, null, 2)}\n`,
    'backend/handlers/issue.js': 'function listIssues(input, ctx) {\n  const store = ctx.hostCapability(\'data-store\')\n  return store.query(\'issue\', { limit: 100 })\n}\n',
    'workflows/daily-report.json': `{
  "name": "daily-report",
  "description": "每日巡检汇总",
  "trigger": {
    "schedule": {
      "intervalSec": 86400
    }
  },
  "steps": [
    {
      "id": "collect-media",
      "action": "run_script",
      "inputs": {
        "script": { "const": "collect-media" }
      }
    },
    {
      "id": "collect-alerts",
      "action": "run_script",
      "inputs": {
        "script": { "const": "collect-alerts" }
      }
    },
    {
      "id": "merge",
      "needs": ["collect-media", "collect-alerts"],
      "action": "run_script",
      "inputs": {
        "script": { "const": "merge-report" },
        "mediaCount": { "from": "collect-media.count" }
      }
    },
    {
      "id": "notify",
      "needs": ["merge"],
      "action": "run_script",
      "inputs": {
        "script": { "const": "notify-operator" }
      }
    }
  ]
}
`,
    'workflows/incident.json': `{
  "name": "incident",
  "trigger": { "api": { "seed": ["incidentId"] } },
  "steps": [
    {
      "id": "dispatch",
      "action": "run_script",
      "inputs": {
        "script": { "const": "dispatch-drone" },
        "incidentId": { "from": "trigger.incidentId" }
      }
    }
  ]
}
`,
  }
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(ROOT, relPath)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
  }
  process.stdout.write(`[mock-api] 已播种示例工作区：${ROOT}\n`)
}
