// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createApp } from 'vue'
import { defineView } from 'fh2-plugin-sdk/view'
import TeachDialog from './TeachDialog.vue'
import { teachDialogView } from './contract'

export default defineView({
  mount (ctx) {
    const client = teachDialogView.client(ctx.port)
    const app = createApp(TeachDialog, { client })
    app.mount(ctx.mountElement)
    return {
      dispose: () => {
        app.unmount()
        client.dispose()
      },
    }
  },
})
