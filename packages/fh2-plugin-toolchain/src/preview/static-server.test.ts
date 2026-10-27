// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:https'
import type { IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildPreviewCorsHeaders,
  isAllowedPreviewRequest,
  loadPreviewCertificate,
  resolveContainedFile,
  servePreviewStatic,
} from './static-server.js'

const HAS_OPENSSL = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0

describe('preview static server', () => {
  it('只解析插件产物目录内的真实文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-preview-'))
    try {
      await mkdir(join(root, 'assets'))
      await writeFile(join(root, 'assets/plugin.js'), 'export default {}')

      expect(resolveContainedFile(root, 'assets/plugin.js')).toBe(await realpath(join(root, 'assets/plugin.js')))
      expect(resolveContainedFile(root, '../secret')).toBeUndefined()
      expect(resolveContainedFile(root, resolve(root, '..', 'secret'))).toBeUndefined()
      expect(resolveContainedFile(root, 'missing.js')).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('证书文件缺失时返回稳定错误码', async () => {
    await expect(loadPreviewCertificate('/missing/cert.pem', '/missing/key.pem')).rejects.toMatchObject({
      code: 'LOCAL_SOURCE_CERT_UNTRUSTED',
    })
  })

  it('只接受预期 Host 和所选司空 Origin', () => {
    expect(isAllowedPreviewRequest(
      'https://fh2.example',
      'https://fh2.example',
      true,
    )).toBe(true)
    expect(isAllowedPreviewRequest(
      'https://evil.example',
      'https://fh2.example',
      true,
    )).toBe(false)
    expect(isAllowedPreviewRequest(
      'null',
      'https://fh2.example',
      false,
    )).toBe(true)
    expect(isAllowedPreviewRequest(undefined, 'https://fh2.example', false)).toBe(true)
    expect(isAllowedPreviewRequest('https://evil.example', 'https://fh2.example', false)).toBe(false)
  })

  it('返回精确 Origin、Vary 和按需 Private Network 响应头', () => {
    expect(buildPreviewCorsHeaders('https://fh2.example', false)).toEqual({
      'access-control-allow-origin': 'https://fh2.example',
      'cache-control': 'no-store',
      'cross-origin-resource-policy': 'cross-origin',
      vary: 'Origin, Access-Control-Request-Private-Network, Access-Control-Request-Headers',
    })
    expect(buildPreviewCorsHeaders('https://fh2.example', true, 'cache-control, pragma')).toMatchObject({
      'access-control-allow-headers': 'cache-control, pragma',
      'access-control-allow-private-network': 'true',
    })
  })

  it('无证书时使用 HTTP loopback，仍保留 Origin 与 Private Network 校验', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-preview-http-'))
    try {
      const dist = join(root, 'dist')
      await mkdir(dist)
      await writeFile(join(dist, 'fh2-plugin.json'), '{"id":"exp_http"}')
      const server = await servePreviewStatic({
        plugins: [{ pluginId: 'exp_http', pluginsDir: dist }],
        targetOrigin: 'http://fh2-preview.example.com',
        port: 0,
        sessionToken: '0123456789abcdef0123456789abcdef',
      })
      try {
        expect(server.sourceUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/0123456789abcdef0123456789abcdef\/plugins$/)
        const metadata = await fetch(`${server.sourceUrl}/__fh2_plugin_preview__.json`, {
          headers: { origin: 'http://fh2-preview.example.com' },
        })
        expect(metadata.status).toBe(200)
        expect(metadata.headers.get('access-control-allow-origin')).toBe('http://fh2-preview.example.com')
        // “校验本地插件”首先请求 metadata；该路径必须正确响应 PNA 预检。
        const preflight = await fetch(`${server.sourceUrl}/__fh2_plugin_preview__.json`, {
          method: 'OPTIONS',
          headers: {
            origin: 'http://fh2-preview.example.com',
            'access-control-request-method': 'GET',
            'access-control-request-headers': 'cache-control, pragma',
            'access-control-request-private-network': 'true',
          },
        })
        expect(preflight.status).toBe(204)
        expect(preflight.headers.get('access-control-allow-origin')).toBe('http://fh2-preview.example.com')
        expect(preflight.headers.get('access-control-allow-headers')).toBe('cache-control, pragma')
        expect(preflight.headers.get('access-control-allow-private-network')).toBe('true')
      } finally {
        await server.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.runIf(HAS_OPENSSL)('真实 HTTPS 服务隔离会话路径、Origin 与 Private Network 请求', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-preview-https-'))
    try {
      const dist = join(root, 'dist')
      const secondDist = join(root, 'second-dist')
      const certPath = join(root, 'localhost.pem')
      const keyPath = join(root, 'localhost-key.pem')
      await mkdir(dist)
      await mkdir(secondDist)
      await writeFile(join(dist, 'fh2-plugin.json'), '{"id":"exp_preview"}')
      await writeFile(join(secondDist, 'fh2-plugin.json'), '{"id":"exp_second"}')
      await writeFile(join(dist, 'view.css'), '.preview {}')
      await writeFile(join(dist, 'asset.bin'), 'binary fixture')
      execFileSync('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1,DNS:localhost',
      ], { stdio: 'ignore' })
      const certificate = await loadPreviewCertificate(certPath, keyPath)
      const server = await servePreviewStatic({
        plugins: [
          { pluginId: 'exp_preview', pluginsDir: dist },
          { pluginId: 'exp_second', pluginsDir: secondDist },
        ],
        targetOrigin: 'https://fh2.example',
        port: 0,
        certificate,
        sessionToken: '0123456789abcdef0123456789abcdef',
      })
      try {
        expect(server.sourceUrl).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/0123456789abcdef0123456789abcdef\/plugins$/)
        const metadata = await httpsRequest(`${server.sourceUrl}/__fh2_plugin_preview__.json`, {
          origin: 'https://fh2.example',
        })
        expect(metadata.status).toBe(200)
        expect(JSON.parse(metadata.body)).toEqual({
          schemaVersion: 1,
          plugins: [{
            pluginId: 'exp_preview',
            manifestPath: './exp_preview/fh2-plugin.json',
          }, {
            pluginId: 'exp_second',
            manifestPath: './exp_second/fh2-plugin.json',
          }],
        })
        expect((await httpsRequest(`${server.sourceUrl}/__fh2_plugin_preview__.json`, {
          origin: 'https://evil.example',
        })).status).toBe(403)
        const iframeManifest = await httpsRequest(`${server.sourceUrl}/exp_preview/fh2-plugin.json`, {
          origin: 'null',
        })
        expect(iframeManifest.status).toBe(200)
        expect(iframeManifest.headers['access-control-allow-origin']).toBe('null')
        expect((await httpsRequest(`${server.sourceUrl}/exp_second/fh2-plugin.json`, {
          origin: 'null',
        })).status).toBe(200)
        expect((await httpsRequest(`${server.sourceUrl}/exp_preview/view.css`, {
          origin: undefined,
        })).status).toBe(200)
        expect((await httpsRequest(`${server.sourceUrl}/exp_preview/asset.bin`, {
          origin: undefined,
        })).status).toBe(200)
        const preflight = await httpsRequest(`${server.sourceUrl}/exp_preview/fh2-plugin.json`, {
          origin: 'null',
          method: 'OPTIONS',
          privateNetwork: true,
        })
        expect(preflight.status).toBe(204)
        expect(preflight.headers['access-control-allow-private-network']).toBe('true')
        expect((await httpsRequest(`${server.url}/wrong/plugins/exp_preview/fh2-plugin.json`, {
          origin: 'null',
        })).status).toBe(404)
      } finally {
        await server.close()
        await server.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function httpsRequest (
  url: string,
  options: { readonly origin: string | undefined; readonly method?: 'GET' | 'OPTIONS'; readonly privateNetwork?: boolean },
): Promise<{ readonly status: number; readonly headers: IncomingHttpHeaders; readonly body: string }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = request(url, {
      method: options.method ?? 'GET',
      rejectUnauthorized: false,
      headers: {
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(options.privateNetwork ? { 'access-control-request-private-network': 'true' } : {}),
      },
    }, (res) => {
      res.setEncoding('utf8')
      let body = ''
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => resolveRequest({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.once('error', rejectRequest)
    req.end()
  })
}
