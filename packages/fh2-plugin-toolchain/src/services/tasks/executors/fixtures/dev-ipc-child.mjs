#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/** T5 IPC fixture：上报 ready URL，等待父进程 SIGTERM。 */
import process from 'node:process'
import { fork } from 'node:child_process'

if (process.argv.includes('--descendant')) {
  process.on('SIGTERM', () => undefined)
  process.send?.({ type: 'started' })
} else {
  process.once('message', (message) => {
    const ready = () => process.send?.({ type: 'ready', url: 'http://127.0.0.1:43210/' })
    if (message.params.spawnDescendant) {
      const descendant = fork(import.meta.filename, ['--descendant'], {
        stdio: message.params.exitWithDescendant ? ['ignore', process.stdout, process.stderr, 'ipc'] : ['ignore', 'ignore', 'ignore', 'ipc'],
      })
      descendant.once('message', () => {
        process.stdout.write(`descendant:${descendant.pid}\n`, () => {
          if (message.params.exitWithDescendant) process.exit(7)
          else ready()
        })
      })
    } else {
      ready()
    }
  })
  process.on('SIGTERM', () => process.exit(0))
}

process.on('SIGINT', () => process.exit(130))
setInterval(() => undefined, 1000)
