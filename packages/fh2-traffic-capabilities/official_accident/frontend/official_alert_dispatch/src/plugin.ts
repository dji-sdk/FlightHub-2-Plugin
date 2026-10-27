// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePlugin } from 'fh2-plugin-sdk'
import type { PluginContext } from 'fh2-plugin-sdk'
import type { AlertDispatchProjectContext } from './types'

export default definePlugin({
  async activate (ctx: PluginContext) {
    ctx.logger.info('警情派遣插件开始激活', { hostId: ctx.host.id })
    if (ctx.host.id === 'project') {
      return (await import('./hosts/project/activate')).activate(ctx as AlertDispatchProjectContext)
    }
  },
})
