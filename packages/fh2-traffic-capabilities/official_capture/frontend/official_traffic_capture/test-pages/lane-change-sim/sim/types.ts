// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { ValidCoreRegion } from '../../../src/hosts/cockpit/lane-change/detector-core'

export interface ScenarioVideoSource {
  /** objectURL 或 dev server URL；由画布组件持有 <video> 播放。 */
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly fps?: number;
}

export interface KeyframeBBox {
  time: number;
  /** false 表示该时刻起目标不可见，用于确定性模拟漏检/丢帧，不做跨空洞插值。 */
  present?: boolean;
  objIdOverride?: string | number;
  /** 覆盖合成目标语义状态（'tracked' / 'not-confident' 等）；缺省 'tracked'。 */
  stateOverride?: string;
  rect: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  };
}

export interface BBoxTrack {
  objId: string | number;
  keyframes: KeyframeBBox[];
  /** 合成场景的可视化说明，不传入 detector。 */
  laneChange?: {
    direction: 'left-to-right' | 'right-to-left';
    startTime: number;
    endTime: number;
  };
}

export interface NoiseProfile {
  seed?: number;
  positionSigma?: number;
  sizeSigma?: number;
  dropoutRate?: number;
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  /** 毫秒 */
  duration: number;
  regions: ValidCoreRegion[];
  tracks: BBoxTrack[];
  /** 斜拍场景使用等比例正方形视口，保持道路约 45°。 */
  roadLayout?: 'diagonal';
  /** 只在指定时间点把 bbox 喂给 core，用于低 FPS / 长间隔 / 录制回放对齐。 */
  frameTimes?: number[];
  noiseProfile?: NoiseProfile | null;
  /** 真机录像背景（djmd 提取回放）；未提供时绘制合成道路。 */
  video?: ScenarioVideoSource;
}
