// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createApp } from 'vue'
import { defineView } from 'fh2-plugin-sdk/view'
import { taskPanelView } from './contract'
import PatrolTaskPanel from './PatrolTaskPanel.vue'

export default defineView({
  mount (ctx) {
    const client = taskPanelView.client(ctx.port)
    const app = createApp(PatrolTaskPanel, { client })
    app.mount(ctx.mountElement)
    return {
      dispose: () => {
        app.unmount()
        client.dispose()
      },
    }
  },
})
