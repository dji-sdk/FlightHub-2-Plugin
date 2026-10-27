// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePluginView } from 'fh2-plugin-sdk/view'
import type { PluginViewClient } from 'fh2-plugin-sdk/view'
import type { AnnotationKind } from '../lane-change-workbench/contract'

export interface VideoPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * 标注画布：绘制/编辑的指针交互在 View 本地完成（命中测试、拖拽、右键菜单），
 * 几何判定与投影归 Controller。Controller 下发已投影的画面坐标形状。
 */

export interface CanvasShape {
  readonly id: string;
  readonly kind: AnnotationKind;
  readonly points: readonly VideoPoint[];
  readonly coordinateMode: 'geo' | 'normalized';
}

export interface LaneChangeCanvasState {
  readonly visible: boolean;
  readonly shapes: readonly CanvasShape[];
  readonly draftPoints: readonly VideoPoint[];
  readonly drawingKind: AnnotationKind | null;
  readonly editing: boolean;
  readonly selectedShapeId: string | null;
  readonly highlightedShapeId: string | null;
}

// type alias 可被 SDK 的 Readonly<Record<string, unknown>> 约束识别；interface 会丢失索引兼容性。
// eslint-disable-next-line ts/consistent-type-definitions
export type LaneChangeCanvasMethods = {
  addDraftPoint(input: { readonly point: VideoPoint }): Promise<void>;
  removeLastDraftPoint(): Promise<void>;
  finishDraft(): Promise<void>;
  cancelDraft(): Promise<void>;
  selectShape(input: { readonly id: string | null }): Promise<void>;
  moveVertex(input: { readonly shapeId: string; readonly vertexIndex: number; readonly point: VideoPoint }): Promise<void>;
  moveShape(input: { readonly shapeId: string; readonly delta: VideoPoint }): Promise<void>;
  insertVertex(input: { readonly shapeId: string; readonly segmentIndex: number; readonly point: VideoPoint }): Promise<void>;
  deleteVertex(input: { readonly shapeId: string; readonly vertexIndex: number }): Promise<void>;
  deleteShape(input: { readonly shapeId: string }): Promise<void>;
}

interface LaneChangeCanvasContract {
  state: LaneChangeCanvasState;
  methods: LaneChangeCanvasMethods;
}

export const laneChangeCanvasView = definePluginView<LaneChangeCanvasContract>('lane-change-annotation-canvas')

export type LaneChangeCanvasClient = PluginViewClient<LaneChangeCanvasContract>

/** geo 点正投到画面的结果缓存键。 */
export type GeoProjectionCache = ReadonlyMap<string, readonly VideoPoint[]>
