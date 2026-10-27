// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { Buffer } from 'node:buffer'
import { X509Certificate, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createHttpServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { createSecureContext } from 'node:tls'

const MIME: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}
export const PREVIEW_METADATA_FILE = '__fh2_plugin_preview__.json'

export interface PreviewCertificate {
  readonly cert: Buffer;
  readonly key: Buffer;
}

export interface PreviewStaticServerOptions {
  readonly plugins: readonly PreviewPluginSource[];
  readonly targetOrigin: string;
  readonly port: number;
  /** 有证书时使用 HTTPS；缺省时使用仅监听 loopback 的 HTTP。 */
  readonly certificate?: PreviewCertificate;
  readonly sessionToken?: string;
}

export interface PreviewPluginSource {
  readonly pluginId: string;
  readonly pluginsDir: string;
}

export interface PreviewStaticServer {
  readonly url: string;
  readonly sourceUrl: string;
  readonly sessionToken: string;
  readonly pacUrl?: string;
  close(): Promise<void>;
}

export class PreviewCertificateError extends Error {
  readonly code = 'LOCAL_SOURCE_CERT_UNTRUSTED'

  constructor (message: string) {
    super(message)
    this.name = 'PreviewCertificateError'
  }
}

export async function loadPreviewCertificate (certPath: string, keyPath: string): Promise<PreviewCertificate> {
  let cert: Buffer
  let key: Buffer
  try {
    ;[cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)])
  } catch {
    throw new PreviewCertificateError(
      `本地 HTTPS 证书不可用。请准备受信任证书：${certPath} 和 ${keyPath}`,
    )
  }

  try {
    const certificate = new X509Certificate(cert)
    const privateKey = createPrivateKey(key)
    if (!certificate.checkIP('127.0.0.1')) {
      throw new Error('证书不包含 127.0.0.1')
    }
    const now = Date.now()
    if (now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo)) {
      throw new Error('证书尚未生效或已经过期')
    }
    const certificatePublicKey = certificate.publicKey.export({ type: 'spki', format: 'der' })
    const privatePublicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
    if (!certificatePublicKey.equals(privatePublicKey)) throw new Error('证书与私钥不匹配')
    createSecureContext({ cert, key })
  } catch (error) {
    throw new PreviewCertificateError(`本地 HTTPS 证书无效：${messageOf(error)}`)
  }
  return { cert, key }
}

export async function servePreviewStatic (options: PreviewStaticServerOptions): Promise<PreviewStaticServer> {
  assertPreviewPluginAssets(options.plugins)
  const sessionToken = options.sessionToken ?? randomBytes(16).toString('hex')
  if (!/^[a-f0-9]{32}$/.test(sessionToken)) throw new Error('Preview session token 格式无效')
  const sourcePath = `/${sessionToken}/plugins`
  let expectedHost = ''

  const requestListener = (req: IncomingMessage, res: ServerResponse): void => {
    void handleRequest(options, expectedHost, sourcePath, req, res).catch(() => {
      if (res.destroyed || res.writableEnded) return
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('500 Internal Server Error')
    })
  }
  const server = options.certificate === undefined
    ? createHttpServer(requestListener)
    : createHttpsServer(options.certificate, requestListener)

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      rejectListen(error.code === 'EADDRINUSE'
        ? new Error(`端口 ${options.port} 被占用，请释放或用 --port 指定其他端口`)
        : error)
    }
    server.once('error', onError)
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', onError)
      resolveListen()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  expectedHost = `127.0.0.1:${port}`
  const protocol = options.certificate === undefined ? 'http' : 'https'
  const url = `${protocol}://${expectedHost}`
  let closePromise: Promise<void> | undefined

  return {
    url,
    sourceUrl: `${url}${sourcePath}`,
    sessionToken,
    close () {
      closePromise ??= new Promise<void>((resolveClose, rejectClose) => {
        if (!server.listening) {
          resolveClose()
          return
        }
        server.close(error => error === undefined ? resolveClose() : rejectClose(error))
        server.closeAllConnections()
      })
      return closePromise
    },
  }
}

async function handleRequest (
  options: PreviewStaticServerOptions,
  expectedHost: string,
  sourcePath: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.headers.host !== expectedHost) {
    sendText(res, 403, '403 Forbidden')
    return
  }
  const requestUrl = new URL(req.url ?? '/', 'https://fh2-plugin.local')
  await handlePreviewResource(options, sourcePath, requestUrl, req, res)
}

export async function handlePreviewResource (
  options: Pick<PreviewStaticServerOptions, 'plugins' | 'targetOrigin'>,
  sourcePath: string,
  requestUrl: URL,
  req: IncomingMessage,
  res: ServerResponse,
  allowMissingMetadataOrigin = false,
): Promise<void> {
  const origin = singleHeader(req.headers.origin)
  const metadataPath = `${sourcePath}/${PREVIEW_METADATA_FILE}`
  const metadataRequest = requestUrl.pathname === metadataPath
  if (!isAllowedPreviewRequest(origin, options.targetOrigin, metadataRequest)
    && !(allowMissingMetadataOrigin && metadataRequest && origin === undefined)) {
    sendText(res, 403, '403 Forbidden', { vary: 'Origin' })
    return
  }

  const corsHeaders = buildPreviewCorsHeaders(
    origin,
    singleHeader(req.headers['access-control-request-private-network']) === 'true',
    singleHeader(req.headers['access-control-request-headers']),
  )
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...corsHeaders,
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    })
    res.end()
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, '405 Method Not Allowed', corsHeaders)
    return
  }

  if (metadataRequest) {
    sendJson(res, 200, {
      schemaVersion: 1,
      plugins: options.plugins.map(plugin => ({
        pluginId: plugin.pluginId,
        manifestPath: `./${plugin.pluginId}/fh2-plugin.json`,
      })),
    }, corsHeaders, req.method === 'HEAD')
    return
  }

  const plugin = options.plugins.find(candidate => requestUrl.pathname.startsWith(
    `${sourcePath}/${encodeURIComponent(candidate.pluginId)}/`,
  ))
  if (!plugin) {
    sendText(res, 404, '404 Not Found', corsHeaders)
    return
  }
  const pluginPrefix = `${sourcePath}/${encodeURIComponent(plugin.pluginId)}/`
  let relativePath: string
  try {
    relativePath = decodeURIComponent(requestUrl.pathname.slice(pluginPrefix.length))
  } catch {
    sendText(res, 400, '400 Bad Request', corsHeaders)
    return
  }
  const file = resolveContainedFile(plugin.pluginsDir, relativePath)
  if (!file) {
    sendText(res, 404, '404 Not Found', corsHeaders)
    return
  }
  const content = await readFile(file)
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    ...corsHeaders,
  })
  res.end(req.method === 'HEAD' ? undefined : content)
}

export function resolveContainedFile (root: string, relativePath: string): string | undefined {
  if (!relativePath || relativePath.includes('\0')) return undefined
  const safe = normalize(relativePath)
  if (isAbsolute(safe)) return undefined
  const normalizedRoot = resolve(root)
  const candidate = resolve(normalizedRoot, safe)
  if (!isContained(normalizedRoot, candidate) || !existsSync(candidate)) return undefined
  try {
    const realRoot = realpathSync(normalizedRoot)
    const realCandidate = realpathSync(candidate)
    return statSync(realCandidate).isFile() && isContained(realRoot, realCandidate)
      ? realCandidate
      : undefined
  } catch {
    return undefined
  }
}

export function isAllowedPreviewRequest (
  requestOrigin: string | undefined,
  targetOrigin: string,
  metadataRequest: boolean,
): boolean {
  if (metadataRequest) return requestOrigin === targetOrigin
  return requestOrigin === undefined || requestOrigin === targetOrigin || requestOrigin === 'null'
}

export function buildPreviewCorsHeaders (
  requestOrigin: string | undefined,
  privateNetworkRequest: boolean,
  requestedHeaders?: string,
): Readonly<Record<string, string>> {
  return {
    'cache-control': 'no-store',
    'cross-origin-resource-policy': 'cross-origin',
    vary: 'Origin, Access-Control-Request-Private-Network, Access-Control-Request-Headers',
    ...(requestOrigin === undefined ? {} : { 'access-control-allow-origin': requestOrigin }),
    ...(privateNetworkRequest ? { 'access-control-allow-private-network': 'true' } : {}),
    ...(requestedHeaders === undefined || requestedHeaders.trim() === ''
      ? {}
      : { 'access-control-allow-headers': requestedHeaders }),
  }
}

function isContained (root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
}

export function assertPreviewPluginAssets (plugins: readonly PreviewPluginSource[]): void {
  if (plugins.length === 0) throw new Error('Preview 至少需要一个插件')
  const seen = new Set<string>()
  for (const plugin of plugins) {
    if (seen.has(plugin.pluginId)) throw new Error(`Preview 包含重复插件 ID：${plugin.pluginId}`)
    seen.add(plugin.pluginId)
    try {
      if (statSync(resolve(plugin.pluginsDir, 'fh2-plugin.json')).isFile()) continue
    } catch {}
    throw new Error(`插件构建产物缺失：${resolve(plugin.pluginsDir, 'fh2-plugin.json')}`)
  }
}

function singleHeader (value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function sendJson (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>>,
  head: boolean,
): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(head ? undefined : JSON.stringify(body))
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

function messageOf (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
