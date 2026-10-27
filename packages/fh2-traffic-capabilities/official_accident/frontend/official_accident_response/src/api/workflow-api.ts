// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { JsonValue } from 'fh2-plugin-sdk'
import { unwrapApiData } from './api-response'
import type { ApiCall } from './types'

export type WorkflowSignal =
  | 'acknowledge'
  | 'route_selected'
  | 'ignore'

export interface AccidentWorkflowStatus {
  readonly flow: string;
  readonly currentStep: string;
  readonly executed: readonly string[];
  readonly skipped: readonly string[];
  readonly awaitingSignal: string;
}

export interface RouteSelectedPayload {
  readonly projectUuid: string;
  readonly dockSn: string;
  readonly waylineUuid: string;
}

export interface AccidentWorkflowApi {
  getStatus(pluginEventId: string): Promise<AccidentWorkflowStatus>;
  acknowledge(pluginEventId: string): Promise<void>;
  selectRoute(pluginEventId: string, payload: RouteSelectedPayload): Promise<void>;
  ignore(pluginEventId: string): Promise<void>;
}

function record (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>>
    : {}
}

function strings (value: JsonValue | undefined): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function requiredString (value: JsonValue | undefined, field: string): string {
  if (typeof value !== 'string') throw new Error(`工作流状态缺少 ${field}`)
  return value
}

export function parseWorkflowStatus (value: JsonValue): AccidentWorkflowStatus {
  const response = record(value)
  return {
    flow: requiredString(response.flow, 'flow'),
    currentStep: requiredString(response.currentStep, 'currentStep'),
    executed: strings(response.executed),
    skipped: strings(response.skipped),
    awaitingSignal: requiredString(response.awaitingSignal, 'awaitingSignal'),
  }
}

export function createAccidentWorkflowApi (apiCall: ApiCall, flowName: string): AccidentWorkflowApi {
  const flowPath = `/flows/${encodeURIComponent(flowName)}/incidents`

  async function signal (pluginEventId: string, name: WorkflowSignal, payload: Readonly<Record<string, JsonValue>>): Promise<void> {
    const response = await apiCall(
      `${flowPath}/${encodeURIComponent(pluginEventId)}/signals/${name}`,
      { method: 'POST', body: { payload } },
    )
    unwrapApiData(response)
  }

  return {
    async getStatus (pluginEventId) {
      const response = await apiCall(`${flowPath}/${encodeURIComponent(pluginEventId)}/status`)
      return parseWorkflowStatus(unwrapApiData(response))
    },
    acknowledge: pluginEventId => signal(pluginEventId, 'acknowledge', {}),
    ignore: pluginEventId => signal(pluginEventId, 'ignore', {}),
    selectRoute: (pluginEventId, payload) => signal(pluginEventId, 'route_selected', {
      projectUuid: payload.projectUuid,
      dockSn: payload.dockSn,
      waylineUuid: payload.waylineUuid,
    }),
  }
}
