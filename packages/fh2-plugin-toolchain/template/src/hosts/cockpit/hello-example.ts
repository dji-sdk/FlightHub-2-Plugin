// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createViewState } from 'fh2-plugin-sdk'
import type { AppCockpitContext } from '../../generated/plugin-types'
import { helloPanelView } from '../../views/hello-panel/contract'
import type { HelloPanelState } from '../../views/hello-panel/contract'

/** 入门示例：Cockpit 工具栏按钮 reveal 左侧面板，View 内按钮累加计数。 */
export async function registerHelloExample (ctx: AppCockpitContext): Promise<void> {
  const state = createViewState<HelloPanelState>({ count: 0 })

  await helloPanelView.handle(ctx, {
    state,
    methods: {
      increment: () => {
        state.update(current => ({ count: current.count + 1 }))
        return state.get()
      },
    },
  })

  const panel = await ctx.extensions.contribute('hello-panel', {
    visible: false,
    label: '示例面板',
    icon: 'plugin',
    render: () => helloPanelView.get(ctx),
  })

  await ctx.extensions.contribute('hello-action', {
    icon: 'plugin',
    label: '打开示例面板',
    active: false,
    disabled: false,
    async onTrigger () {
      await panel.reveal()
    },
  })
}
