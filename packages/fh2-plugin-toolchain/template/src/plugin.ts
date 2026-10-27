// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePlugin } from 'fh2-plugin-sdk'
import type { PluginContext } from 'fh2-plugin-sdk'
import type { AppCockpitContext } from './generated/plugin-types'

export default definePlugin({
  async activate (ctx: PluginContext) {
    if (ctx.host.id === 'cockpit') {
      return (await import('./hosts/cockpit/activate')).activate(ctx as AppCockpitContext)
    }

    ctx.logger.warn(`当前示例未实现 Host：${ctx.host.id}`)
    return undefined
  },
})
