// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// 本文件由 fh2-plugin generate 生成，请勿手改。
// 来源 Manifest: official_traffic_capture@1.1.2

export type ExtensionId =
  | 'traffic-capture-popover-entry'
  | 'capture-records'
  | 'capture-preview'
  | 'lane-change-workbench'
  | 'lane-change-annotation-canvas'
  | 'person-road-skip-hint'
  | 'capture-alert-toast'

export interface ExtensionsByHost {
  readonly cockpit: 'traffic-capture-popover-entry' | 'capture-records' | 'capture-preview' | 'lane-change-workbench' | 'lane-change-annotation-canvas' | 'person-road-skip-hint' | 'capture-alert-toast';
}

export type ViewId =
  | 'capture-settings'
  | 'lane-change-workbench'
  | 'lane-change-rename-dialog'
  | 'lane-change-annotation-canvas'
  | 'capture-records'
  | 'capture-evidence-preview'
  | 'person-road-skip-hint'
  | 'capture-alert-toast'

export interface PluginConfig {
  readonly enableMock: boolean;
}

export type AppCockpitContext = import('fh2-plugin-sdk').CockpitPluginContext<PluginConfig, {
  readonly 'traffic-capture-popover-entry': 'cockpit.ui.toolbar-actions';
  readonly 'capture-records': 'cockpit.ui.left-panel';
  readonly 'capture-preview': 'cockpit.ui.sublive-tab';
  readonly 'lane-change-workbench': 'cockpit.ui.left-bottom-panels';
  readonly 'lane-change-annotation-canvas': 'cockpit.ui.live-overlay';
  readonly 'person-road-skip-hint': 'cockpit.ui.live-overlay';
  readonly 'capture-alert-toast': 'cockpit.ui.live-overlay';
}>

export type { CockpitPluginContext, PluginContext } from 'fh2-plugin-sdk'
