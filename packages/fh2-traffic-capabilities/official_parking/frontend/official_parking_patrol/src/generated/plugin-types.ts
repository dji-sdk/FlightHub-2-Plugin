// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// 本文件由 fh2-plugin generate 生成，请勿手改。
// 来源 Manifest: official_parking_patrol@1.1.1

export type ExtensionId =
  | 'patrol-menubar'
  | 'patrol-records'
  | 'patrol-preview'
  | 'patrol-task-panel'
  | 'patrol-form'

export interface ExtensionsByHost {
  readonly cockpit: 'patrol-menubar' | 'patrol-records' | 'patrol-preview' | 'patrol-task-panel';
  readonly plan: 'patrol-form';
}

export type ViewId =
  | 'patrol-task-panel'
  | 'patrol-records'
  | 'patrol-preview'
  | 'patrol-dialog'
  | 'patrol-form'

export interface PluginConfig {
  readonly enableMock: boolean;
}

export type AppCockpitContext = import('fh2-plugin-sdk').CockpitPluginContext<PluginConfig, {
  readonly 'patrol-menubar': 'cockpit.ui.menubar';
  readonly 'patrol-records': 'cockpit.ui.left-panel';
  readonly 'patrol-preview': 'cockpit.ui.sublive-tab';
  readonly 'patrol-task-panel': 'cockpit.ui.live-overlay';
}>
export type AppPlanContext = import('fh2-plugin-sdk').PluginContext<PluginConfig, {
  readonly 'patrol-form': 'plan.form-extensions';
}>

export type { CockpitPluginContext, PluginContext } from 'fh2-plugin-sdk'
