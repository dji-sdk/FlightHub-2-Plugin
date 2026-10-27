// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createApp } from 'vue'
import { defineView } from 'fh2-plugin-sdk'
import { dispatchFormView } from './contract'
import DispatchForm from './DispatchForm.vue'

export default defineView({
  mount (ctx) {
    const client = dispatchFormView.client(ctx.port)
    const app = createApp(DispatchForm, {
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
