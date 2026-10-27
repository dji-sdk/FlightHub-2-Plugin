// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createApp } from 'vue'
import { defineView } from 'fh2-plugin-sdk/view'
import { previewView } from './contract'
import PatrolPreview from './PatrolPreview.vue'

export default defineView({
  mount (ctx) {
    const client = previewView.client(ctx.port)
    const app = createApp(PatrolPreview, { client })
    app.mount(ctx.mountElement)
    return {
      dispose: () => {
        app.unmount()
        client.dispose()
      },
    }
  },
})
