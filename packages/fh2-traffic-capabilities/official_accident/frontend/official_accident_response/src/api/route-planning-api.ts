// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { isPluginError } from 'fh2-plugin-sdk'
import type { JsonValue } from 'fh2-plugin-sdk'
import type { DispatchRoute } from '../workflow/types'
import { isApiBusinessError, unwrapApiData } from './api-response'
import type { ApiCall } from './types'

const PLAN_ENDPOINT = '/plugin-scene/route-planning/plan'
const REGISTER_ENDPOINT = '/plugin-scene/route-planning/register'

export interface RoutePlanInput {
  readonly workspaceId: string;
  readonly startPosition: { readonly lat: number; readonly lng: number };
  readonly destinationPosition: { readonly lat: number; readonly lng: number };
  readonly height: number;
  readonly takeoffReferenceAltitude: number;
  readonly speed: number;
  readonly interval?: number;
  readonly finishAction?: 'goHome';
  readonly endGimbalPitch?: number;
}

export interface WaylineRegisterInput {
  readonly workspaceId: string;
  readonly wpmzKey: string;
  readonly name: string;
}

export interface WaylineRegisterResult {
  readonly waylineUuid: string;
  readonly key: string;
  readonly name: string;
}

export interface RoutePlanningHttpApi {
  plan(input: RoutePlanInput): Promise<readonly DispatchRoute[]>;
  registerWayline(input: WaylineRegisterInput): Promise<WaylineRegisterResult>;
}

export function parsePlannedRoutes (value: JsonValue): readonly DispatchRoute[] {
  const data = asRecord(value)
  const list = Array.isArray(data.routes) ? data.routes : []
  const routes: DispatchRoute[] = []
  for (const entry of list) {
    const item = asRecord(entry)
    const wpmzKey = stringValue(item.wpmz_key)
    if (!wpmzKey) continue
    const label = stringValue(item.label)
    const waylineUuid = stringValue(item.wayline_uuid)
    routes.push({
      id: wpmzKey,
      source: stringValue(item.source) || 'unknown',
      label: label || `候选路线 ${routes.length + 1}`,
      totalDistance: numberValue(item.total_distance) ?? 0,
      estimatedDuration: numberValue(item.estimated_duration) ?? 0,
      waypointCount: numberValue(item.waypoint_count) ?? 0,
      wpmzKey,
      wpmzUrl: stringValue(item.wpmz_url),
      ...(waylineUuid ? { waylineUuid } : {}),
      warnings: strings(item.warnings),
    })
  }
  return routes
}

export function parseWaylineRegisterResult (value: JsonValue): WaylineRegisterResult {
  const item = asRecord(value)
  const waylineUuid = stringValue(item.wayline_uuid)
  if (!waylineUuid) throw new Error('航线入库响应缺少 wayline_uuid')
  return {
    waylineUuid,
    key: stringValue(item.key),
    name: stringValue(item.name),
  }
}

export function createRoutePlanningHttpApi (apiCall: ApiCall): RoutePlanningHttpApi {
  return {
    async plan (input) {
      try {
        const response = await apiCall(PLAN_ENDPOINT, {
          method: 'POST',
          body: {
            workspace_id: input.workspaceId,
            start_lat: input.startPosition.lat,
            start_lng: input.startPosition.lng,
            end_lat: input.destinationPosition.lat,
            end_lng: input.destinationPosition.lng,
            height: input.height,
            takeoff_ref_altitude: input.takeoffReferenceAltitude,
            speed: input.speed,
            ...(input.interval === undefined ? {} : { interval: input.interval }),
            ...(input.finishAction === undefined ? {} : { finish_action: input.finishAction }),
            ...(input.endGimbalPitch === undefined ? {} : { end_gimbal_pitch: input.endGimbalPitch }),
          },
        })
        return parsePlannedRoutes(unwrapApiData(response))
      } catch (error) {
        throw gatewayFriendlyError(error, '路线规划失败', '路线规划服务未就绪，请稍后重试')
      }
    },
    async registerWayline ({ workspaceId, wpmzKey, name }) {
      try {
        const response = await apiCall(REGISTER_ENDPOINT, {
          method: 'POST',
          body: {
            workspace_id: workspaceId,
            wpmz_key: wpmzKey,
            name,
          },
        })
        return parseWaylineRegisterResult(unwrapApiData(response))
      } catch (error) {
        throw gatewayFriendlyError(error, '航线入库失败', '航线库服务未就绪，请稍后重试')
      }
    },
  }
}

/**
 * 网关与业务错误一律使用插件固定文案：已知码映射中文提示，未知码通用兜底，
 * 不透传后端 message/detail；只有插件自身的解析错误（如响应缺字段）保留原文案。
 */
function gatewayFriendlyError (error: unknown, fallback: string, notReadyMessage: string): Error {
  const detail = isPluginError(error) ? asRecord(error.detail) : {}
  const gatewayCode = numberValue(detail.gatewayCode)
  const httpStatus = numberValue(detail.httpStatus)
  const businessCode = isApiBusinessError(error) ? error.code : gatewayCode
  if (businessCode === 11001) return new Error('起终点直线距离超过无人机航程上限')
  if (businessCode === 11002) return new Error('所有候选图都没能生成可达航线')
  if (gatewayCode === 50001 || httpStatus === 503) return new Error(notReadyMessage)
  if (isPluginError(error) || isApiBusinessError(error)) return new Error(fallback)
  if (error instanceof Error && error.message) return error
  return new Error(fallback)
}

function asRecord (value: unknown): Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>>
    : {}
}

function strings (value: JsonValue | undefined): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function stringValue (value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function numberValue (value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
