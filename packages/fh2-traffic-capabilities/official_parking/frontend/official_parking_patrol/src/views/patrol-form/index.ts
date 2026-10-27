// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createApp } from 'vue'
import { defineView } from 'fh2-plugin-sdk/view'
import { patrolFormView } from './contract'
import PatrolFormView from './PatrolFormView.vue'

export default defineView({
  mount (ctx) {
    const client = patrolFormView.client(ctx.port)
    const app = createApp(PatrolFormView, { client })
    app.mount(ctx.mountElement)
    return {
      dispose: () => {
        app.unmount()
        client.dispose()
      },
    }
  },
})
