// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// 本文件由 fh2-plugin types 生成,勿手改。
// 世界规则:文件可用的全局 = 会加载它的沙箱注入面交集(∩ 本插件 allowlist)。
// 来源契约: 1.1.0 / sha256:89b408e35f8dde5623f17c3965710634c11e6bd3ae8e7f5716fedcff1364f0c7

// 世界 shared-call:可用全局 flow, log, media, notify, objectTrack, store, video

declare const flow: import('fh2-plugin-sdk/backend').FlowApi

declare const log: import('fh2-plugin-sdk/backend').LogApi

declare const media: import('fh2-plugin-sdk/backend').MediaApi

declare const notify: import('fh2-plugin-sdk/backend').NotifyApi

declare const objectTrack: import('fh2-plugin-sdk/backend').ObjectTrackApi

declare const store: import('fh2-plugin-sdk/backend').StoreApi

declare const video: import('fh2-plugin-sdk/backend').VideoApi
