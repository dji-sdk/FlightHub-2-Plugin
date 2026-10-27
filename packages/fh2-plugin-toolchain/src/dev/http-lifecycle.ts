// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { IncomingMessage, ServerResponse } from 'node:http'

export function closeRequestAfterResponse (req: IncomingMessage, res: ServerResponse): void {
  res.shouldKeepAlive = false
  if (!res.headersSent) res.setHeader('connection', 'close')
  const destroyRequest = (): void => {
    if (!req.destroyed) req.destroy()
  }
  if (res.writableFinished) queueMicrotask(destroyRequest)
  else res.once('finish', destroyRequest)
}
