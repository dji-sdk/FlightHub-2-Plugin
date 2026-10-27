// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePluginView } from 'fh2-plugin-sdk/view'
import type { PluginViewClient } from 'fh2-plugin-sdk/view'

/**
 * 「违停车辆」SubLive 证据预览 View 契约。
 * 照片列表由 Entry 加载（初检截图 + 复检照片），View 负责浏览交互。
 */
export interface PreviewState {
  readonly displayName: string;
  readonly photos: readonly string[];
  /** 打开时定位到的照片索引（默认最新一张） */
  readonly initialIndex: number;
}

interface PreviewContract {
  readonly state: PreviewState;
  readonly methods: Record<string, never>;
}

export const previewView = definePluginView<PreviewContract>('patrol-preview')

export type PreviewClient = PluginViewClient<PreviewContract>
