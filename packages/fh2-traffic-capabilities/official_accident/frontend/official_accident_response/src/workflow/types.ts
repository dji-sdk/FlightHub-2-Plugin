// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { GeoPoint, JsonValue } from 'fh2-plugin-sdk'

/**
 * 事故快处在三个 Host 之间传递的业务类型。
 *
 * 这里不放 HTTP 信封、Vue 状态或 Capability Handle，避免后端协议和宿主实现
 * 渗透到工作流代码中。
 */

export interface AccidentAlertContext {
  readonly projectId: string;
  readonly organizationId: string;
  readonly pluginEventId: string;
  readonly title: string;
  readonly alarmPosition: GeoPoint;
  readonly flightHeight: number;
  readonly originParams: Readonly<Record<string, JsonValue>>;
  readonly level: number;
  readonly address: string;
  readonly description: string;
  readonly waitTime: number;
}

export interface DispatchRequest extends AccidentAlertContext {
  readonly popupId: string;
  readonly receivedAt: number;
}

export interface DispatchDevice {
  readonly dockSn: string;
  readonly droneSn: string;
  readonly gatewaySn: string;
  /** 飞行器呼号；缺失回退 SN。 */
  readonly droneCallsign: string;
  /** 机场/机库呼号；缺失回退 SN。 */
  readonly dockCallsign: string;
  /** 飞行器机型名；未知机型显示 --。 */
  readonly droneModelName: string;
  /** 机场/机库机型名；未知机型显示 --。 */
  readonly dockModelName: string;
  readonly startPosition: GeoPoint;
  readonly takeoffReferenceAltitude: number;
  /** 机场空闲（舱内待机/关机）；false 表示作业中，状态点显示橙色。 */
  readonly idle: boolean;
  /** 机场正在执行任务；设备保留展示但禁止选择。 */
  readonly executingTask: boolean;
  /** 剩余飞行时长（秒）；缺失不显示。 */
  readonly remainFlightTime?: number;
  readonly distance?: number;
  /** 飞机电量百分比；舱内关机时为机场上报的充电电量，未知时为 undefined。 */
  readonly batteryPercent?: number;
  /** 飞机是否在机场充电中。 */
  readonly batteryCharging?: boolean;
}

export interface DispatchRoute {
  readonly id: string;
  readonly source: string;
  readonly label: string;
  readonly totalDistance: number;
  readonly estimatedDuration: number;
  readonly waypointCount: number;
  readonly wpmzKey: string;
  readonly wpmzUrl: string;
  readonly waylineUuid?: string;
  readonly warnings: readonly string[];
  readonly coordinates?: readonly GeoPoint[];
}

export type AccidentFlowStatus = 'idle' | 'pending' | 'dispatching' | 'dispatched' | 'closed' | 'failed'

/** 警情状态机：未签收 → 已签收 → 处置中 → 已完成；超时/忽略/终止为终态。 */
export type EventStatus =
  | 'unacknowledged'
  | 'acknowledged'
  | 'handling'
  | 'completed'
  | 'ack_timeout'
  | 'ignored'
  | 'terminated'

export interface AccidentRecord {
  readonly pluginEventId: string;
  /** 平台任务服务 飞行任务 uuid（command_task 节点的 executionTask uuid），未派遣时缺失。 */
  readonly flightMissionId?: string;
  readonly title: string;
  readonly createdAt: number;
  readonly status: EventStatus;
  readonly priority: string;
  readonly address: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly height: number;
  readonly correctionNote?: string;
  readonly rawPayload: Readonly<Record<string, JsonValue>>;
  readonly result: JsonValue;
}

export interface AccidentListItem {
  readonly pluginEventId: string;
  readonly title: string;
  readonly occurredAt: number;
  readonly status: EventStatus;
  readonly address: string;
  readonly hasCoordinates: boolean;
  readonly correctionNote?: string;
  readonly latitude?: number;
  readonly longitude?: number;
}

export interface AllEventItem {
  readonly pluginEventId: string;
  /** 平台任务服务 飞行任务 uuid（command_task 节点的 executionTask uuid），未派遣时缺失。 */
  readonly flightMissionId?: string;
  readonly status: EventStatus;
  readonly occurredAt: number;
  readonly address: string;
  readonly hasCoordinates: boolean;
  readonly correctionNote?: string;
  readonly latitude?: number;
  readonly longitude?: number;
}

export interface AllEventsPage {
  readonly items: readonly AllEventItem[];
  readonly total: number;
}

export interface AllEventsQuery {
  readonly page: number;
  readonly pageSize: number;
}
