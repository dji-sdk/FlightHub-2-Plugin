// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createApp, reactive } from 'vue'
import type { Component } from 'vue'
import type { ViewInstance, ViewMountContext } from 'fh2-plugin-sdk'
import { helloPanelView } from './contract'

export function mountHelloPanel (ctx: ViewMountContext, component: Component): ViewInstance {
  const state = reactive({ count: 0 })
  const client = helloPanelView.client(ctx.port)
  const subscription = client.state.subscribe((next) => {
    state.count = next.count
  })
  const app = createApp(component, {
    state,
    onIncrement: () => client.increment(),
  })
  app.mount(ctx.mountElement)

  return {
    dispose () {
      subscription.dispose()
      client.dispose()
      app.unmount()
    },
  }
}
