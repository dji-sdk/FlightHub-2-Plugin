// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePluginView } from 'fh2-plugin-sdk/view'
import type { PluginViewClient } from 'fh2-plugin-sdk/view'

export type AnnotationKind = 'solid-line' | 'guide-area'

/**
 * 违章变道抓拍工作台（原生 LaneChangeCapturePanel）：
 * 指定违章类型、标注列表（勾选/重命名/删除）、绘制/编辑、开始/暂停抓拍。
 * 重命名弹窗由 Entry 经 platform:dialog 呈现，View 只发起 requestRename。
 */

export type ViolationTypeFilter = 'solidLine' | 'guideArea' | 'both'

export type CaptureStatus = 'idle' | 'capturing' | 'paused'

export interface WorkbenchAnnotation {
  readonly id: string;
  readonly name: string;
  readonly kind: AnnotationKind;
  readonly loaded: boolean;
  readonly coordinateMode: 'geo' | 'normalized';
  readonly createdAt: number;
}

export interface LaneChangeWorkbenchState {
  readonly panelVisible: boolean;
  readonly panelCollapsed: boolean;
  readonly enabled: boolean;
  readonly captureStatus: CaptureStatus;
  readonly violationType: ViolationTypeFilter;
  readonly annotations: readonly WorkbenchAnnotation[];
  readonly highlightedAnnotationId: string | null;
  readonly drawingKind: AnnotationKind | null;
  readonly editing: boolean;
  readonly captureBusy: boolean;
  readonly message: string | null;
}

// type alias 可被 SDK 的 Readonly<Record<string, unknown>> 约束识别；interface 会丢失索引兼容性。
// eslint-disable-next-line ts/consistent-type-definitions
export type LaneChangeWorkbenchMethods = {
  setCollapsed(input: { readonly collapsed: boolean }): Promise<void>;
  close(): Promise<void>;
  setViolationType(input: { readonly type: ViolationTypeFilter }): Promise<void>;
  toggleAnnotationLoaded(input: { readonly id: string; readonly loaded: boolean }): Promise<void>;
  /** 请求重命名：由 Entry 打开 platform:dialog 承载的重命名弹窗。 */
  requestRename(input: { readonly id: string }): Promise<void>;
  deleteAnnotation(input: { readonly id: string }): Promise<void>;
  setHighlight(input: { readonly id: string | null }): Promise<void>;
  beginDraw(input: { readonly kind: AnnotationKind }): Promise<void>;
  finishEdit(): Promise<void>;
  beginEdit(): Promise<void>;
  toggleCapture(): Promise<void>;
}

interface LaneChangeWorkbenchContract {
  state: LaneChangeWorkbenchState;
  methods: LaneChangeWorkbenchMethods;
}

export const laneChangeWorkbenchView = definePluginView<LaneChangeWorkbenchContract>('lane-change-workbench')

export type LaneChangeWorkbenchClient = PluginViewClient<LaneChangeWorkbenchContract>
