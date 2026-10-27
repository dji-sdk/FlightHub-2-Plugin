// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { AccidentWorkflowApi, AccidentWorkflowStatus } from '../api/workflow-api'
import { decideIncidentAction } from './workflow-status'

export interface IncidentActionResult {
  readonly outcome: 'acknowledged' | 'dispatch-requested';
  readonly workflow: AccidentWorkflowStatus;
}

/**
 * 继续一次警情人工流程。
 *
 * Project 只负责提供“如何展示派遣”，后端状态到业务动作的转换集中在这里。
 */
export async function continueIncidentWorkflow (input: {
  readonly pluginEventId: string;
  readonly workflow: AccidentWorkflowApi;
  readonly requestDispatch: () => void | Promise<void>;
}): Promise<IncidentActionResult> {
  const status = await input.workflow.getStatus(input.pluginEventId)
  const action = decideIncidentAction(status)
  if (action === 'acknowledge') {
    await input.workflow.acknowledge(input.pluginEventId)
    return { outcome: 'acknowledged', workflow: status }
  }
  if (action === 'request-dispatch') {
    await input.requestDispatch()
    return { outcome: 'dispatch-requested', workflow: status }
  }
  if (action === 'no-manual-action') throw new Error('当前流程无需人工操作')
  throw new Error(`流程正在等待 ${status.awaitingSignal || '未知信号'}`)
}
