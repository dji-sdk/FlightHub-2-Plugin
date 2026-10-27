// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createApp } from 'vue'
import { defineView } from 'fh2-plugin-sdk/view'
import { captureEvidencePreviewView } from './contract'
import CaptureEvidencePreview from './CaptureEvidencePreview.vue'

export default defineView({
  mount (ctx) {
    const client = captureEvidencePreviewView.client(ctx.port)
    const app = createApp(CaptureEvidencePreview, { client })
    app.mount(ctx.mountElement)
    return {
      dispose: () => {
        app.unmount()
        client.dispose()
      },
    }
  },
})
