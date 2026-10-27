// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// 本文件由 fh2-plugin-toolchain typegen 生成,勿手改。
// 来源契约: 平台契约 backend catalog 与 errors（contractsVersion 1.1.0）。
// 重新生成: WRITE_BACKEND_TYPES=1 pnpm --filter fh2-plugin-toolchain test -- src/backend/typegen
// 返回形状未经 fixture 验证(coverage 缺口):来自对 hostapi.go screenshotFns 的核实。objectKey 为条件字段(仅非空时出现)。

import type { ScreenshotUploadGrant } from './refs.js'

/** 截图能力:能力按插件 allowlist 在当前三种 form 注入。signUrl 换预签名 GET URL;issueUpload 签发直传凭据(三件套只进本次 HTTP 响应)。 */
export interface ScreenshotApi {
  signUrl(objectKey: string): string

  issueUpload(request: { routeId: string; waypointId: string }): ScreenshotUploadGrant

}
