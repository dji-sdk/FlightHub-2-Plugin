// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
export type TeachPhase = 'idle' | 'recording' | 'generating' | 'generated'
export type TeachAiTargetType = 'person' | 'car' | 'boat'

export interface TeachWaypoint {
  readonly id: string;
  readonly seq: number;
  readonly longitude: number;
  readonly latitude: number;
  /** WGS84 椭球高，单位 m。 */
  readonly height: number;
  readonly gimbalPitch: number;
  /** 相机示教时的绝对偏航，来源 OSD gimbal_yaw。 */
  readonly cameraYaw: number;
  readonly focalLength: number;
  readonly aiRecognitionOn: boolean;
  readonly aiTargetTypes: readonly TeachAiTargetType[];
  readonly screenshotFileId: string | null;
  readonly screenshotUrl: string | null;
  readonly screenshotBytes: number;
  readonly screenshotError: string | null;
  readonly selected: boolean;
}

export interface TeachRoute {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly flightId: string;
  readonly createdAt: string | null;
  readonly globalSpeed: number;
  readonly waypointSpeed: number;
  readonly screenshotBytes: number;
  readonly waylineUuid: string | null;
  readonly waylineFileId: string | null;
  readonly kmzObjectKey: string | null;
  /** generated 后航点已删除，保留生成时数量用于只读回显。 */
  readonly waypointCount: number;
  readonly waypoints: readonly TeachWaypoint[];
}

export interface TeachSessionState {
  readonly phase: TeachPhase;
  readonly route: TeachRoute | null;
}

export function createInitialTeachSession (): TeachSessionState {
  return { phase: 'idle', route: null }
}

export function enterRecording (state: TeachSessionState, route: TeachRoute): TeachSessionState {
  if (state.phase !== 'idle') throw new Error(`当前状态 ${state.phase} 不能进入示教`)
  return { phase: 'recording', route }
}

/** status 接口只恢复 recording；generated 路线须经详情/列表进入只读展示。 */
export function restoreTeachSession (route: TeachRoute): TeachSessionState {
  return { phase: 'recording', route }
}

export function beginGenerating (state: TeachSessionState): TeachSessionState {
  if (state.phase !== 'recording' || !state.route) {
    throw new Error(`当前状态 ${state.phase} 不能生成航线`)
  }
  if (state.route.waypoints.filter(waypoint => waypoint.selected).length < 2) {
    throw new Error('至少选择两个航点才能生成航线')
  }
  return { phase: 'generating', route: state.route }
}

export function finishGenerating (
  state: TeachSessionState,
  result: {
    readonly waylineUuid: string;
    readonly waylineFileId: string | null;
    readonly kmzObjectKey: string | null;
  },
): TeachSessionState {
  if (state.phase !== 'generating' || !state.route) throw new Error('当前状态不能完成航线生成')
  return {
    phase: 'generated',
    route: {
      ...state.route,
      ...result,
      waypointCount: state.route.waypoints.filter(waypoint => waypoint.selected).length,
      // generated 是终态；服务端在同一事务中删除航点。
      waypoints: [],
    },
  }
}

export function failGenerating (state: TeachSessionState): TeachSessionState {
  if (state.phase !== 'generating' || !state.route) throw new Error('当前状态不能恢复航线生成')
  return { phase: 'recording', route: state.route }
}

export function updateTeachRoute (
  state: TeachSessionState,
  update: (route: TeachRoute) => TeachRoute,
): TeachSessionState {
  if (!state.route || state.phase !== 'recording') {
    throw new Error(`当前状态 ${state.phase} 不能编辑示教航线`)
  }
  return { ...state, route: update(state.route) }
}

export function resetTeachSession (_state: TeachSessionState): TeachSessionState {
  return createInitialTeachSession()
}
