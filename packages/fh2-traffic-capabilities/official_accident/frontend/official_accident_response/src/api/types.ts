// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { JsonValue } from 'fh2-plugin-sdk'

/** 插件网关提供的最小 HTTP 调用签名。 */
export type ApiCall = (endpoint: string, options?: {
  readonly method?: 'GET' | 'POST';
  readonly body?: JsonValue;
}) => Promise<JsonValue>
