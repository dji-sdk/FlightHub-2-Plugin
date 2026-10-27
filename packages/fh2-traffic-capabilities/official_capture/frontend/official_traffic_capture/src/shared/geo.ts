// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 经纬度平面坐标（lng/lat 两字段）：变道抓拍与行人上路共用的最小空间类型。
 *
 * 与 SDK 的 GeoPoint（lng/lat/height 三字段，地图能力输入）不同：
 * 标注持久化与记录 DTO 只携带平面坐标，海拔由 LaneAnnotation.groundHeight
 * 或遥测源单独提供，不落在每个点上。
 */
export interface LngLat {
  readonly lng: number;
  readonly lat: number;
}
