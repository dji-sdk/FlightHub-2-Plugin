// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createApp } from 'vue'
import { defineView } from 'fh2-plugin-sdk/view'
import { laneChangeWorkbenchView } from './contract'
import WorkbenchView from './WorkbenchView.vue'

export default defineView({
  mount (ctx) {
    const client = laneChangeWorkbenchView.client(ctx.port)
    const app = createApp(WorkbenchView, { client, overlayElement: ctx.overlayElement })
    app.mount(ctx.mountElement)
    return {
      dispose: () => {
        app.unmount()
        client.dispose()
      },
    }
  },
})
