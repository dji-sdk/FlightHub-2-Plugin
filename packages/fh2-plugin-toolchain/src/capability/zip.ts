// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { deflateRawSync } from 'node:zlib'
import { WINDOWS_RESERVED_NAMES, ZIP_COMPRESSION_LEVEL, compareArchivePaths, useDeflate } from './policy.js'

export interface ZipEntry {
  readonly path: string;
  readonly data: Uint8Array;
}

export class CapabilityZipError extends Error {
  constructor (readonly code: string, message: string) {
    super(message)
    this.name = 'CapabilityZipError'
  }
}

const windowsReservedNames = new Set(WINDOWS_RESERVED_NAMES)

export function createDeterministicZip (entries: readonly ZipEntry[]): Buffer {
  const normalized = entries.map(entry => ({ path: validatePath(entry.path), data: Buffer.from(entry.data) }))
    .sort((left, right) => compareArchivePaths(left.path, right.path))
  const seen = new Set<string>()
  const windowsPaths = new Map<string, 'file' | 'directory'>()
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of normalized) {
    if (seen.has(entry.path)) throw new CapabilityZipError('FH2_CAPABILITY_PACK_PATH_DUPLICATE', `ZIP 条目重复：${entry.path}`)
    seen.add(entry.path)
    assertWindowsPathCompatible(entry.path, windowsPaths)
    const name = Buffer.from(entry.path, 'utf8')
    const deflated = deflateRawSync(entry.data, { level: ZIP_COMPRESSION_LEVEL })
    const compressed = useDeflate(deflated.byteLength, entry.data.byteLength) ? deflated : entry.data
    const method = compressed === deflated ? 8 : 0
    const crc = crc32(entry.data)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034B50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0x0800, 6)
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt16LE(0, 10)
    localHeader.writeUInt16LE(0x0021, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(compressed.byteLength, 18)
    localHeader.writeUInt32LE(entry.data.byteLength, 22)
    localHeader.writeUInt16LE(name.byteLength, 26)
    localHeader.writeUInt16LE(0, 28)
    local.push(localHeader, name, compressed)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014B50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt16LE(0, 12)
    centralHeader.writeUInt16LE(0x0021, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(compressed.byteLength, 20)
    centralHeader.writeUInt32LE(entry.data.byteLength, 24)
    centralHeader.writeUInt16LE(name.byteLength, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    central.push(centralHeader, name)
    offset += localHeader.byteLength + name.byteLength + compressed.byteLength
  }
  const centralData = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054B50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(normalized.length, 8)
  end.writeUInt16LE(normalized.length, 10)
  end.writeUInt32LE(centralData.byteLength, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...local, centralData, end])
}

function assertWindowsPathCompatible (
  path: string,
  paths: Map<string, 'file' | 'directory'>,
): void {
  const segments = path.split('/')
  for (let index = 0; index < segments.length; index += 1) {
    const key = segments.slice(0, index + 1).join('/').toLowerCase()
    const kind = index === segments.length - 1 ? 'file' : 'directory'
    const existing = paths.get(key)
    if (existing !== undefined && (existing !== kind || kind === 'file')) {
      throw new CapabilityZipError('FH2_CAPABILITY_PACK_PATH_DUPLICATE', `ZIP 条目在 Windows 上冲突：${path}`)
    }
    paths.set(key, kind)
  }
}

function validatePath (path: string): string {
  if (path === ''
    || path.startsWith('/')
    || /^[a-zA-Z]:/.test(path)
    || path.includes('\\')
    || path.split('/').some(segment => !isPortablePathSegment(segment))) {
    throw new CapabilityZipError('FH2_CAPABILITY_PACK_PATH_UNSAFE', `ZIP 条目路径不安全：${path}`)
  }
  return path
}

function isPortablePathSegment (segment: string): boolean {
  if (segment === '' || segment === '.' || segment === '..'
    || hasWindowsForbiddenCharacter(segment)
    || segment.endsWith('.') || segment.endsWith(' ')) {
    return false
  }
  const baseName = segment.split('.')[0]?.toUpperCase()
  return baseName === undefined || !windowsReservedNames.has(baseName)
}

function hasWindowsForbiddenCharacter (segment: string): boolean {
  for (const character of segment) {
    if ('<>:"|?*'.includes(character) || character.charCodeAt(0) < 0x20) return true
  }
  return false
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32 (data: Uint8Array): number {
  let value = 0xFFFFFFFF
  for (const byte of data) value = CRC32_TABLE[(value ^ byte) & 0xFF]! ^ (value >>> 8)
  return (value ^ 0xFFFFFFFF) >>> 0
}
