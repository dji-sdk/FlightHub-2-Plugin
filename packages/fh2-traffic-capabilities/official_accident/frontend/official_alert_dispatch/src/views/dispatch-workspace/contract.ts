// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePluginView } from 'fh2-plugin-sdk'
import type { PluginViewClient } from 'fh2-plugin-sdk'
import type { DispatchFormState } from '../dispatch-form/contract'

/**
 * 工作区 View（ProjectRight 满铺区域）的只读契约：与左侧 dispatch-form
 * 共享同一份派发状态，用于人工验证 render + renderWorkspace 双区域渲染。
 */
interface DispatchWorkspaceContract {
  state: DispatchFormState;
}

export const dispatchWorkspaceView = definePluginView<DispatchWorkspaceContract>('dispatch-workspace')
export type DispatchWorkspaceViewClient = PluginViewClient<DispatchWorkspaceContract>
