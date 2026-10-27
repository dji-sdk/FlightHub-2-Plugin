// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 变道抓拍领域模型：标注（geo/归一化双坐标）、记录合并、命名与持久化。
 *
 * geo 模式：points 为地面锚定 [lng, lat]，height 为标注所在地面平面海拔；
 * 归一化模式：points 为 [0,1] 画面坐标（geo 锚定失败时的降级）。
 */

import type { LngLat } from '../../../shared/geo'
import type { AnnotationKind } from '../../../views/lane-change-workbench/contract'
import type { VideoPoint } from '../../../views/lane-change-annotation-canvas/contract'
import type { LaneChangePostStatus } from '../../../views/capture-records/lane-change/contract'

export type { LngLat }

export type AnnotationCollisionType = 'solid_line' | 'guide_area'

export type AnnotationCoordinateMode = 'geo' | 'normalized'

export interface LaneAnnotation {
  readonly id: string;
  readonly name: string;
  readonly kind: AnnotationKind;
  /** geo 模式有效：标注所在地面平面海拔（米）。 */
  readonly groundHeight: number | null;
  readonly coordinateMode: AnnotationCoordinateMode;
  readonly points: readonly LngLat[] | readonly VideoPoint[];
  readonly origin: 'manual';
  /** 是否加载到画布并参与检测。 */
  readonly loaded: boolean;
  readonly createdAt: number;
}

export function annotationCollisionType (kind: AnnotationKind): AnnotationCollisionType {
  return kind === 'solid-line' ? 'solid_line' : 'guide_area'
}

const MIN_POINTS: Readonly<Record<AnnotationKind, number>> = {
  'solid-line': 2,
  'guide-area': 3,
}

export function minPointsOf (kind: AnnotationKind): number {
  return MIN_POINTS[kind]
}

export function hasEnoughPoints (kind: AnnotationKind, count: number): boolean {
  return count >= MIN_POINTS[kind]
}

export function nextAnnotationName (annotations: readonly LaneAnnotation[], kind: AnnotationKind): string {
  const prefix = kind === 'solid-line' ? '实线' : '导流区'
  let index = 1
  for (const annotation of annotations) {
    if (annotation.kind === kind && annotation.name.startsWith(prefix)) {
      const suffix = Number(annotation.name.slice(prefix.length).trim())
      if (Number.isFinite(suffix) && suffix >= index) index = suffix + 1
    }
  }
  return `${prefix} ${index}`
}

// === 记录模型 ==============================================================

export interface LaneChangeRecord {
  readonly eventId: string | null;
  readonly eventKey: string;
  readonly collisionType: AnnotationCollisionType;
  readonly crossedAt: number;
  readonly title: string;
  /** 违章发生时截取的实时码流截图 URL。 */
  readonly screenshotUrl: string | null;
  /** 违章发生地点；预览地图标记用。 */
  readonly position: LngLat | null;
  /** 事件是否仍在提交；与返航后的证据后处理无关。 */
  readonly postStatus: LaneChangePostStatus;
  readonly failureReason: string;
}

export function recordTitle (crossedAt: number): string {
  const date = new Date(crossedAt)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `违章变道抓拍_${hh}${mm}${ss}`
}

/**
 * 后端事件与本地截图按稳定 eventKey 精确合并，后端字段优先。
 */
export function mergeRecords (
  backend: ReadonlyArray<{
    readonly eventId: string;
    readonly eventKey: string;
    readonly crossedAt: number;
    readonly collisionType: AnnotationCollisionType | undefined;
    readonly screenshotUrl: string | null;
    readonly position: LngLat | null;
    readonly postStatus: Exclude<LaneChangePostStatus, 'submitting'>;
    readonly failureReason: string;
  }>,
  localRecords: readonly LaneChangeRecord[],
): readonly LaneChangeRecord[] {
  const seenEventKeys = new Set<string>()
  const merged: LaneChangeRecord[] = []

  for (const item of backend) {
    const local = localRecords.find(record => record.eventKey === item.eventKey)
    seenEventKeys.add(item.eventKey)
    merged.push({
      eventId: item.eventId,
      eventKey: item.eventKey,
      collisionType: item.collisionType ?? 'solid_line',
      crossedAt: item.crossedAt,
      title: recordTitle(item.crossedAt),
      screenshotUrl: item.screenshotUrl ?? local?.screenshotUrl ?? null,
      position: item.position ?? local?.position ?? null,
      postStatus: item.postStatus,
      failureReason: item.failureReason,
    })
  }

  for (const record of localRecords) {
    if (seenEventKeys.has(record.eventKey)) continue
    merged.push(record.title === '' ? { ...record, title: recordTitle(record.crossedAt) } : record)
  }

  return merged.sort((left, right) => right.crossedAt - left.crossedAt)
}

// === 持久化 ================================================================

interface StoredAnnotation {
  readonly id: string;
  readonly name: string;
  readonly kind: AnnotationKind;
  readonly groundHeight: number | null;
  readonly coordinateMode: AnnotationCoordinateMode;
  readonly points: ReadonlyArray<readonly number[]>;
  readonly origin: 'manual';
  readonly loaded: boolean;
  readonly createdAt: number;
}

export interface AnnotationKeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export function serializeAnnotations (annotations: readonly LaneAnnotation[]): StoredAnnotation[] {
  return annotations.map(annotation => ({
    id: annotation.id,
    name: annotation.name,
    kind: annotation.kind,
    groundHeight: annotation.groundHeight,
    coordinateMode: annotation.coordinateMode,
    origin: annotation.origin,
    loaded: annotation.loaded,
    createdAt: annotation.createdAt,
    points: annotation.points.map(point => (
      annotation.coordinateMode === 'geo'
        ? [(point as LngLat).lng, (point as LngLat).lat]
        : [(point as VideoPoint).x, (point as VideoPoint).y]
    )),
  }))
}

function groundHeightOf (raw: Record<string, unknown>): number | null {
  return typeof raw.groundHeight === 'number' ? raw.groundHeight : null
}

function buildAnnotation (
  raw: Record<string, unknown>,
  kind: AnnotationKind,
  coordinateMode: AnnotationCoordinateMode,
  points: readonly LngLat[] | readonly VideoPoint[],
  groundHeight: number | null,
): LaneAnnotation {
  return {
    id: typeof raw.id === 'string' ? raw.id : `anno-${Math.random().toString(36).slice(2)}`,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : '未命名标注',
    kind,
    groundHeight,
    coordinateMode,
    points,
    origin: 'manual',
    loaded: raw.loaded !== false,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
  }
}

export function deserializeAnnotations (value: unknown): readonly LaneAnnotation[] | undefined {
  if (!Array.isArray(value)) return undefined
  const annotations: LaneAnnotation[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    const kind = raw.kind === 'guide-area' ? 'guide-area' : 'solid-line'
    const coordinateMode = raw.coordinateMode === 'geo' ? 'geo' : 'normalized'
    const pointsRaw = Array.isArray(raw.points) ? raw.points : []
    if (coordinateMode === 'geo') {
      const geoPoints: LngLat[] = []
      for (const pointRaw of pointsRaw) {
        if (!Array.isArray(pointRaw) || typeof pointRaw[0] !== 'number' || typeof pointRaw[1] !== 'number') continue
        geoPoints.push({ lng: pointRaw[0], lat: pointRaw[1] })
      }
      if (!hasEnoughPoints(kind, geoPoints.length)) continue
      annotations.push(buildAnnotation(raw, kind, 'geo', geoPoints, groundHeightOf(raw)))
    } else {
      const videoPoints: VideoPoint[] = []
      for (const pointRaw of pointsRaw) {
        if (!Array.isArray(pointRaw) || typeof pointRaw[0] !== 'number' || typeof pointRaw[1] !== 'number') continue
        videoPoints.push({ x: pointRaw[0], y: pointRaw[1] })
      }
      if (!hasEnoughPoints(kind, videoPoints.length)) continue
      annotations.push(buildAnnotation(raw, kind, 'normalized', videoPoints, groundHeightOf(raw)))
    }
  }
  return annotations
}
