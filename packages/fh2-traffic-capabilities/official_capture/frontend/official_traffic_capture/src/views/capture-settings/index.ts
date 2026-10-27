// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createApp } from 'vue'
import { defineView } from 'fh2-plugin-sdk/view'
import { captureSettingsView } from './contract'
import SettingsPanelView from './SettingsPanelView.vue'

export default defineView({
  mount (ctx) {
    const client = captureSettingsView.client(ctx.port)
    const app = createApp(SettingsPanelView, { client, overlayElement: ctx.overlayElement })
    app.mount(ctx.mountElement)
    return {
      dispose: () => {
        app.unmount()
        client.dispose()
      },
    }
  },
})
