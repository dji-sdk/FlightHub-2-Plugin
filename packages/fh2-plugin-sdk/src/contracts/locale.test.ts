// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { LocaleType } from './locale.js'

/**
 * locale 枚举漂移告警。
 *
 * 真源：宿主仓认证模块的 LocaleType。
 * 本枚举是平台侧镜像副本；宿主增删语言时两侧必须同步修改。
 */
describe('localeType 与宿主枚举对齐', () => {
  it('枚举值列表与宿主 LocaleType 逐项一致', () => {
    expect(Object.values(LocaleType)).toEqual(['zh', 'en', 'fr', 'de', 'ja', 'ko', 'pt', 'ru', 'es'])
  })

  it('键名与宿主枚举键一致', () => {
    expect(Object.keys(LocaleType)).toEqual(['ZH', 'EN', 'FR', 'DE', 'JA', 'KO', 'PT', 'RU', 'ES'])
  })

  it('默认语言是 zh（宿主 DEFAULT_LANGUAGE）', () => {
    expect(LocaleType.ZH).toBe('zh')
  })
})
