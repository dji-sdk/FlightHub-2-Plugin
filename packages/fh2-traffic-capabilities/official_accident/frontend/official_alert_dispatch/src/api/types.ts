// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { ApiCallOptions, JsonValue } from 'fh2-plugin-sdk'

/** 插件网关 HTTP 调用签名；options 复用 SDK 的 ApiCallOptions。 */
export type ApiCall = (endpoint: string, options?: ApiCallOptions) => Promise<JsonValue>
