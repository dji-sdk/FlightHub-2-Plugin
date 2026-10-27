// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePluginView } from 'fh2-plugin-sdk/view'
import type { PluginViewClient } from 'fh2-plugin-sdk/view'

/** 抓拍告警 Toast（原生 AutoCaptureAlertToast）：5 秒自动消失，点击打开记录面板。 */

interface CaptureAlertToastContract {
  state: { readonly visible: boolean; readonly message: string };
  methods: {
    click(): void;
  };
}

export const captureAlertToastView = definePluginView<CaptureAlertToastContract>('capture-alert-toast')

export type CaptureAlertToastClient = PluginViewClient<CaptureAlertToastContract>
