// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePluginService } from 'fh2-plugin-sdk'
import type { AccidentFlowStatus, DispatchRequest } from '../workflow/types'

export interface AlertFlowSnapshot {
  readonly status: AccidentFlowStatus;
  readonly pluginEventId: string | null;
  readonly projectId: string | null;
  readonly title: string;
  readonly occurredAt: number | null;
}

interface AlertFlowMethods {
  getState(): AlertFlowSnapshot;
  requestDispatch(input: DispatchRequest): { readonly accepted: boolean };
}

interface AlertFlowEvents {
  readonly stateChanged: AlertFlowSnapshot;
}

/** Message 提供、Project 消费的派遣协作通道；Cockpit 直接轮询事件 API。 */
export const alertFlowService = definePluginService<AlertFlowMethods, AlertFlowEvents>('alert-flow')
