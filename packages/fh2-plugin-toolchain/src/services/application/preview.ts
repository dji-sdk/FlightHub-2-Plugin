// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import process from 'node:process'
import type { PluginManifest } from 'fh2-plugin-sdk'
import { createPluginBuildRunner } from '../../build/runner.js'
import { PluginBuildError } from '../../build/types.js'
import type { BuildDiagnostic, PluginBuildRunnerOptions, PluginBuildSession } from '../../build/types.js'
import { loadManifest } from '../../manifest.js'
import { PROJECT_PATHS, manifestSide } from '../../project-policy.js'
import { parseStrictJson } from '../../validate/json-reader.js'
import { servePreviewHttpOriginProxy } from '../../preview/http-origin-proxy.js'
import type {
  PreviewStaticServer,
  PreviewStaticServerOptions,
} from '../../preview/static-server.js'
import { acquireOperationLock, canonicalOperationRoot } from '../tasks/operation-lock.js'
import { failureLocationHint, isMissingPathError } from './failure-location.js'
import type { OutputWriter } from './shared.js'

export const PREVIEW_SOURCE_QUERY = 'fh2-plugin-preview-source'
export const PREVIEW_SESSION_QUERY = 'fh2-plugin-preview-session'

export interface PreviewSignalSource {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface PreviewProjectOptions {
  readonly cwd: string;
  readonly onReady?: (url: string) => void;
  readonly operationLockHeld?: boolean;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly signals: PreviewSignalSource;
  readonly prompt?: (message: string) => Promise<string>;
  readonly createRunner?: (options: PluginBuildRunnerOptions) => Promise<PluginBuildSession>;
  readonly loadSourceManifest?: (manifestPath: string) => PluginManifest;
  readonly serve?: (options: PreviewStaticServerOptions) => Promise<PreviewStaticServer>;
  readonly openBrowser?: (url: string) => Promise<void>;
  readonly forceExit?: (code: number) => void;
}

export interface ParsedPreviewArguments {
  readonly projects: readonly PreviewProject[];
  readonly port: number;
  readonly watch: boolean;
  readonly noOpen: boolean;
  readonly help: boolean;
  readonly fh2Url?: string;
}

export interface PreviewProject {
  readonly manifestPath: string;
  readonly projectRoot: string;
  readonly pluginsDir: string;
  readonly configPath?: string;
}

export async function previewProject (parsed: ParsedPreviewArguments, options: PreviewProjectOptions): Promise<number> {
  const releases: Array<() => void> = []
  try {
    if (!options.operationLockHeld) {
      for (const root of [...new Set(parsed.projects.map(project => canonicalOperationRoot(project.projectRoot)))].sort()) releases.push(acquireOperationLock(root))
    }
    return await executePreviewProject(parsed, options)
  } catch (error) {
    if (isMissingPathError(error)) {
      for (const root of new Set(parsed.projects.map(project => project.projectRoot)))
        options.stderr.write(failureLocationHint('preview', root))
    }
    throw error
  } finally {
    for (const release of releases.reverse()) release()
  }
}

async function executePreviewProject (parsed: ParsedPreviewArguments, options: PreviewProjectOptions): Promise<number> {
  // 只预判后端；缺失或无效清单仍由原构建流程诊断。
  for (const project of parsed.projects) {
    let source: string
    try {
      source = readFileSync(project.manifestPath, 'utf8')
    } catch {
      continue
    }
    const result = parseStrictJson(source, project.manifestPath)
    if (!result.ok) continue
    const manifest = result.parsed.value
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) continue
    if (manifestSide(manifest as Record<string, unknown>) === 'backend') {
      options.stderr.write(
        `后端插件目录不支持 Preview：${project.manifestPath}\n`
        + 'Preview 仅构建本地前端，后端使用目标司空环境已安装版本。'
        + '请在前端插件目录或 Capability 根执行 preview；后端本地调试请在后端插件目录执行 fh2-plugin dev。\n',
      )
      return 2
    }
  }

  let target: URL
  try {
    const input = parsed.fh2Url ?? await requestFh2Url(options)
    target = resolvePreviewTarget(input)
  } catch (error) {
    options.stderr.write(`[fh2-plugin] preview 参数错误：${messageOf(error)}\n`)
    return 2
  }

  const terminated = deferred<number>()
  const sessionReady = deferred<void>()
  const serverReady = deferred<void>()
  const sessions: PluginBuildSession[] = []
  const expectedPluginIds = new Map<string, string>()
  let server: PreviewStaticServer | undefined
  let closing: Promise<number> | undefined
  let requestedExitCode: number | undefined
  let signalCount = 0

  const close = (code: number): Promise<number> => {
    requestedExitCode ??= code
    closing ??= (async () => {
      await sessionReady.promise
      await Promise.all(sessions.map(session => session.close().catch((error: unknown) => {
        options.stderr.write(`[fh2-plugin] 关闭 Preview Build 失败：${messageOf(error)}\n`)
      })))
      await serverReady.promise
      await server?.close().catch((error: unknown) => {
        options.stderr.write(`[fh2-plugin] 关闭 Preview Server 失败：${messageOf(error)}\n`)
      })
      return requestedExitCode!
    })()
    void closing.then(terminated.resolve)
    return closing
  }
  const onSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
    signalCount += 1
    const code = signal === 'SIGINT' ? 130 : 0
    if (signalCount > 1) {
      ;(options.forceExit ?? ((exitCode: number) => process.exit(exitCode)))(code)
      return
    }
    void close(code)
  }
  const onSigint = (): void => onSignal('SIGINT')
  const onSigterm = (): void => onSignal('SIGTERM')
  options.signals.on('SIGINT', onSigint)
  options.signals.on('SIGTERM', onSigterm)

  try {
    try {
      for (const project of parsed.projects) {
        const session = await (options.createRunner ?? createPluginBuildRunner)({
          cwd: project.projectRoot,
          ...(project.configPath === undefined ? {} : { configPath: project.configPath }),
          expectedManifestPath: project.manifestPath,
          includeBackend: false,
          watch: parsed.watch,
          onEvent: (event) => {
            writeBuildEvent(
              options,
              project.projectRoot,
              event.buildId,
              event.type,
              event.diagnostics,
            )
            const expectedPluginId = expectedPluginIds.get(project.projectRoot)
            if (event.type === 'success'
              && expectedPluginId
              && event.distManifest?.id !== expectedPluginId) {
              options.stderr.write(
                `PREVIEW_PLUGIN_ID_CHANGED：${project.projectRoot} 的插件 ID 从 ${expectedPluginId} 变为 ${event.distManifest?.id ?? '<missing>'}，请重启 preview。\n`,
              )
              void close(1)
            }
          },
        })
        sessions.push(session)
        void session.done.then((terminal) => {
          if (terminal.reason === 'fatal') void close(1)
        }, (error: unknown) => {
          options.stderr.write(`[fh2-plugin] Preview Build 异常终止：${messageOf(error)}\n`)
          void close(3)
        })
        await Promise.resolve()
        if (requestedExitCode !== undefined) break
      }
      sessionReady.resolve()
      await Promise.all(sessions.map(session => session.firstBuild))
      if (requestedExitCode !== undefined) {
        serverReady.resolve()
        return await close(requestedExitCode)
      }
    } catch (error) {
      sessionReady.resolve()
      serverReady.resolve()
      for (const project of parsed.projects) {
        if (project.configPath === undefined && basename(project.manifestPath) === PROJECT_PATHS.sourceManifest)
          options.stderr.write(failureLocationHint('preview', project.projectRoot))
      }
      if (error instanceof PluginBuildError) writeDiagnostics(options.stderr, error.diagnostics)
      else options.stderr.write(`[fh2-plugin] preview 构建失败：${messageOf(error)}\n`)
      return await close(error instanceof PluginBuildError ? 1 : 3)
    }

    try {
      const manifests = parsed.projects.map(project => ({
        project,
        manifest: (options.loadSourceManifest ?? loadManifest)(project.manifestPath),
      }))
      const seenPluginIds = new Set<string>()
      for (const { manifest } of manifests) {
        if (seenPluginIds.has(manifest.id)) throw new Error(`Preview 包含重复插件 ID：${manifest.id}`)
        seenPluginIds.add(manifest.id)
      }
      for (const { project, manifest } of manifests) expectedPluginIds.set(project.projectRoot, manifest.id)
      server = await (options.serve ?? servePreviewHttpOriginProxy)({
        plugins: manifests.map(({ project, manifest }) => ({
          pluginId: manifest.id,
          pluginsDir: project.pluginsDir,
        })),
        targetOrigin: target.origin,
        port: parsed.port,
      })
      serverReady.resolve()
      if (requestedExitCode !== undefined) return await close(requestedExitCode)
      const browserUrl = withPluginDebugQuery(target).href
      const pacOutput = server.pacUrl ? `  SwitchyOmega PAC：${server.pacUrl}\n` : ''
      options.onReady?.(browserUrl)
      options.stdout.write(
        `\n✓ 本地前端构建和 HTTP Origin Proxy 已就绪\n`
        + `  插件：${manifests.map(({ manifest }) => manifest.id).join(', ')}\n`
        + `${pacOutput}  调试面板地址：${browserUrl}\n`
        + `  请手动填写的插件来源URL：${server.sourceUrl}\n`
        + `  Build watch：${parsed.watch ? '已开启' : '未开启'}\n`
        + `  1. 在 SwitchyOmega 的 PAC 情景模式中填入上述 PAC 地址，应用并选择该模式，按 PAC 规则自动切换；仅目标 Origin ${target.origin}（协议/主机/端口）经本地受限代理 ${server.url}，其他 Origin 直连。\n`
        + '  2. 在同一 Origin 的司空页面登录并进入项目页，保持本次 Preview 进程运行。\n'
        + '  3. 打开上述完整“调试面板地址”，进入插件调试面板。\n'
        + '  4. 在面板来源输入框中手动填写上述完整“请手动填写的插件来源URL”，不要沿用旧会话来源。\n'
        + '  5. 点击校验，勾选同意，确认后按面板提示重载页面。\n'
        + '  本地来源只提供前端插件产物，不运行或替代真实后端；后端使用目标司空环境已安装版本。只有本次来源路径读取本地产物，页面和业务请求继续转发目标司空环境。\n',
      )
      if (!parsed.noOpen) {
        try {
          await (options.openBrowser ?? openSystemBrowser)(browserUrl)
          options.stdout.write('✓ 已打开浏览器，请完成上述手动步骤。\n')
        } catch (error) {
          options.stderr.write(`BROWSER_OPEN_FAILED：${messageOf(error)}\n请手动打开：${browserUrl}\n`)
        }
      }
      options.stdout.write('按 Ctrl+C 退出预览。\n\n')
    } catch (error) {
      serverReady.resolve()
      options.stderr.write(`[fh2-plugin] Preview Server 启动失败：${messageOf(error)}\n`)
      return await close(1)
    }

    return await terminated.promise
  } finally {
    sessionReady.resolve()
    serverReady.resolve()
    options.signals.off('SIGINT', onSigint)
    options.signals.off('SIGTERM', onSigterm)
  }
}

export function resolvePreviewTarget (value: string): URL {
  const input = value.trim()
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error('司空预览地址必须是完整 HTTP URL')
  }
  if (url.protocol === 'https:') {
    throw new Error('Preview 仅支持完整 HTTP URL，不支持 HTTPS 目标')
  }
  if (url.protocol !== 'http:' || !/^http:\/\/[^/\\]/i.test(input)) {
    throw new Error('司空预览地址必须是完整 HTTP URL')
  }
  if (url.username || url.password) throw new Error('司空预览地址不得包含用户名或密码')
  return url
}

export function withPluginDebugQuery (target: URL): URL {
  const url = new URL(target.href)
  url.searchParams.delete(PREVIEW_SOURCE_QUERY)
  url.searchParams.delete(PREVIEW_SESSION_QUERY)
  url.searchParams.set('fh2-plugin-debug', '1')
  return url
}

async function requestFh2Url (options: PreviewProjectOptions): Promise<string> {
  if (!options.prompt) {
    throw new Error('未提供司空预览地址；交互终端请输入地址，自动化场景请使用 --fh2-url')
  }
  const value = (await options.prompt('请输入司空预览地址：')).trim()
  if (!value) throw new Error('司空预览地址不能为空')
  return value
}

export async function openSystemBrowser (url: string): Promise<void> {
  const command = process.platform === 'darwin'
    ? { file: 'open', args: [url] }
    : process.platform === 'win32'
      ? { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] }
      : { file: 'xdg-open', args: [url] }
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const child = spawn(command.file, command.args, { detached: true, stdio: 'ignore' })
    child.once('error', rejectOpen)
    child.once('spawn', () => {
      child.unref()
      resolveOpen()
    })
  })
}

function writeBuildEvent (
  options: Pick<PreviewProjectOptions, 'stdout' | 'stderr'>,
  projectRoot: string,
  buildId: number,
  type: 'success' | 'failure' | 'fatal',
  diagnostics: readonly BuildDiagnostic[],
): void {
  if (type === 'success') {
    options.stdout.write(`✓ fh2-plugin preview ${projectRoot} build #${buildId} 成功\n`)
  } else {
    options.stderr.write(`[fh2-plugin] preview ${projectRoot} build #${buildId} ${type === 'fatal' ? '致命失败' : '失败'}\n`)
  }
  writeDiagnostics(options.stderr, diagnostics)
}

function writeDiagnostics (writer: OutputWriter, diagnostics: readonly BuildDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    const file = diagnostic.file === undefined ? '' : ` ${diagnostic.file}`
    const hint = diagnostic.hint === undefined ? '' : `\n建议：${diagnostic.hint}`
    writer.write(`${diagnostic.code} [${diagnostic.phase}]${file}\n${diagnostic.message}${hint}\n`)
  }
}

function messageOf (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function deferred<T> (): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolveDeferred) => {
    resolvePromise = resolveDeferred
  })
  return { promise, resolve: resolvePromise }
}
