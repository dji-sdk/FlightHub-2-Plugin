// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePlugin } from 'fh2-plugin-sdk'
import type { PluginContext } from 'fh2-plugin-sdk'
import type { AccidentCockpitContext, AccidentMessageContext, AccidentProjectContext } from './types'

export default definePlugin({
  async activate (ctx: PluginContext) {
    ctx.logger.info('事故快处插件开始激活', { hostId: ctx.host.id })
    if (ctx.host.id === 'message') {
      return (await import('./hosts/message/activate')).activate(ctx as AccidentMessageContext)
    }
    if (ctx.host.id === 'project') {
      return (await import('./hosts/project/activate')).activate(ctx as AccidentProjectContext)
    }
    if (ctx.host.id === 'cockpit') {
      return (await import('./hosts/cockpit/activate')).activate(ctx as AccidentCockpitContext)
    }
  },
})
