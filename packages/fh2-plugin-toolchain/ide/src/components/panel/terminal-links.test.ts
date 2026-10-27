// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { parseTerminalFileLocations } from './terminal-links.js'

describe('terminal file links', () => {
  it('解析相对路径和工作区内绝对路径', () => {
    expect(parseTerminalFileLocations('src/main.ts:12:7 error')[0]).toMatchObject({ path: 'src/main.ts', line: 12, column: 7 })
    expect(parseTerminalFileLocations('at (/work/demo/src/App.vue:3:9)', '/work/demo')[0]).toMatchObject({ path: 'src/App.vue', line: 3, column: 9 })
  })

  it('不把工作区外的绝对路径变成可点击链接', () => {
    expect(parseTerminalFileLocations('/outside/a.ts:1:2', '/work/demo')).toEqual([])
  })
})
