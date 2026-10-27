// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 视频背景 letterbox 布局与坐标映射。
 *
 * sim 的区域与 bbox 使用视频画面归一化坐标（djmd 万分比 / 10000）；
 * 画布按 object-fit: contain 语义绘制视频，鼠标与绘制需在两个空间互转。
 */

export interface VideoLayout {
  readonly canvasW: number;
  readonly canvasH: number;
  /** 画布内视频内容区（像素）。 */
  readonly dx: number;
  readonly dy: number;
  readonly dw: number;
  readonly dh: number;
}

export function computeLetterbox (canvasW: number, canvasH: number, videoW: number, videoH: number): VideoLayout {
  if (!(canvasW > 0) || !(canvasH > 0) || !(videoW > 0) || !(videoH > 0)) {
    return { canvasW, canvasH, dx: 0, dy: 0, dw: canvasW, dh: canvasH }
  }
  const scale = Math.min(canvasW / videoW, canvasH / videoH)
  const dw = videoW * scale
  const dh = videoH * scale
  return { canvasW, canvasH, dx: (canvasW - dw) / 2, dy: (canvasH - dh) / 2, dw, dh }
}

export interface VideoNormPoint {
  readonly x: number;
  readonly y: number;
}

/** 画布归一化坐标 → 视频归一化坐标；落在 letterbox 黑边内返回 null。 */
export function canvasToVideoNorm (x: number, y: number, layout: VideoLayout): VideoNormPoint | null {
  const vx = (x * layout.canvasW - layout.dx) / layout.dw
  const vy = (y * layout.canvasH - layout.dy) / layout.dh
  if (!Number.isFinite(vx) || !Number.isFinite(vy) || vx < 0 || vx > 1 || vy < 0 || vy > 1) return null
  return { x: vx, y: vy }
}

/** 视频归一化坐标 → 画布归一化坐标。 */
export function videoToCanvasNorm (x: number, y: number, layout: VideoLayout): VideoNormPoint {
  return {
    x: (layout.dx + x * layout.dw) / layout.canvasW,
    y: (layout.dy + y * layout.dh) / layout.canvasH,
  }
}
