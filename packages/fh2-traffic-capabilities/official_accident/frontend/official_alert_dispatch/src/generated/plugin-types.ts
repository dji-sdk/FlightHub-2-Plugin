// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// 本文件由 fh2-plugin generate 生成，请勿手改。
// 来源 Manifest: official_alert_dispatch@0.2.1

export type ExtensionId =
  | 'alert-dispatch-sidebar-action'

export interface ExtensionsByHost {
  readonly project: 'alert-dispatch-sidebar-action';
}

export type ViewId =
  | 'dispatch-form'
  | 'dispatch-workspace'

export interface PluginConfig {
  readonly enableWorkspaceTest: boolean;
}

export type AppProjectContext = import('fh2-plugin-sdk').PluginContext<PluginConfig, {
  readonly 'alert-dispatch-sidebar-action': 'project.sidebar-actions';
}>

export type { CockpitPluginContext, PluginContext } from 'fh2-plugin-sdk'
