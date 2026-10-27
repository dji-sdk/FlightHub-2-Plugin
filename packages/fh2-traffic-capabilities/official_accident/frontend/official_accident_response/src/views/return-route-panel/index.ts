// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createApp } from 'vue'
import { defineView } from 'fh2-plugin-sdk'
import { returnRoutePanelView } from './contract'
import ReturnRoutePanel from './ReturnRoutePanel.vue'

export default defineView({
  mount (ctx) {
    const client = returnRoutePanelView.client(ctx.port)
    const app = createApp(ReturnRoutePanel, { client, styleTarget: ctx.styleTarget })
    app.mount(ctx.mountElement)
    return { dispose: () => {
      app.unmount()
      client.dispose()
    } }
  },
})
