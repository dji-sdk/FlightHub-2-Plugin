// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 平台 locale 契约。
 *
 * 值与真实宿主认证模块的 `LocaleType` 完全一致（9 种短码，默认 zh）。
 * 真源在宿主仓；本枚举是平台侧的镜像副本，
 * 任一侧新增/删除语言必须同步另一侧，`locale.test.ts` 充当漂移告警。
 *
 * locale 由宿主注入 Engine（`EngineOptions.locale`），以静态快照贯穿
 * Entry `ctx.locale` 与 View `ctx.locale`；宿主切换语言走整页 reload，
 * 平台不做运行时热切换。平台对值只透传、不归一化，插件自行适配。
 */
export enum LocaleType {
  ZH = 'zh',
  EN = 'en',
  FR = 'fr',
  DE = 'de',
  JA = 'ja',
  KO = 'ko',
  PT = 'pt',
  RU = 'ru',
  ES = 'es',
}
