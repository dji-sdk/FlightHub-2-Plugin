// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePluginView } from 'fh2-plugin-sdk'
import type { PluginViewClient } from 'fh2-plugin-sdk'
import { formatDistance, formatDuration } from '../shared/route-format'
import type { DispatchRoute } from '../../workflow/types'

export interface ReturnRoutePanelState {
  readonly phase: 'idle' | 'loading' | 'ready' | 'executing' | 'error';
  readonly routes: readonly DispatchRoute[];
  readonly selectedIndex: number;
  readonly error: string | null;
}

interface ReturnRoutePanelContract {
  state: ReturnRoutePanelState;
  methods: {
    close: () => void;
    refresh: () => void;
    selectRoute: (input: { readonly index: number }) => void;
    execute: () => void;
  };
}

export const returnRoutePanelView = definePluginView<ReturnRoutePanelContract>('return-route-panel')
export type ReturnRoutePanelViewClient = PluginViewClient<ReturnRoutePanelContract>

export function canExecuteReturnRoute (state: ReturnRoutePanelState): boolean {
  return state.phase === 'ready' && state.selectedIndex >= 0 && state.selectedIndex < state.routes.length
}

/** 路线 item 元信息（距离 · 时长），与派遣卡同格式；后端字段缺失（≤0）显示 --。 */
export function formatRouteMeta (route: Pick<DispatchRoute, 'totalDistance' | 'estimatedDuration'>): string {
  const distance = route.totalDistance > 0 ? formatDistance(route.totalDistance) : '--'
  const duration = route.estimatedDuration > 0 ? formatDuration(route.estimatedDuration) : '--'
  return `${distance} · ${duration}`
}
