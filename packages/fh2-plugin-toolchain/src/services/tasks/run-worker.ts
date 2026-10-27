// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import process from 'node:process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { discoverCapabilityFrontendOnly } from '../../capability/discovery.js'
import { devProject } from '../application/dev.js'
import { previewProject } from '../application/preview.js'

// 内部执行入口：业务输入与 ready 走 IPC，stdout/stderr 只承载日志。
process.once('message', (message: { kind: 'dev' | 'preview'; root: string; params: Record<string, string | number | boolean> }) => {
  const { root, params, kind } = message
  const options = {
    cwd: root,
    stdout: process.stdout,
    stderr: process.stderr,
    signals: process,
    onReady: (url: string) => process.send?.({ type: 'ready', url }),
  }
  const run = async (): Promise<number> => {
    if (kind === 'dev') {
      return devProject({
        root,
        projectRoot: root,
        manifestPath: resolve(root, 'fh2-plugin.json'),
        workbenchMode: 'all',
        pluginsDir: [resolve(root, 'dist')],
        port: Number(params.port ?? 5175),
        watch: true,
        frontendOnly: false,
        help: false,
      }, options)
    }
    const projects = existsSync(resolve(root, 'capabilities.json'))
      ? discoverCapabilityFrontendOnly(root).frontend.map(project => ({ projectRoot: project.root, manifestPath: project.manifestPath, pluginsDir: resolve(project.root, 'dist') }))
      : [{ projectRoot: root, manifestPath: resolve(root, 'fh2-plugin.json'), pluginsDir: resolve(root, 'dist') }]
    return previewProject({
      projects,
      port: Number(params.port ?? 4317),
      watch: true,
      noOpen: true,
      help: false,
      fh2Url: String(params.target ?? ''),
    }, options)
  }
  void run().then(code => process.exit(code), (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
})
process.on('disconnect', () => process.kill(process.pid, 'SIGTERM'))
