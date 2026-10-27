// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import type { JsonValue } from 'fh2-plugin-sdk'
import { createFlightActionsApi } from './flight-actions-api'

function detailResponse (folderId: number | string | null): JsonValue {
  return {
    code: 0,
    message: 'OK',
    data: {
      flight_task_id: 'flight-task-1',
      flight_task_type: 1,
      task_type: 0,
      folder_id: folderId,
    },
  }
}

describe('flight actions api', () => {
  it('调用 v2 任务详情接口并返回 folder_id 字符串', async () => {
    const calls: Array<{ endpoint: string; method?: string }> = []
    const apiCall = async (
      endpoint: string,
      options?: { readonly method?: 'GET' | 'POST' },
    ): Promise<JsonValue> => {
      calls.push({ endpoint, ...(options?.method === undefined ? {} : { method: options.method }) })
      return detailResponse(2001)
    }

    const folderId = await createFlightActionsApi(apiCall).getMediaFolderId('mock-project', 'flight-task-1')

    expect(calls).toEqual([{
      endpoint: '/task/api/v2/workspaces/mock-project/flight-tasks/detail?flight_task_id=flight-task-1',
      method: 'GET',
    }])
    expect(folderId).toBe('2001')
  })

  it('projectId 与 flight_task_id 均编码后拼接', async () => {
    const endpoints: string[] = []
    const apiCall = async (endpoint: string): Promise<JsonValue> => {
      endpoints.push(endpoint)
      return detailResponse(null)
    }

    await createFlightActionsApi(apiCall).getMediaFolderId('proj/1', 'task a')

    expect(endpoints).toEqual([
      '/task/api/v2/workspaces/proj%2F1/flight-tasks/detail?flight_task_id=task%20a',
    ])
  })

  it('folder_id 缺失、null 或非有限数字时返回 null（媒体未生成）', async () => {
    for (const folderId of [null, Number.NaN, ''] as const) {
      const apiCall = async (): Promise<JsonValue> => detailResponse(folderId)
      await expect(createFlightActionsApi(apiCall).getMediaFolderId('p', 'f'))
        .resolves.toBeNull()
    }
    const missing = async (): Promise<JsonValue> => ({
      code: 0,
      message: 'OK',
      data: { flight_task_id: 'flight-task-1' },
    })
    await expect(createFlightActionsApi(missing).getMediaFolderId('p', 'f'))
      .resolves.toBeNull()
  })

  it('folder_id 为非空字符串时原样返回', async () => {
    const apiCall = async (): Promise<JsonValue> => detailResponse('folder-abc')
    await expect(createFlightActionsApi(apiCall).getMediaFolderId('p', 'f'))
      .resolves.toBe('folder-abc')
  })

  it('data 为空对象时返回 null', async () => {
    const apiCall = async (): Promise<JsonValue> => ({ code: 0, message: 'OK', data: {} })
    await expect(createFlightActionsApi(apiCall).getMediaFolderId('p', 'f'))
      .resolves.toBeNull()
  })

  it('业务 code 非 0 时抛出后端 message', async () => {
    const apiCall = async (): Promise<JsonValue> => ({ code: 40400, message: 'Not Found', data: null })
    await expect(createFlightActionsApi(apiCall).getMediaFolderId('p', 'f'))
      .rejects.toThrow('Not Found（code: 40400）')
  })
})
