// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { closeTargets } from './tab-actions'

describe('closeTargets', () => {
  const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts']

  it('right：返回目标右侧的全部 tab', () => {
    expect(closeTargets(paths, 'a.ts', 'right')).toEqual(['b.ts', 'c.ts', 'd.ts'])
    expect(closeTargets(paths, 'c.ts', 'right')).toEqual(['d.ts'])
  })

  it('right：目标是最后一个 tab 时为空（菜单应禁用）', () => {
    expect(closeTargets(paths, 'd.ts', 'right')).toEqual([])
  })

  it('others：返回除目标外的全部 tab', () => {
    expect(closeTargets(paths, 'a.ts', 'others')).toEqual(['b.ts', 'c.ts', 'd.ts'])
    expect(closeTargets(paths, 'c.ts', 'others')).toEqual(['a.ts', 'b.ts', 'd.ts'])
  })

  it('others：唯一 tab 时为空（菜单应禁用）', () => {
    expect(closeTargets(['only.ts'], 'only.ts', 'others')).toEqual([])
  })

  it('目标不在列表中时返回空，不抛错', () => {
    expect(closeTargets(paths, 'z.ts', 'right')).toEqual([])
    expect(closeTargets(paths, 'z.ts', 'others')).toEqual([])
    expect(closeTargets([], 'a.ts', 'others')).toEqual([])
  })
})
