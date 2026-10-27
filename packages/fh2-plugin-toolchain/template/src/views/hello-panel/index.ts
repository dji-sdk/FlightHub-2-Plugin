// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { defineView } from 'fh2-plugin-sdk/view'
import HelloPanel from './HelloPanel.vue'
import { mountHelloPanel } from './mount'

export default defineView({
  mount: ctx => mountHelloPanel(ctx, HelloPanel),
})
