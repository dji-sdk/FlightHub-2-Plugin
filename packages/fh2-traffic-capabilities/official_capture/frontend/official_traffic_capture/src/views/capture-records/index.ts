// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createApp } from 'vue'
import { defineView } from 'fh2-plugin-sdk/view'
import { captureRecordsView } from './contract'
import RecordsView from './RecordsView.vue'

export default defineView({
  mount (ctx) {
    const client = captureRecordsView.client(ctx.port)
    const app = createApp(RecordsView, { client })
    app.mount(ctx.mountElement)
    return {
      dispose: () => {
        app.unmount()
        client.dispose()
      },
    }
  },
})
