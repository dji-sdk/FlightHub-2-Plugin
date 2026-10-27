// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { createServer, request as requestHttp } from 'node:http'
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import {
  assertPreviewPluginAssets,
  handlePreviewResource,
} from './static-server.js'
import type {
  PreviewStaticServer,
  PreviewStaticServerOptions,
} from './static-server.js'

const PREVIEW_PROXY_PATH = '/.fh2-plugin-preview'
const PAC_PATH = '/proxy.pac'
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

export async function servePreviewHttpOriginProxy (
  options: PreviewStaticServerOptions,
): Promise<PreviewStaticServer> {
  assertPreviewPluginAssets(options.plugins)
  const target = new URL(options.targetOrigin)
  if (target.protocol !== 'http:' || target.origin !== options.targetOrigin) {
    throw new Error('HTTP Preview Proxy 目标必须是完整 HTTP Origin')
  }
  const sessionToken = options.sessionToken ?? randomBytes(16).toString('hex')
  if (!/^[a-f0-9]{32}$/.test(sessionToken)) throw new Error('Preview session token 格式无效')
  const sourcePath = `${PREVIEW_PROXY_PATH}/${sessionToken}/plugins`
  const activeUpstreams = new Set<ClientRequest>()
  let proxyHost = ''

  const server = createServer((req, res) => {
    void handleProxyRequest(options, target, proxyHost, sourcePath, activeUpstreams, req, res).catch(() => {
      if (res.destroyed || res.writableEnded) return
      sendText(res, 500, '500 Internal Server Error')
    })
  })
  server.on('connect', (_req, socket) => rejectConnect(socket))

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
  proxyHost = `127.0.0.1:${port}`
  const url = `http://${proxyHost}`
  let closePromise: Promise<void> | undefined

  return {
    url,
    sourceUrl: `${target.origin}${sourcePath}`,
    sessionToken,
    pacUrl: `${url}${PAC_PATH}?session=${sessionToken}`,
    close () {
      closePromise ??= new Promise<void>((resolveClose, rejectClose) => {
        if (!server.listening) {
          resolveClose()
          return
        }
        for (const upstream of activeUpstreams) upstream.destroy()
        server.close(error => error === undefined ? resolveClose() : rejectClose(error))
        server.closeAllConnections()
      })
      return closePromise
    },
  }
}

async function handleProxyRequest (
  options: PreviewStaticServerOptions,
  target: URL,
  proxyHost: string,
  sourcePath: string,
  activeUpstreams: Set<ClientRequest>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.headers.host === proxyHost && requestPath(req.url) === PAC_PATH) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, '405 Method Not Allowed')
      return
    }
    const body = createProxyPac(target.origin, proxyHost)
    res.writeHead(200, {
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
      'content-type': 'application/x-ns-proxy-autoconfig; charset=utf-8',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
    return
  }

  const requestUrl = parseAbsoluteHttpUrl(req.url)
  if (!requestUrl || requestUrl.origin !== target.origin) {
    sendText(res, 403, '403 Forbidden')
    return
  }
  if (requestUrl.pathname === sourcePath || requestUrl.pathname.startsWith(`${sourcePath}/`)) {
    await handlePreviewResource(options, sourcePath, requestUrl, req, res, true)
    return
  }
  await forwardToTarget(target, requestUrl, activeUpstreams, req, res)
}

export function createProxyPac (targetOrigin: string, proxyHost: string): string {
  const origin = JSON.stringify(targetOrigin)
  const proxy = JSON.stringify(`PROXY ${proxyHost}`)
  return `function FindProxyForURL(url, host) {\n`
    + `  var origin = ${origin};\n`
    + `  if (url === origin || url.indexOf(origin + "/") === 0) return ${proxy};\n`
    + '  return "DIRECT";\n'
    + '}\n'
}

async function forwardToTarget (
  target: URL,
  requestUrl: URL,
  activeUpstreams: Set<ClientRequest>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  await new Promise<void>((resolveForward, rejectForward) => {
    const upstream = requestHttp(requestUrl, {
      method: req.method,
      headers: sanitizeHeaders(req.headers, target.host),
    }, (upstreamResponse) => {
      const headers = sanitizeHeaders(upstreamResponse.headers)
      if (req.headers['sec-fetch-dest'] === 'document'
        || upstreamResponse.headers['content-type']?.includes('text/html')) {
        headers['cache-control'] = 'no-store'
      }
      res.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage ?? '',
        headers,
      )
      upstreamResponse.once('error', rejectForward)
      upstreamResponse.once('end', resolveForward)
      upstreamResponse.pipe(res)
    })
    activeUpstreams.add(upstream)
    const abortUpstream = (): void => {
      if (!res.writableEnded) upstream.destroy()
    }
    upstream.once('close', () => {
      activeUpstreams.delete(upstream)
      res.off('close', abortUpstream)
    })
    upstream.once('error', rejectForward)
    req.once('aborted', () => upstream.destroy())
    res.once('close', abortUpstream)
    req.pipe(upstream)
  }).catch((error: unknown) => {
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : undefined)
      return
    }
    sendText(res, 502, '502 Bad Gateway')
  })
}

function sanitizeHeaders (headers: IncomingHttpHeaders, host?: string): IncomingHttpHeaders {
  const connectionHeaders = new Set(
    typeof headers.connection === 'string'
      ? headers.connection.split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
      : [],
  )
  const sanitized: IncomingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase()
    if (normalizedName === 'host'
      || HOP_BY_HOP_HEADERS.has(normalizedName)
      || connectionHeaders.has(normalizedName)
      || value === undefined) {
      continue
    }
    sanitized[name] = value
  }
  if (host) sanitized.host = host
  return sanitized
}

function parseAbsoluteHttpUrl (value: string | undefined): URL | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' ? url : undefined
  } catch {
    return undefined
  }
}

function requestPath (value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return new URL(value, 'http://fh2-preview-proxy.local').pathname
  } catch {
    return undefined
  }
}

function rejectConnect (socket: Duplex): void {
  socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
}

function sendText (res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-length': Buffer.byteLength(body),
    'content-type': 'text/plain; charset=utf-8',
  })
  res.end(body)
}
