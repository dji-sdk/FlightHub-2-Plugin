// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// 本文件由 fh2-plugin generate 生成，请勿手改。
// 来源 Manifest: official_wayline_teach@0.3.1

export type ExtensionId =
  | 'wayline-teach-entry'
  | 'wayline-teach-panel'

export interface ExtensionsByHost {
  readonly cockpit: 'wayline-teach-entry' | 'wayline-teach-panel';
}

export type ViewId =
  | 'teach-panel'
  | 'teach-dialog'

export interface PluginConfig {
  readonly enableMock: boolean;
}

export type AppCockpitContext = import('fh2-plugin-sdk').CockpitPluginContext<PluginConfig, {
  readonly 'wayline-teach-entry': 'cockpit.ui.toolbar-actions';
  readonly 'wayline-teach-panel': 'cockpit.ui.left-bottom-panels';
}>

export type { CockpitPluginContext, PluginContext } from 'fh2-plugin-sdk'
