// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createApp } from 'vue'
import { defineView } from 'fh2-plugin-sdk/view'
import { issuePanelView } from './contract'
import IssuePanel from './IssuePanel.vue'

export default defineView({
  mount (ctx) {
    const client = issuePanelView.client(ctx.port)
    const app = createApp(IssuePanel, { client })
    app.mount(ctx.mountElement)
    return {
      dispose: () => {
        app.unmount()
        client.dispose()
      },
    }
  },
})
