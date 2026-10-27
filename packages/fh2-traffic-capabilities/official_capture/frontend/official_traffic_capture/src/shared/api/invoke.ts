// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { ApiCallOptions, JsonValue } from 'fh2-plugin-sdk'
import { unwrapApiData } from './api-response'

const PLUGIN_ID = 'official_traffic_capture_backend'
const INVOKE_ENDPOINT = '/plugin/invoke'

export type PluginInvoke = (handler: string, input: Record<string, JsonValue>) => Promise<JsonValue>

export function createPluginInvoke (
  apiCall: (endpoint: string, options?: ApiCallOptions) => Promise<JsonValue>,
): PluginInvoke {
  return (handler, input) => apiCall(INVOKE_ENDPOINT, {
    method: 'POST',
    body: { pluginId: PLUGIN_ID, handler, input },
  }).then(unwrapApiData)
}
