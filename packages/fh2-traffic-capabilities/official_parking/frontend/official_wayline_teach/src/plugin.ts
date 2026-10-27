// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePlugin } from 'fh2-plugin-sdk'
import type { PluginContext } from 'fh2-plugin-sdk'
import type { WaylineTeachContext } from './types'

export default definePlugin({
  async activate (ctx: PluginContext) {
    if (ctx.host.id !== 'cockpit') return
    return (await import('./hosts/cockpit/activate')).activate(ctx as WaylineTeachContext)
  },
})
