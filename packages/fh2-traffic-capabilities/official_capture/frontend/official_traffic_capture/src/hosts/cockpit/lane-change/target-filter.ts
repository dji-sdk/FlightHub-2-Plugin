// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 检测目标 → detector CoreBBox 的生产过滤规则。
 *
 * 从 lane-change controller 的 processFrame 提取为共享纯函数：
 * 生产 Controller 与 test-pages 算法测试页使用同一份过滤契约
 * （车辆类型 + 可跟踪状态白名单 + 有效尺寸）。
 */
import type { CoreBBox } from './detector-core'

/** 车辆类检测目标 type 值（Cockpit Detection 协议）。 */
export const CAR_TARGET_TYPE = '3'

/** 参与变道判定的目标语义状态；lost 等其余状态目标直接过滤。 */
export const TRACKABLE_TARGET_STATES: ReadonlySet<string> = new Set([
  'tracked',
  'vision-beacon-fused',
  'auxiliary-tracked',
  'not-confident',
  'redetected',
])

export interface CarTargetLike {
  readonly targetId: string | number;
  readonly type: string;
  readonly state: string;
  readonly bbox: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

/** 按生产契约过滤车辆目标并换算为归一化 CoreBBox。 */
export function toCoreBBoxes (targets: readonly CarTargetLike[]): CoreBBox[] {
  return targets
    .filter(target => target.type === CAR_TARGET_TYPE
      && TRACKABLE_TARGET_STATES.has(target.state)
      && target.bbox.width > 0 && target.bbox.height > 0)
    .map(target => ({
      objId: target.targetId,
      rect: {
        x1: target.bbox.x,
        y1: target.bbox.y,
        x2: target.bbox.x + target.bbox.width,
        y2: target.bbox.y + target.bbox.height,
      },
    }))
}
