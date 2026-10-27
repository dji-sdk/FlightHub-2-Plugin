// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertPackageMatchesCapability, parsePackageManifest, readPackageManifest, serializePackageManifest } from './manifest.js'
import { packageManifestPath } from './types.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('package manifest', () => {
  it('读取合法 packages.json', async () => {
    const root = await createRoot()
    await writeFile(packageManifestPath(root), JSON.stringify([{
      packageId: 'exp_demo_package',
      name: '状态机示例包',
      capabilityIds: ['exp_demo_capability'],
    }]))

    const entry = readPackageManifest(root)

    expect(entry.packageId).toBe('exp_demo_package')
    expect(entry.name).toBe('状态机示例包')
    expect(entry.capabilityIds).toEqual(['exp_demo_capability'])
    expect(Object.isFrozen(entry)).toBe(true)
  })

  it('文件缺失时抛出 FH2_PACKAGE_MANIFEST_NOT_FOUND', async () => {
    const root = await createRoot()

    expect(() => readPackageManifest(root)).toThrow(/FH2_PACKAGE_MANIFEST_NOT_FOUND|无法读取/)
  })

  it('拒绝非法 JSON、非数组、空数组和多包条目', () => {
    const file = 'packages.json'
    expect(() => parsePackageManifest('{', file)).toThrow(/FH2_PACKAGE_MANIFEST_INVALID|不是合法 JSON/)
    expect(() => parsePackageManifest('{}', file)).toThrow(/必须是 JSON 数组/)
    expect(() => parsePackageManifest('[]', file)).toThrow(/不能是空数组/)
    expect(() => parsePackageManifest('[{"packageId":"a","name":"b","capabilityIds":["c"]},{"packageId":"d","name":"e","capabilityIds":["f"]}]', file))
      .toThrow(/只允许一个包条目/)
  })

  it('拒绝未知字段、缺失字段、空 capabilityIds 和重复 capabilityIds', () => {
    const file = 'packages.json'
    expect(() => parsePackageManifest('[{"packageId":"a","name":"b","capabilityIds":["c"],"extra":1}]', file))
      .toThrow(/未知字段/)
    expect(() => parsePackageManifest('[{"name":"b","capabilityIds":["c"]}]', file)).toThrow(/缺少非空 packageId/)
    expect(() => parsePackageManifest('[{"packageId":"a","capabilityIds":["c"]}]', file)).toThrow(/缺少非空 name/)
    expect(() => parsePackageManifest('[{"packageId":"a","name":"b","capabilityIds":[]}]', file))
      .toThrow(/缺少非空 capabilityIds/)
    expect(() => parsePackageManifest('[{"packageId":"a","name":"b","capabilityIds":["c","c"]}]', file))
      .toThrow(/重复/)
    expect(() => parsePackageManifest('[{"packageId":"a","name":"b","capabilityIds":["c",1]}]', file))
      .toThrow(/非空字符串数组/)
  })

  it('序列化输出规范化 JSON 且可回读', () => {
    const entry = { packageId: 'exp_demo_package', name: '状态机示例包', capabilityIds: ['exp_demo_capability'] }

    const source = serializePackageManifest(entry)
    const parsed = parsePackageManifest(source, 'packages.json')

    expect(source).toBe(`${JSON.stringify([entry], null, 2)}\n`)
    expect(parsed).toEqual(entry)
  })

  it('校验 capabilityIds 与 Capability 根一致', () => {
    const entry = { packageId: 'exp_demo_package', name: '状态机示例包', capabilityIds: ['exp_demo_capability'] }

    expect(() => assertPackageMatchesCapability(entry, 'exp_demo_capability', 'packages.json')).not.toThrow()
    expect(() => assertPackageMatchesCapability(entry, 'exp_other_capability', 'packages.json'))
      .toThrow(/FH2_PACKAGE_CAPABILITY_MISMATCH|必须且只能包含/)
    expect(() => assertPackageMatchesCapability(
      { ...entry, capabilityIds: ['exp_demo_capability', 'exp_other'] },
      'exp_demo_capability',
      'packages.json',
    )).toThrow(/必须且只能包含/)
  })
})

async function createRoot (): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'exp_package_test-'))
  roots.push(root)
  return root
}
