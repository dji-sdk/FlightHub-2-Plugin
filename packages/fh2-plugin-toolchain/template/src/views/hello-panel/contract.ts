// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePluginView } from 'fh2-plugin-sdk'

export interface HelloPanelState {
  readonly count: number;
}

interface HelloPanelContract {
  state: HelloPanelState;
  methods: {
    increment: () => HelloPanelState;
  };
}

export const helloPanelView = definePluginView<HelloPanelContract>('hello-panel')
