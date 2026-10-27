// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { aliasesForHandlerEntry, wrapperNameForHandlerExport } from './handler-names.js'

describe('backend handler names', () => {
  it('根据目录与 export 生成稳定 h_ wrapper 名', () => {
    expect(wrapperNameForHandlerExport('handlers/lane-change/start-mode.js', 'startMode'))
      .toBe('h_laneChange_startMode')
    expect(wrapperNameForHandlerExport('handlers/illegal-road/index.js', 'getStatus'))
      .toBe('h_illegalRoad_getStatus')
  })

  it('为 h_ wrapper 派生两种兼容 HTTP 名', () => {
    expect(aliasesForHandlerEntry('h_laneChange_startMode')).toEqual([
      'laneChange_startMode',
      'lane-change.start-mode',
    ])
    expect(aliasesForHandlerEntry('h_teach_createScreenshotSTS')).toEqual([
      'teach_createScreenshotSTS',
      'teach.create-screenshot-sts',
    ])
  })

  it('不从不符合约定的历史 h_ 名猜测别名', () => {
    expect(aliasesForHandlerEntry('h_legacyEvent')).toEqual([])
    expect(wrapperNameForHandlerExport('handlers/start-mode.js', 'startMode')).toBeUndefined()
    expect(wrapperNameForHandlerExport('handlers/lane-change/mode/start-mode.js', 'startMode')).toBeUndefined()
  })
})
