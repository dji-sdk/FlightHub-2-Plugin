// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { createMockGateway } from './gateway.js'
import type { DevGateway, GatewayApiMode } from './gateway.js'
import { closeRequestAfterResponse } from './http-lifecycle.js'

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

const LIVE_RELOAD_PATH = '/__live_reload__'
const DEV_CONFIG_PATH = '/__fh2_dev_config__'
const PLUGIN_CATALOG_PATH = '/__fh2_plugin_catalog__'
const TOKEN_PATH = '/plugin-gateway/token/issue'
const API_PREFIX = '/plugin-api/'

/**
 * Mock Workbench 固定组织/项目 ID（写死的 Mock UUID，对齐真实司空
 * `/organization/{orgId}/project/{projectId}` URL 形态）。
 * 浏览器侧不能反向 import 本包，固定标识由 CLI 与浏览器各自持有并保持一致。
 */
export const MOCK_WORKBENCH_ORGANIZATION_ID = '5f7d5bcc-63f2-4b3d-a5ef-3d179c43f8aa'
export const MOCK_WORKBENCH_PROJECT_ID = '1692f455-5dc7-4ca6-887e-07d0d1f69246'

/** 固定 Mock scope 的路径段（dev 启动打印/打开的默认入口）。 */
export const WORKBENCH_SCOPE_PATH = `/organization/${MOCK_WORKBENCH_ORGANIZATION_ID}/project/${MOCK_WORKBENCH_PROJECT_ID}`

/** 任意组织/项目 scope 路径（history fallback：命中即回 Shell index.html）。 */
const WORKBENCH_SCOPE_PATH_PATTERN = /^\/organization\/[^/]+\/project\/[^/]+\/?$/

/** Workbench 入口 URL（hash 按 Workbench 模式取默认页）。 */
export function workbenchEntryUrl (origin: string, workbenchMode: 'all' | 'cockpit' = 'all'): string {
  return `${origin}${WORKBENCH_SCOPE_PATH}#${workbenchMode === 'cockpit' ? '/cockpit' : '/team'}`
}

const LIVE_RELOAD_SCRIPT = `<script>(function(){
if(typeof EventSource==='undefined')return;
var source=new EventSource('${LIVE_RELOAD_PATH}');
var handled={};
function reload(){location.reload();}
source.addEventListener('build',function(event){
  var build;
  try{build=JSON.parse(event.data);}catch(error){console.warn('[FH2_DEV_EVENT_INVALID]',error);return;}
  if(!build||build.schemaVersion!==1||handled[build.buildId])return;
  handled[build.buildId]=true;
  if(build.type==='error'){
    window.dispatchEvent(new CustomEvent('fh2-dev-build-error',{detail:{buildId:build.buildId,message:build.message}}));
    return;
  }
  if(build.type!=='reload')return;
  source.close();
  var hook=window.__FH2_DEV_RELOAD__;
  if(typeof hook!=='function'){
    console.warn('[FH2_DEV_RELOAD_HOOK_MISSING] Workbench reload hook is unavailable');
    reload();
    return;
  }
  var timeout;
  Promise.race([
    Promise.resolve().then(function(){return hook();}),
    new Promise(function(resolve){timeout=setTimeout(function(){console.warn('[FH2_DEV_RELOAD_TIMEOUT] Workbench cleanup exceeded 5000ms');resolve();},5000);})
  ]).catch(function(error){console.warn('[FH2_DEV_RELOAD_FAILED]',error);}).then(function(){clearTimeout(timeout);reload();});
});
source.onerror=function(){if(source.readyState===EventSource.CLOSED)source.close();};
})();</script></head>`.replace(/\n/g, '')

export type DevBuildEvent = {
  readonly schemaVersion: 1;
  readonly type: 'reload';
  readonly buildId: number;
} | {
  readonly schemaVersion: 1;
  readonly type: 'error';
  readonly buildId: number;
  readonly diagnosticCode: string;
}

export interface DevStaticServerOptions {
  readonly shellDist: string;
  readonly vue3Dist: string;
  readonly vue2Dist: string;
  readonly pluginsDir: string | readonly string[];
  readonly pluginCatalog?: readonly DevPluginCatalogEntry[];
  readonly workbenchMode?: 'all' | 'cockpit';
  readonly backendMode?: 'frontend' | 'fullstack';
  readonly port: number;
  readonly watch?: boolean;
  readonly gateway?: DevGateway;
}

export interface DevPluginCatalogEntry {
  readonly pluginId: string;
  readonly root: string;
}

export interface DevStaticServer {
  readonly url: string;
  readonly apiMode: GatewayApiMode;
  publishBuildEvent(event: DevBuildEvent): void;
  close(): Promise<void>;
}

export async function serveStatic (options: DevStaticServerOptions): Promise<DevStaticServer> {
  assertWorkbenchAssets(options)
  const gateway = options.gateway ?? createMockGateway()
  const sseClients = new Set<ServerResponse>()
  const seenBuildIds = new Set<number>()
  let closing = false
  let closePromise: Promise<void> | undefined
  let serverOrigin = ''
  let expectedHost = ''

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestUrl = new URL(req.url ?? '/', 'http://fh2-plugin.local')
    const urlPath = requestUrl.pathname

    if (urlPath === TOKEN_PATH || urlPath.startsWith(API_PREFIX)) {
      if (!isAllowedGatewayRequest(req, serverOrigin, expectedHost)) {
        closeRequestAfterResponse(req, res)
        sendJson(res, 403, { code: 40300, msg: 'Forbidden', data: null })
        return
      }
    }
    if (await gateway.handle(req, res, requestUrl)) return

    if (urlPath === DEV_CONFIG_PATH) {
      sendJson(res, 200, {
        apiMode: gateway.apiMode,
        workbenchMode: options.workbenchMode ?? 'all',
        backendMode: options.backendMode ?? 'frontend',
      }, { 'cache-control': 'no-store' })
      return
    }

    if (urlPath === PLUGIN_CATALOG_PATH) {
      if (options.pluginCatalog === undefined || options.pluginCatalog.length === 0) {
        res.writeHead(204, { ...pluginCorsHeaders(req), 'cache-control': 'no-store' })
        res.end()
        return
      }
      sendJson(res, 200, {
        plugins: options.pluginCatalog.map(plugin => ({
          pluginId: plugin.pluginId,
          baseUrl: `/plugins/${plugin.pluginId}/`,
        })),
      }, { ...pluginCorsHeaders(req), 'cache-control': 'no-store' })
      return
    }

    if (urlPath === LIVE_RELOAD_PATH && options.watch) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      sseClients.add(res)
      req.once('close', () => sseClients.delete(res))
      return
    }

    // 根路径重定向到固定 scope 路径（对齐真实司空 /organization/{orgId}/project/{projectId}
    // 形态；hash 由 Location 携带，浏览器跟随后落到默认团队页）。静态资源/子应用/插件路径不受影响。
    if (urlPath === '/') {
      res.writeHead(302, { location: `${WORKBENCH_SCOPE_PATH}${requestUrl.search}#/team` })
      res.end()
      return
    }

    const isPluginResource = urlPath.startsWith('/plugins/')
    if (isPluginResource && req.method === 'OPTIONS') {
      res.writeHead(204, pluginCorsHeaders(req))
      res.end()
      return
    }

    let mapped: MappedPath | undefined
    try {
      mapped = mapPath(options, urlPath)
    } catch (error) {
      const status = error instanceof URIError ? 400 : 404
      sendText(res, status, status === 400 ? '400 Bad Request' : '404 Not Found')
      return
    }
    const staticHeaders: Record<string, string> = isPluginResource
      ? pluginCorsHeaders(req)
      : {}
    if (isPluginManifestPath(urlPath)) staticHeaders['cache-control'] = 'no-store'

    if (mapped?.file === undefined) {
      if (urlPath === '/plugins/fh2-plugin.json' || urlPath === '/favicon.ico') {
        res.writeHead(204, staticHeaders)
        res.end()
        return
      }
      sendText(res, 404, '404 Not Found', staticHeaders)
      return
    }

    let content = await readFile(mapped.file)
    if (mapped.injectReload && options.watch) {
      const html = content.toString('utf8')
      if (html.includes('</head>')) content = Buffer.from(html.replace('</head>', LIVE_RELOAD_SCRIPT), 'utf8')
    }
    res.writeHead(200, { 'content-type': mapped.mime, ...staticHeaders })
    res.end(content)
  }

  const server = createHttpServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      if (res.destroyed || res.writableEnded) return
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('500 Internal Server Error')
    })
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === 'EADDRINUSE') {
        rejectListen(new Error(`端口 ${options.port} 被占用，请释放或用 --port 指定其他端口`))
      } else {
        rejectListen(error)
      }
    }
    server.once('error', onError)
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', onError)
      resolveListen()
    })
  })

  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : options.port
  const serverAddress = resolveLoopbackServerAddress(actualPort)
  expectedHost = serverAddress.host
  serverOrigin = serverAddress.origin

  return {
    url: serverOrigin,
    apiMode: gateway.apiMode,
    publishBuildEvent (event) {
      if (closing || !options.watch || seenBuildIds.has(event.buildId)) return
      seenBuildIds.add(event.buildId)
      const wireEvent = event.type === 'error'
        ? {
            schemaVersion: 1,
            type: 'error',
            buildId: event.buildId,
            message: `${stableDiagnosticCode(event.diagnosticCode)}：插件构建失败，请查看终端诊断。`,
          }
        : event
      const payload = `event: build\ndata: ${JSON.stringify(wireEvent)}\n\n`
      for (const client of [...sseClients]) {
        try {
          client.write(payload)
        } catch {
          sseClients.delete(client)
        }
      }
    },
    close () {
      if (closePromise !== undefined) return closePromise
      closing = true
      closePromise = (async () => {
        await gateway.close()
        for (const client of sseClients) client.end()
        sseClients.clear()
        if (!server.listening) return
        await new Promise<void>((resolveClose, rejectClose) => {
          server.close(error => error === undefined ? resolveClose() : rejectClose(error))
          server.closeAllConnections()
        })
      })()
      return closePromise
    },
  }
}

function pluginCorsHeaders (req: IncomingMessage): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    vary: 'Origin, Access-Control-Request-Private-Network',
    ...(singleHeader(req.headers['access-control-request-private-network']) === 'true'
      ? { 'access-control-allow-private-network': 'true' }
      : {}),
  }
}

interface MappedPath {
  readonly file?: string;
  readonly mime: string;
  readonly injectReload?: boolean;
}

function mapPath (options: DevStaticServerOptions, urlPath: string): MappedPath | undefined {
  const decoded = decodeURIComponent(urlPath)
  // scope 路径 history fallback：整份 Shell index.html（含 hash 路由，无需服务端按路径区分）。
  if (WORKBENCH_SCOPE_PATH_PATTERN.test(decoded)) {
    return {
      file: resolve(options.shellDist, 'index.html'),
      mime: MIME['.html']!,
      injectReload: true,
    }
  }
  if (decoded === '/favicon.ico' || decoded.startsWith('/assets/') || decoded.startsWith('/static/')) {
    return serveFrom(options.shellDist, decoded.slice(1))
  }
  if (decoded.startsWith('/apps/mock-host-vue3/')) {
    return serveFrom(options.vue3Dist, decoded.slice('/apps/mock-host-vue3/'.length) || 'container.html')
  }
  if (decoded.startsWith('/apps/mock-host-vue2/')) {
    return serveFrom(options.vue2Dist, decoded.slice('/apps/mock-host-vue2/'.length) || 'container.html')
  }
  if (decoded.startsWith('/plugins/')) {
    const relative = decoded.slice('/plugins/'.length)
    for (const plugin of options.pluginCatalog ?? []) {
      const prefix = `${plugin.pluginId}/`
      if (relative.startsWith(prefix)) return serveFrom(plugin.root, relative.slice(prefix.length))
    }
    // 多根目录：按声明顺序取第一个命中的根
    const roots = typeof options.pluginsDir === 'string' ? [options.pluginsDir] : options.pluginsDir
    for (const root of roots) {
      const hit = serveFrom(root, relative)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  return undefined
}

function serveFrom (root: string, relativePath: string): MappedPath | undefined {
  const safe = normalize(relativePath)
  if (isAbsolute(safe)) return undefined
  const normalizedRoot = resolve(root)
  const candidate = resolve(normalizedRoot, safe)
  if (!isContained(normalizedRoot, candidate) || !existsSync(candidate)) return undefined
  let realRoot: string
  let realCandidate: string
  try {
    realRoot = realpathSync(normalizedRoot)
    realCandidate = realpathSync(candidate)
    if (!statSync(realCandidate).isFile()) return undefined
  } catch {
    return undefined
  }
  if (!isContained(realRoot, realCandidate)) return undefined
  return { file: realCandidate, mime: MIME[extname(realCandidate).toLowerCase()] ?? 'application/octet-stream' }
}

function isContained (root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
}

function isAllowedGatewayRequest (req: IncomingMessage, serverOrigin: string, expectedHost: string): boolean {
  if (req.headers.host !== expectedHost) return false
  const origin = singleHeader(req.headers.origin)
  const fetchSite = singleHeader(req.headers['sec-fetch-site'])
  if (origin !== undefined && origin !== serverOrigin) return false
  if (fetchSite !== undefined && fetchSite !== 'same-origin') return false
  return origin === serverOrigin || fetchSite === 'same-origin'
}

function singleHeader (value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function isPluginManifestPath (urlPath: string): boolean {
  return urlPath.startsWith('/plugins/') && urlPath.endsWith('/fh2-plugin.json')
}

function stableDiagnosticCode (code: string): string {
  return /^[A-Z][A-Z0-9_]*$/.test(code) ? code : 'FH2_BUILD_FAILED'
}

export function resolveLoopbackServerAddress (port: number): { readonly host: string; readonly origin: string } {
  const url = new URL(`http://127.0.0.1:${port}`)
  return { host: url.host, origin: url.origin }
}

function assertWorkbenchAssets (options: DevStaticServerOptions): void {
  const required = [
    resolve(options.shellDist, 'index.html'),
    resolve(options.vue3Dist, 'container.html'),
    resolve(options.vue2Dist, 'container.html'),
  ]
  for (const file of required) {
    try {
      if (statSync(file).isFile()) continue
    } catch {}
    throw new Error(`Workbench 发布资源缺失：${file}`)
  }
  const pluginRoots = typeof options.pluginsDir === 'string' ? [options.pluginsDir] : options.pluginsDir
  const missing: string[] = []
  for (const root of pluginRoots) {
    try {
      if (statSync(root).isDirectory()) continue
    } catch {}
    missing.push(root)
  }
  if (missing.length > 0) throw new Error(`插件产物目录不存在：${missing.join(', ')}`)
}

function sendJson (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(body))
}

function sendText (
  res: ServerResponse,
  status: number,
  body: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers })
  res.end(body)
}
