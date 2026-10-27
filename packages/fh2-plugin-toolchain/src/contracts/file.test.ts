// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { FILE_CONFLICT_CODE, parseFileSnapshot } from './file.js'

const snapshot = {
  path: 'frontend/demo/src/main.ts',
  content: 'export {}',
  revision: 'a'.repeat(64),
  encoding: 'utf-8' as const,
}

describe('fileSnapshot', () => {
  it('接受合法快照', () => {
    expect(parseFileSnapshot(snapshot)).toEqual(snapshot)
  })

  it('encoding 缺省视为 utf-8', () => {
    const { encoding: _encoding, ...rest } = snapshot
    expect(parseFileSnapshot(rest)).toEqual({ ...rest, encoding: 'utf-8' })
  })

  it('拒绝非 utf-8 编码与缺失字段', () => {
    expect(parseFileSnapshot({ ...snapshot, encoding: 'base64' })).toBeNull()
    expect(parseFileSnapshot({ ...snapshot, path: '' })).toBeNull()
    expect(parseFileSnapshot({ ...snapshot, revision: '' })).toBeNull()
    expect(parseFileSnapshot({ ...snapshot, content: 42 })).toBeNull()
    expect(parseFileSnapshot(null)).toBeNull()
  })
})

describe('文件冲突契约', () => {
  it('冲突码固定为 FH2_FILE_CONFLICT，载荷携带磁盘快照', () => {
    const conflict = {
      code: FILE_CONFLICT_CODE,
      message: '文件已被外部修改。File changed externally.',
      disk: snapshot,
    }
    expect(conflict.code).toBe('FH2_FILE_CONFLICT')
    expect(conflict.disk.revision).toBe(snapshot.revision)
  })
})
