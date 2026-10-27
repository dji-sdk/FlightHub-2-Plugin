// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import type { AccidentWorkflowStatus } from '../api/workflow-api'
import { decideIncidentAction, hasArrived, isWorkflowRunning } from './workflow-status'

function status (patch: Partial<AccidentWorkflowStatus>): AccidentWorkflowStatus {
  return {
    flow: 'accident-response-cascade',
    currentStep: '',
    executed: [],
    skipped: [],
    awaitingSignal: '',
    ...patch,
  }
}

describe('事故工作流状态', () => {
  it.each([
    ['acknowledge', 'acknowledge'],
    ['route_selected', 'request-dispatch'],
    ['', 'no-manual-action'],
    ['future_signal', 'unsupported-signal'],
  ] as const)('将 awaitingSignal=%s 映射为 %s', (awaitingSignal, expected) => {
    expect(decideIncidentAction(status({ awaitingSignal }))).toBe(expected)
  })

  it('仅以 currentStep=arrived 判断到达', () => {
    expect(hasArrived(status({ currentStep: 'arrived' }))).toBe(true)
    expect(isWorkflowRunning(status({ currentStep: 'approach' }))).toBe(true)
  })
})
