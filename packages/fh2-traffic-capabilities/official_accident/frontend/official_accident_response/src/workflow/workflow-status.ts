// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { AccidentWorkflowStatus } from '../api/workflow-api'

export type IncidentAction =
  | 'acknowledge'
  | 'request-dispatch'
  | 'no-manual-action'
  | 'unsupported-signal'

/**
 * Project 点击警情后的唯一决策表。
 *
 * 后端仍以 awaitingSignal 作为人工动作来源；这里不根据未知 currentStep 猜测新流程。
 */
export function decideIncidentAction (status: AccidentWorkflowStatus): IncidentAction {
  if (status.awaitingSignal === 'acknowledge') return 'acknowledge'
  if (status.awaitingSignal === 'route_selected') return 'request-dispatch'
  return status.awaitingSignal ? 'unsupported-signal' : 'no-manual-action'
}

export function hasArrived (status: Pick<AccidentWorkflowStatus, 'currentStep'>): boolean {
  return status.currentStep === 'arrived'
}

export function isWorkflowRunning (status: Pick<AccidentWorkflowStatus, 'currentStep'>): boolean {
  return status.currentStep !== '' && !hasArrived(status)
}
