// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

/** 将视口坐标换算到 View overlay 的本地坐标，兼容带 transform 的宿主 Popover。 */
export function resolveTooltipPosition (
  trigger: RectLike,
  overlay: Pick<RectLike, 'left' | 'top'>,
  viewportWidth: number,
): { left: number; top: number } {
  const viewportCenter = Math.min(Math.max(trigger.left + trigger.width / 2, 150), viewportWidth - 150)
  return {
    left: viewportCenter - overlay.left,
    top: trigger.top - overlay.top - 8,
  }
}
