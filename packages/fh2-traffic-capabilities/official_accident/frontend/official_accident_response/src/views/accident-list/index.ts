// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createApp } from 'vue'
import { defineView } from 'fh2-plugin-sdk'
import { accidentListView } from './contract'
import AccidentListView from './AccidentListView.vue'

export default defineView({
  mount (ctx) {
    const client = accidentListView.client(ctx.port)
    const app = createApp(AccidentListView, {
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
