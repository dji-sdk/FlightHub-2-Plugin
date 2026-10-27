// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { PluginCapabilityClient } from 'fh2-plugin-sdk'
import type { RoutePlanInput, RoutePlanningHttpApi } from '../api/route-planning-api'
import type { DispatchRoute } from './types'

interface RoutePlanningLogger {
  debug(message: string, detail: Record<string, string | number | boolean | null>): void;
  warn(message: string, detail: Record<string, string | number | boolean | null>): void;
}

export interface RoutePlanningApi {
  plan(input: RoutePlanInput): Promise<readonly DispatchRoute[]>;
  register(workspaceId: string, input: { readonly wpmzKey: string; readonly name: string }): Promise<string>;
}

/**
 * 组合路线规划 HTTP API 与 WPMZ 坐标解析：
 * 预览坐标解析失败或无下载地址时该路线只保留起终点标记，不阻断派遣。
 * 解析结果通过 logger 输出，避免 wpmz_url 不可达时静默失败。
 */
export function createRoutePlanningApi (
  http: RoutePlanningHttpApi,
  wpmz: Pick<PluginCapabilityClient<'platform:wpmz'>, 'parseCoordinates'>,
  logger?: RoutePlanningLogger,
): RoutePlanningApi {
  return {
    async plan (input) {
      const routes = await http.plan(input)
      return Promise.all(routes.map(async (route) => {
        if (!route.wpmzUrl) {
          logger?.debug('航线无下载地址，仅保留起终点', { routeId: route.id, source: route.source })
          return route
        }
        const startedAt = Date.now()
        try {
          const coordinates = await wpmz.parseCoordinates({
            url: route.wpmzUrl,
            referenceAltitude: input.takeoffReferenceAltitude,
          })
          const coordinateDtos = coordinates.map(point => ({
            lng: point.lng,
            lat: point.lat,
            height: point.height,
          }))
          // 只输出 URL host，不记录带签名的完整下载地址。
          const host = safeHost(route.wpmzUrl)
          if (coordinateDtos.length > 0) {
            logger?.debug('航线 WPMZ 坐标解析完成', {
              routeId: route.id,
              source: route.source,
              coordinateCount: coordinateDtos.length,
              durationMs: Date.now() - startedAt,
              wpmzHost: host,
            })
            return { ...route, coordinates: coordinateDtos }
          }
          logger?.warn('航线 WPMZ 坐标解析结果为空，仅保留起终点', {
            routeId: route.id,
            source: route.source,
            durationMs: Date.now() - startedAt,
            wpmzHost: host,
          })
          return route
        } catch (error) {
          logger?.warn('航线 WPMZ 坐标解析失败，仅保留起终点', {
            routeId: route.id,
            source: route.source,
            durationMs: Date.now() - startedAt,
            wpmzHost: safeHost(route.wpmzUrl),
            errorMessage: error instanceof Error ? error.message : String(error),
          })
          return route
        }
      }))
    },
    async register (workspaceId, { wpmzKey, name }) {
      const result = await http.registerWayline({ workspaceId, wpmzKey, name })
      return result.waylineUuid
    },
  }
}

function safeHost (url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'invalid-url'
  }
}
