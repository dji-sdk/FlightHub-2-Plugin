// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createApp } from 'vue'
import { defineView } from 'fh2-plugin-sdk/view'
import { patrolDialogView } from './contract'
import PatrolDialog from './PatrolDialog.vue'

export default defineView({
  mount (ctx) {
    const client = patrolDialogView.client(ctx.port)
    const app = createApp(PatrolDialog, { client })
    app.mount(ctx.mountElement)
    return {
      dispose: () => {
        app.unmount()
        client.dispose()
      },
    }
  },
})
