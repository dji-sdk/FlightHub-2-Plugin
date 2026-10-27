// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { CapabilityZipError, createDeterministicZip } from '../capability/zip.js'
import { CONTEXT_DISCOVERY_CONTRACT } from './context.js'
import {
  ARTIFACT_LAYOUTS_CONTRACT,
  artifactLayoutDescriptor,
  serializeArtifactLayoutsContract,
} from './artifacts.js'

describe('artifact layouts contract', () => {
  it('覆盖六个布局且 ID 唯一、source 非空、context 存在于上下文契约', () => {
    expect(ARTIFACT_LAYOUTS_CONTRACT.layouts.map(item => item.id)).toEqual([
      'frontend-dist',
      'backend-dist',
      'frontend-plugin-release',
      'backend-plugin-release',
      'capability-upload-zip',
      'workspace-upload-zip',
    ])
    const knownContexts = CONTEXT_DISCOVERY_CONTRACT.contexts.map(context => context.id)
    for (const layout of ARTIFACT_LAYOUTS_CONTRACT.layouts) {
      expect(layout.source.trim().length, `${layout.id} 缺少 source`).toBeGreaterThan(0)
      expect(layout.required.length, `${layout.id} 缺少 required`).toBeGreaterThan(0)
      expect(layout.generated.length, `${layout.id} 缺少 generated`).toBeGreaterThan(0)
      expect(knownContexts, `${layout.id} 的 context 未登记`).toContain(layout.context)
    }
    for (const id of ARTIFACT_LAYOUTS_CONTRACT.layouts.map(item => item.id)) {
      expect(artifactLayoutDescriptor(ARTIFACT_LAYOUTS_CONTRACT, id).id).toBe(id)
    }
  })

  it('dist 布局的必需成员与构建产物一致（写死对照）', () => {
    const frontend = artifactLayoutDescriptor(ARTIFACT_LAYOUTS_CONTRACT, 'frontend-dist')
    expect(frontend.required.some(item => item.startsWith('fh2-plugin.json'))).toBe(true)
    expect(frontend.required.some(item => item.includes('contenthash'))).toBe(true)
    expect(frontend.optional?.some(item => item.includes('views/<viewId>'))).toBe(true)

    const backend = artifactLayoutDescriptor(ARTIFACT_LAYOUTS_CONTRACT, 'backend-dist')
    expect(backend.required).toEqual(['plugin.json（Runtime Manifest；两种构建模式都会产出）'])
    expect(backend.optional?.some(item => item.includes('scripts/handlers.js'))).toBe(true)
    expect(backend.optional?.some(item => item.includes('workflows/'))).toBe(true)
    expect(backend.optional?.some(item => item.includes('schema.sql'))).toBe(true)
    expect(backend.optional?.some(item => item.includes('evaluators/'))).toBe(true)
    // build-info.json 仅本地诊断：出现在 optional 且 notes/排除清单说明 Pack 排除。
    expect(backend.optional?.some(item => item.includes('build-info.json'))).toBe(true)
    expect(backend.optional?.some(item => item.includes('Pack 时排除'))).toBe(true)
  })

  it('独立插件交付物：release 根、zip 前缀与排除清单（关键成员写死抽查）', () => {
    const frontend = artifactLayoutDescriptor(ARTIFACT_LAYOUTS_CONTRACT, 'frontend-plugin-release')
    expect(frontend.root.startsWith('release/<pluginId>/')).toBe(true)
    expect(frontend.archivePrefix).toBe('<pluginId>/')
    expect(frontend.required.some(item => item.startsWith('plugin.json'))).toBe(true)
    expect(frontend.required.some(item => item.includes('dist/fh2-plugin.json'))).toBe(true)
    // 排除清单关键成员（对照 backend/pack.ts DEVELOPMENT_ONLY_FILES/DIRECTORIES 写死）：
    for (const member of ['.DS_Store', 'build-info.json', 'SIGNATURE', 'packages.json', '.fh2/', 'node_modules/', '*.map']) {
      expect(frontend.excluded.some(item => item.includes(member)), `前端交付物排除应含 ${member}`).toBe(true)
    }

    const backend = artifactLayoutDescriptor(ARTIFACT_LAYOUTS_CONTRACT, 'backend-plugin-release')
    expect(backend.archivePrefix).toBe('<pluginId>/')
    expect(backend.required.some(item => item.startsWith('plugin.json'))).toBe(true)
    const backendExcluded = backend.excluded[0] ?? ''
    for (const member of ['.DS_Store', 'build-info.json', 'SIGNATURE', 'packages.json', '.fh2/', 'node_modules/', '*.map']) {
      expect(backendExcluded.includes(member), `后端交付物排除应含 ${member}`).toBe(true)
    }
  })

  it('上传包布局（capability/workspace）：根平铺 zip、必需成员与排除/拒绝集（写死抽查）', () => {
    const capability = artifactLayoutDescriptor(ARTIFACT_LAYOUTS_CONTRACT, 'capability-upload-zip')
    expect(capability.root.startsWith('release/<packageId>/')).toBe(true)
    // zip 根平铺：packages.json 与 <capabilityId>/ 直接位于 zip 根，无 <packageId>/ 前缀。
    expect(capability.archivePrefix).toBe(null)
    expect(capability.required.some(item => item.startsWith('packages.json'))).toBe(true)
    expect(capability.required.some(item => item.includes('<capabilityId>/capabilities.json'))).toBe(true)
    expect(capability.notes?.some(item => item.includes('不套 <packageId>/ 层'))).toBe(true)
    // 排除/拒绝关键成员（对照 capability/pack.ts 写死）：
    for (const member of ['.DS_Store', 'build-info.json', 'SIGNATURE', 'packages.json', '.fh2/', 'node_modules/']) {
      expect(capability.excluded.some(item => item.includes(member)), `上传包排除应含 ${member}`).toBe(true)
    }
    // Backend copy drops maps, but frontend copy and the final ZIP collector do not.
    expect(capability.excluded.some(item => item.includes('*.map') && item.includes('后端 dist 复制'))).toBe(true)
    expect(ARTIFACT_LAYOUTS_CONTRACT.exclusions.notes.some(item => item.includes('不排除 *.map'))).toBe(true)

    const workspace = artifactLayoutDescriptor(ARTIFACT_LAYOUTS_CONTRACT, 'workspace-upload-zip')
    expect(workspace.archivePrefix).toBe(null)
    expect(workspace.required.some(item => item.startsWith('packages.json'))).toBe(true)
    expect(workspace.required.some(item => item.includes('<capabilityId>/capabilities.json'))).toBe(true)
    expect(workspace.excluded.some(item => item.includes('capability-upload-zip'))).toBe(true)
  })

  it('exclusions 摘要与源码排除常量一致（关键成员写死抽查）', () => {
    // platformOwned 对照 capability/pack.ts PLATFORM_OWNED_FILES 写死。
    expect(ARTIFACT_LAYOUTS_CONTRACT.exclusions.platformOwned).toEqual(['SIGNATURE', 'packages.json'])
    // developmentOnly 关键成员对照 capability/pack.ts 与 backend/pack.ts 写死。
    for (const member of ['.DS_Store', 'build-info.json', '.fh2', 'node_modules']) {
      expect(ARTIFACT_LAYOUTS_CONTRACT.exclusions.developmentOnly).toContain(member)
    }
  })

  it('archivePolicy 与 createDeterministicZip 真实行为一致（探针）', () => {
    expect(ARTIFACT_LAYOUTS_CONTRACT.archivePolicy.compressionLevel).toBe(9)
    expect(ARTIFACT_LAYOUTS_CONTRACT.archivePolicy.pathOrder.includes('升序')).toBe(true)
    // Windows 保留名 / 保留路径段拒绝。
    expect(() => createDeterministicZip([{ path: 'CON.txt', data: Buffer.from('x') }])).toThrow(CapabilityZipError)
    expect(() => createDeterministicZip([{ path: 'com1/x.txt', data: Buffer.from('x') }])).toThrow(CapabilityZipError)
    expect(() => createDeterministicZip([{ path: 'aux.txt', data: Buffer.from('x') }])).toThrow(CapabilityZipError)
    // 不安全路径段拒绝（..、反斜杠、段尾点）。
    expect(() => createDeterministicZip([{ path: 'a/../b.txt', data: Buffer.from('x') }])).toThrow(CapabilityZipError)
    expect(() => createDeterministicZip([{ path: 'a\\b.txt', data: Buffer.from('x') }])).toThrow(CapabilityZipError)
    expect(() => createDeterministicZip([{ path: 'a./b.txt', data: Buffer.from('x') }])).toThrow(CapabilityZipError)
    // 重复条目拒绝。
    expect(() => createDeterministicZip([
      { path: 'a.txt', data: Buffer.from('x') },
      { path: 'a.txt', data: Buffer.from('y') },
    ])).toThrow(CapabilityZipError)
    // 条目按路径字典序升序：首个 local file header 的文件名应为 a.txt。
    const zip = createDeterministicZip([
      { path: 'b.txt', data: Buffer.from('bbb') },
      { path: 'a.txt', data: Buffer.from('aaa') },
    ])
    expect(zip.readUInt32LE(0)).toBe(0x04034B50)
    const nameLength = zip.readUInt16LE(26)
    expect(zip.subarray(30, 30 + nameLength).toString('utf8')).toBe('a.txt')
  })

  it('序列化双跑字节一致且契约对象冻结', () => {
    expect(serializeArtifactLayoutsContract()).toBe(serializeArtifactLayoutsContract())
    expect(Object.isFrozen(ARTIFACT_LAYOUTS_CONTRACT)).toBe(true)
    expect(Object.isFrozen(ARTIFACT_LAYOUTS_CONTRACT.layouts)).toBe(true)
    expect(Object.isFrozen(ARTIFACT_LAYOUTS_CONTRACT.exclusions)).toBe(true)
    expect(Object.isFrozen(ARTIFACT_LAYOUTS_CONTRACT.archivePolicy)).toBe(true)
    for (const layout of ARTIFACT_LAYOUTS_CONTRACT.layouts) {
      expect(Object.isFrozen(layout)).toBe(true)
      expect(Object.isFrozen(layout.required)).toBe(true)
      expect(Object.isFrozen(layout.excluded)).toBe(true)
    }
  })
})
