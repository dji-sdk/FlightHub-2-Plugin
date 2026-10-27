// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import type { JsonValue } from 'fh2-plugin-sdk'
import { createAccidentWorkflowApi, parseWorkflowStatus } from './workflow-api'

describe('accident workflow api', () => {
  it('解析无统一信封的状态响应', () => {
    expect(parseWorkflowStatus({
      flow: 'accident-response-cascade',
      currentStep: 'pick',
      executed: ['rec', 'ack'],
      skipped: ['loc'],
      awaitingSignal: 'route_selected',
    })).toMatchObject({ currentStep: 'pick', awaitingSignal: 'route_selected' })
  })

  it('解析真实后端响应：无 incidentStatus 且 executed/skipped 为 null', () => {
    expect(parseWorkflowStatus({
      flow: 'accident-response-cascade',
      currentStep: 'ack',
      executed: null,
      skipped: null,
      awaitingSignal: 'acknowledge',
    })).toEqual({
      flow: 'accident-response-cascade',
      currentStep: 'ack',
      executed: [],
      skipped: [],
      awaitingSignal: 'acknowledge',
    })
  })

  it('工作流 API 显式解析统一信封', async () => {
    const apiCall = vi.fn(async (): Promise<JsonValue> => ({
      code: 0,
      message: 'OK',
      data: {
        flow: 'accident-response-cascade',
        currentStep: 'pick',
        executed: ['rec', 'ack'],
        skipped: ['loc'],
        awaitingSignal: 'route_selected',
      },
    }))

    await expect(createAccidentWorkflowApi(apiCall, 'flow').getStatus('biz-1'))
      .resolves.toMatchObject({ currentStep: 'pick', awaitingSignal: 'route_selected' })
  })

  it('三个前端信号仅发送 payload，不发送 by', async () => {
    const calls: Array<{ endpoint: string; body?: JsonValue }> = []
    const apiCall = vi.fn(async (endpoint: string, options?: { body?: JsonValue }) => {
      calls.push({ endpoint, ...(options?.body === undefined ? {} : { body: options.body }) })
      return { code: 0, msg: 'Success', data: {} }
    })
    const api = createAccidentWorkflowApi(apiCall, 'flow/test')

    await api.acknowledge('biz/1')
    await api.selectRoute('biz/1', { projectUuid: 'project-1', dockSn: 'dock-1', waylineUuid: 'uuid-a' })
    await api.ignore('biz/1')

    expect(calls.map(call => call.endpoint)).toEqual([
      '/flows/flow%2Ftest/incidents/biz%2F1/signals/acknowledge',
      '/flows/flow%2Ftest/incidents/biz%2F1/signals/route_selected',
      '/flows/flow%2Ftest/incidents/biz%2F1/signals/ignore',
    ])
    expect(calls).toEqual(expect.not.arrayContaining([
      expect.objectContaining({ body: expect.objectContaining({ by: expect.anything() }) }),
    ]))
    expect(calls.map(call => call.body)).toEqual([
      { payload: {} },
      { payload: { projectUuid: 'project-1', dockSn: 'dock-1', waylineUuid: 'uuid-a' } },
      { payload: {} },
    ])
  })

  it('route_selected 只序列化三个必填字段', async () => {
    const bodies: JsonValue[] = []
    const apiCall = vi.fn(async (_endpoint: string, options?: { body?: JsonValue }) => {
      if (options?.body !== undefined) bodies.push(options.body)
      return { code: 0, data: {} }
    })
    const api = createAccidentWorkflowApi(apiCall, 'flow')

    await api.selectRoute('first', { projectUuid: 'project-1', dockSn: 'dock-1', waylineUuid: 'uuid-a' })
    await api.selectRoute('second', { projectUuid: 'project-2', dockSn: 'dock-2', waylineUuid: 'uuid-b' })

    expect(bodies).toEqual([
      { payload: { projectUuid: 'project-1', dockSn: 'dock-1', waylineUuid: 'uuid-a' } },
      { payload: { projectUuid: 'project-2', dockSn: 'dock-2', waylineUuid: 'uuid-b' } },
    ])
  })

  it('工作流信号保留统一信封的失败判定', async () => {
    const apiCall = vi.fn(async (): Promise<JsonValue> => ({
      code: 409,
      message: '信号与当前步骤不匹配',
      data: {},
    }))

    await expect(createAccidentWorkflowApi(apiCall, 'flow').acknowledge('biz-1'))
      .rejects.toThrow('信号与当前步骤不匹配（code: 409）')
  })
})
