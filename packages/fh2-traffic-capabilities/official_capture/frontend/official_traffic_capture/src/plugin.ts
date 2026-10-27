// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePlugin } from 'fh2-plugin-sdk'
import type { PluginContext } from 'fh2-plugin-sdk'
import type { TrafficCaptureContext } from './hosts/cockpit/context'

/** Plugin Entry 只负责把当前 Runtime 分发到对应 Host 的装配入口。 */
export default definePlugin({
  async activate (ctx: PluginContext) {
    if (ctx.host.id !== 'cockpit') return
    return (await import('./hosts/cockpit/activate')).activate(ctx as TrafficCaptureContext)
  },
})
