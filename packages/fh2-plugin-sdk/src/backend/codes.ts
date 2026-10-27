// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// 本文件由 fh2-plugin-toolchain typegen 生成,勿手改。
// 来源契约: 平台契约 backend catalog 与 errors（contractsVersion 1.1.0）。
// 重新生成: WRITE_BACKEND_TYPES=1 pnpm --filter fh2-plugin-toolchain test -- src/backend/typegen
// 本文件是机器生成的事实值域:改动它们的唯一途径是改 worker 侧实现并同步契约。

export type Capability = 'cache:read' | 'cache:write' | 'config:get' | 'data:read' | 'data:write' | 'egress:fetch' | 'event:write' | 'flow:start' | 'geo.segment:read' | 'integration.gis:read' | 'integration:write' | 'media:read' | 'media:write' | 'notify:publish' | 'screenshot:issueupload' | 'screenshot:signurl' | 'track:read' | 'video:process' | 'wayline:generate'

export type StoreErrorCode = 'DUPLICATE' | 'EMPTY_FILTER' | 'INVALID_FILTER' | 'LIMIT_EXCEEDED' | 'PERMISSION_DENIED' | 'STORAGE_ERROR' | 'TYPE_MISMATCH' | 'UNKNOWN_ENTITY' | 'UNKNOWN_FIELD'

export type CacheErrorCode = 'KEY_TOO_LONG' | 'LIMIT_EXCEEDED' | 'PERMISSION_DENIED' | 'STORAGE_ERROR' | 'TTL_INVALID' | 'TYPE_MISMATCH' | 'VALUE_TOO_LARGE'

/** 筛选算子名(host-surface 行为探测的接受集)。 */
export type FilterOperatorName = 'contains' | 'endsWith' | 'eq' | 'gt' | 'gte' | 'in' | 'isNotNull' | 'isNull' | 'lt' | 'lte' | 'neq' | 'nin' | 'startsWith'

export type QueryOptionsKey = 'limit' | 'offset' | 'orderBy'

export type OrderBySyntax = 'keyed' | 'singleKey'
