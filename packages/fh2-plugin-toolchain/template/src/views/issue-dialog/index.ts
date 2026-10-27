// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createApp } from 'vue'
import { defineView } from 'fh2-plugin-sdk/view'
import { issueDialogView } from './contract'
import IssueDialog from './IssueDialog.vue'

export default defineView({
  mount (ctx) {
    const client = issueDialogView.client(ctx.port)
    const app = createApp(IssueDialog, { client })
    app.mount(ctx.mountElement)
    return {
      dispose: () => {
        app.unmount()
        client.dispose()
      },
    }
  },
})
