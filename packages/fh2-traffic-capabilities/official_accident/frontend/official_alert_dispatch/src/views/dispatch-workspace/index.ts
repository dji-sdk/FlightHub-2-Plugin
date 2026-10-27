// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createApp } from 'vue'
import { defineView } from 'fh2-plugin-sdk'
import { dispatchWorkspaceView } from './contract'
import DispatchWorkspace from './DispatchWorkspace.vue'

export default defineView({
  mount (ctx) {
    const client = dispatchWorkspaceView.client(ctx.port)
    const app = createApp(DispatchWorkspace, {
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
