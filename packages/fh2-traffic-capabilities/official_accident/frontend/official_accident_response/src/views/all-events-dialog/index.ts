// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createApp } from 'vue'
import { defineView } from 'fh2-plugin-sdk'
import { allEventsDialogView } from '../accident-list/contract'
import AllEventsDialog from '../accident-list/AllEventsDialog.vue'

export default defineView({
  mount (ctx) {
    const client = allEventsDialogView.client(ctx.port)
    const app = createApp(AllEventsDialog, {
      client,
      styleTarget: ctx.styleTarget,
      overlayElement: ctx.overlayElement,
    })
    app.mount(ctx.mountElement)
    return {
      dispose: () => {
        app.unmount()
        client.dispose()
      },
    }
  },
})
