// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createApp } from 'vue'
import { defineView } from 'fh2-plugin-sdk/view'
import { laneChangeRenameDialogView } from './contract'
import RenameDialogView from './RenameDialogView.vue'

export default defineView({
  mount (ctx) {
    const client = laneChangeRenameDialogView.client(ctx.port)
    const app = createApp(RenameDialogView, { client })
    app.mount(ctx.mountElement)
    return {
      dispose: () => {
        app.unmount()
        client.dispose()
      },
    }
  },
})
