// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { JsonValue } from 'fh2-plugin-sdk'
import { unwrapApiData } from './api-response'
import type { ApiCall } from './types'

export interface FlightActionsApi {
  /**
   * 用飞行任务 uuid 反查媒体文件夹 id。
   *
   * folder_id 由 平台任务服务 创建飞行任务时生成；媒体上传晚于任务完成，
   * 查不到时返回 null，调用方按「媒体文件生成中」处理。
   */
  getMediaFolderId(projectId: string, flightMissionId: string): Promise<string | null>;
}

/**
 * 全部事件列表「媒体库 / 飞行记录」跳转所需的任务详情查询。
 *
 * 对齐原生 getFlightTaskDetail：GET /task/api/v2/workspaces/{projectId}/flight-tasks/detail。
 * HTTP 字段和信封解析收口在本文件。
 */
export function createFlightActionsApi (apiCall: ApiCall): FlightActionsApi {
  return {
    async getMediaFolderId (projectId, flightMissionId) {
      const response = await apiCall(
        `/task/api/v2/workspaces/${encodeURIComponent(projectId)}/flight-tasks/detail`
        + `?flight_task_id=${encodeURIComponent(flightMissionId)}`,
        { method: 'GET' },
      )
      const data = unwrapApiData(response)
      if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
      const folderId = (data as Readonly<Record<string, JsonValue>>).folder_id
      if (typeof folderId === 'number' && Number.isFinite(folderId)) return String(folderId)
      if (typeof folderId === 'string' && folderId !== '') return folderId
      return null
    },
  }
}
