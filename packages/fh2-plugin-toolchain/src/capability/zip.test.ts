// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { CapabilityZipError, createDeterministicZip } from './zip.js'

describe('capability zip', () => {
  it('按路径排序并产生字节稳定的 ZIP', () => {
    const first = createDeterministicZip([
      { path: 'b.txt', data: Buffer.from('b') },
      { path: 'a.txt', data: Buffer.from('a') },
    ])
    const second = createDeterministicZip([
      { path: 'a.txt', data: Buffer.from('a') },
      { path: 'b.txt', data: Buffer.from('b') },
    ])

    expect(first.equals(second)).toBe(true)
    expect(first.subarray(0, 2).toString('utf8')).toBe('PK')
    expect(first.toString('utf8')).toContain('a.txt')
    expect(first.toString('utf8')).toContain('b.txt')
  })

  it.each([
    '../escape.txt',
    '/absolute.txt',
    'C:/escape.txt',
    'C:escape.txt',
    'a:stream.js',
    'a?.js',
    'NUL.txt',
    'COM¹.js',
    'file.',
    'dir\\file.txt',
    'dir//file.txt',
  ])('拒绝不安全条目 %s', (path) => {
    expect(() => createDeterministicZip([{ path, data: Buffer.from('x') }]))
      .toThrow(CapabilityZipError)
  })

  it('拒绝只在 Windows 大小写不同的条目', () => {
    expect(() => createDeterministicZip([
      { path: 'assets/Icon.svg', data: Buffer.from('first') },
      { path: 'assets/icon.svg', data: Buffer.from('second') },
    ])).toThrow(CapabilityZipError)
  })

  it('拒绝 Windows 上文件与目录冲突的条目', () => {
    expect(() => createDeterministicZip([
      { path: 'Foo/bar.js', data: Buffer.from('nested') },
      { path: 'foo', data: Buffer.from('file') },
    ])).toThrow(CapabilityZipError)
  })
})
