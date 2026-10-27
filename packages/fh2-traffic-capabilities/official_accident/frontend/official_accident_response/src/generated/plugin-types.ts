// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// 本文件由 fh2-plugin generate 生成，请勿手改。
// 来源 Manifest: official_accident_response@0.2.1

export type ExtensionId =
  | 'accident-return-route-action'
  | 'accident-return-route-panel'
  | 'accident-approach-target'
  | 'accident-alert-popup'
  | 'accident-sidebar-action'

export interface ExtensionsByHost {
  readonly cockpit: 'accident-return-route-action' | 'accident-return-route-panel' | 'accident-approach-target';
  readonly message: 'accident-alert-popup';
  readonly project: 'accident-sidebar-action';
}

export type ViewId =
  | 'dispatch-card'
  | 'accident-list'
  | 'all-events-dialog'
  | 'return-route-panel'

export interface PluginConfig {
  readonly enableMultiAngle: boolean;
  readonly flowName: string;
}

export type AppCockpitContext = import('fh2-plugin-sdk').CockpitPluginContext<PluginConfig, {
  readonly 'accident-return-route-action': 'cockpit.ui.flight-actions';
  readonly 'accident-return-route-panel': 'cockpit.ui.live-overlay';
  readonly 'accident-approach-target': 'cockpit.ui.live-context-menu';
}>
export type AppMessageContext = import('fh2-plugin-sdk').PluginContext<PluginConfig, {
  readonly 'accident-alert-popup': 'message.alert-popups';
}>
export type AppProjectContext = import('fh2-plugin-sdk').PluginContext<PluginConfig, {
  readonly 'accident-sidebar-action': 'project.sidebar-actions';
}>

export type { CockpitPluginContext, PluginContext } from 'fh2-plugin-sdk'
