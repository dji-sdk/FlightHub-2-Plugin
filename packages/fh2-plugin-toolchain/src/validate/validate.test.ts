// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { points } from 'fh2-plugin-sdk'
import type { FieldSpec } from 'fh2-plugin-sdk'
import type { ValidationDiagnostic } from './diagnostics.js'
import { SdkRuntimeContractError } from './sdk-resolver.js'
import {
  formatValidationResultJson,
  formatValidationResultText,
  sortValidationDiagnostics,
  validateSourceManifest,
  validateSourceManifestSnapshot,
} from './index.js'
import type { ValidationDependencies } from './index.js'

const SDK_VERSION = '1.0.0-alpha.0'
const SDK_CONTEXT = {
  projectSdkVersion: SDK_VERSION,
  runtimeContract: {
    schemaVersion: 1 as const,
    manifestVersion: 1,
    platformVersion: '1.0.0',
    platformRange: '>=1.0.0-alpha.0 <2.0.0',
  },
}
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const VALID_MANIFEST = {
  id: 'exp_validation',
  name: '校验插件',
  version: '1.2.3-beta.1+build.5',
  entry: './plugin.js',
  extensions: [{ id: 'hello-action', point: 'cockpit.ui.toolbar-actions' }],
  views: { 'hello-view': { entry: './views/hello-view.js' } },
  contributes: { icons: [{ id: 'hello-icon', src: './icons/hello.svg#glyph' }] },
  config: {
    enabled: { type: 'boolean', default: true, label: '开关' },
    retries: { type: 'number', default: 2, label: '重试', min: 1, max: 3 },
    level: { type: 'string', default: 'info', label: '级别', enum: ['info', 'warning'] },
  },
}

const temporaryDirectories: string[] = []
const dependencies: ValidationDependencies = {
  resolveProjectSdkContext: () => SDK_CONTEXT,
  toolchainSdkVersion: SDK_VERSION,
  pointCatalog: points,
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('validateSourceManifest strict parse 与 SDK', () => {
  it('返回合法的不可变 Manifest 快照且不读取声明的源码或 dist', () => {
    const result = validate(VALID_MANIFEST)
    expect(result.ok ? [] : result.diagnostics).toEqual([])
    expect(result).toMatchObject({ ok: true, manifest: VALID_MANIFEST })
    if (result.ok) {
      expect(Object.isFrozen(result.manifest)).toBe(true)
      expect(Object.isFrozen(result.manifest.views)).toBe(true)
      expect(result.sdkContext.runtimeContract).toEqual(SDK_CONTEXT.runtimeContract)
    }
  })

  it('报告读取失败', () => {
    const result = validateSourceManifestSnapshot(
      { manifestPath: join(tmpdir(), 'fh2-does-not-exist/fh2-plugin.json') },
      dependencies,
    )
    expect(codes(result)).toEqual(['FH2_MANIFEST_READ_FAILED'])
  })

  it.each([
    ['注释', '{/* comment */"id":"x"}'],
    ['尾逗号', '{"id":"x",}'],
    ['损坏 JSON', '{"id":'],
  ])('拒绝%s', (_name, source) => {
    expect(codes(validateRaw(source))).toContain('FH2_MANIFEST_JSON_INVALID')
  })

  it('拒绝任意层级重复 key 并给出 1-based 位置和路径', () => {
    const result = validateRaw(`{
  "id": "exp_duplicate",
  "id": "exp_again",
  "name": "重复",
  "version": "1.0.0",
  "entry": "./plugin.js",
  "extensions": [],
  "config": { "enabled": { "type": "boolean", "default": true, "default": false, "label": "开关" } }
}`)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'FH2_MANIFEST_DUPLICATE_KEY', path: 'id', line: 3, column: 3 }),
      expect.objectContaining({ code: 'FH2_MANIFEST_DUPLICATE_KEY', path: 'config.enabled.default', line: 8 }),
    ]))
  })

  it('要求项目 SDK 与 Toolchain SDK 精确一致且不做 SemVer 兜底', () => {
    const result = validate(VALID_MANIFEST, {
      ...dependencies,
      resolveProjectSdkContext: () => ({ ...SDK_CONTEXT, projectSdkVersion: '2.0.0-alpha.1' }),
    })
    expect(codes(result)).toEqual(['FH2_SDK_VERSION_MISMATCH'])
  })

  it('项目 SDK runtime-contract metadata 缺失或无效时使用独立诊断', () => {
    const result = validate(VALID_MANIFEST, {
      ...dependencies,
      resolveProjectSdkContext: () => {
        throw new SdkRuntimeContractError('runtime-contract invalid')
      },
    })
    expect(codes(result)).toEqual(['FH2_SDK_RUNTIME_CONTRACT_INVALID'])
  })
})

describe('validateSourceManifest Schema、Source 与 Semantic', () => {
  it.each([
    ['required', without(VALID_MANIFEST, 'name')],
    ['type', { ...VALID_MANIFEST, extensions: 'wrong' }],
    ['additionalProperties', { ...VALID_MANIFEST, title: '未知字段' }],
    ['enum', { ...VALID_MANIFEST, permissions: ['unknown:permission'] }],
    ['point enum', { ...VALID_MANIFEST, extensions: [{ id: 'invalid', point: 'cockpit.menubar-actions' }] }],
    ['pattern', { ...VALID_MANIFEST, id: 'Invalid ID' }],
  ])('把 SDK Schema %s 错误映射为独立诊断', (_name, manifest) => {
    const result = validate(manifest)
    expect(codes(result)).toContain('FH2_MANIFEST_SCHEMA_INVALID')
  })

  it('拒绝 Config field 中 SDK 未声明的 option', () => {
    const result = validate({
      ...VALID_MANIFEST,
      config: {
        enabled: { type: 'boolean', default: true, label: '开关', unknown: true },
      },
    })
    expect(codes(result)).toContain('FH2_MANIFEST_SCHEMA_INVALID')
  })

  it('数字 Config key 保持对象路径语义和准确位置', () => {
    const source = JSON.stringify({
      ...VALID_MANIFEST,
      config: {
        123: { type: 'number', default: 'wrong', label: '数字 key' },
      },
    }, null, 2)
    const result = validateRaw(source)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'FH2_CONFIG_DEFAULT_TYPE',
      path: 'config["123"].default',
      line: expect.any(Number),
      column: expect.any(Number),
    }))
  })

  it('schema propertyNames 诊断定位到非法 View key', () => {
    const result = validate({
      ...VALID_MANIFEST,
      views: { '-bad': { entry: './views/-bad.js' } },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'FH2_MANIFEST_SCHEMA_INVALID',
      path: 'views["-bad"]',
    }))
  })

  it.each(['manifestVersion', 'engines', 'buildInfo'] as const)('拒绝 Source 构建字段 %s', (field) => {
    const values = {
      manifestVersion: 1,
      engines: { platform: '>=1 <2' },
      buildInfo: { sdkVersion: SDK_VERSION, toolchainVersion: SDK_VERSION },
    }
    expect(codes(validate({ ...VALID_MANIFEST, [field]: values[field] }))).toContain('FH2_SOURCE_BUILD_FIELD')
  })

  it.each(['trusted', 'trustLevel', 'sandbox'])('把信任字段 %s 映射为明确诊断而非通用 Schema 错误', (field) => {
    const result = validate({ ...VALID_MANIFEST, [field]: 'trusted' })
    expect(codes(result)).toEqual(['FH2_SOURCE_TRUST_FIELD'])
  })

  it.each(['v1.2.3', '1.2', ' 1.2.3', 'not-semver'])('拒绝非严格 SemVer %s', (version) => {
    expect(codes(validate({ ...VALID_MANIFEST, version }))).toContain('FH2_PLUGIN_VERSION_INVALID')
  })

  it('报告重复 Extension 与 Icon ID', () => {
    const result = validate({
      ...VALID_MANIFEST,
      extensions: [...VALID_MANIFEST.extensions, VALID_MANIFEST.extensions[0]],
      contributes: { icons: [...VALID_MANIFEST.contributes.icons, VALID_MANIFEST.contributes.icons[0]] },
    })
    expect(codes(result)).toEqual(expect.arrayContaining(['FH2_EXTENSION_ID_DUPLICATE', 'FH2_ICON_ID_DUPLICATE']))
  })

  it.each([
    ['default 类型', { flag: { type: 'boolean', default: 'yes', label: 'Flag' } }, 'FH2_CONFIG_DEFAULT_TYPE'],
    ['range', { count: { type: 'number', default: 2, label: 'Count', min: 3, max: 1 } }, 'FH2_CONFIG_RANGE_INVALID'],
    ['default 越界', { count: { type: 'number', default: 4, label: 'Count', min: 1, max: 3 } }, 'FH2_CONFIG_DEFAULT_OUT_OF_RANGE'],
    ['空 enum', { mode: { type: 'string', default: 'a', label: 'Mode', enum: [] } }, 'FH2_CONFIG_ENUM_INVALID'],
    ['enum 不含 default', { mode: { type: 'string', default: 'b', label: 'Mode', enum: ['a'] } }, 'FH2_CONFIG_ENUM_INVALID'],
    ['boolean option', { flag: { type: 'boolean', default: true, label: 'Flag', min: 1 } }, 'FH2_CONFIG_OPTION_NOT_ALLOWED'],
    ['number option', { count: { type: 'number', default: 1, label: 'Count', enum: ['1'] } }, 'FH2_CONFIG_OPTION_NOT_ALLOWED'],
    ['string option', { mode: { type: 'string', default: 'a', label: 'Mode', max: 2 } }, 'FH2_CONFIG_OPTION_NOT_ALLOWED'],
  ])('校验 Config %s', (_name, config, code) => {
    expect(codes(validate({ ...VALID_MANIFEST, config }))).toContain(code)
  })
})

describe('validateSourceManifest 资源路径', () => {
  it.each([
    ['非 ./', '/plugin.js', 'FH2_RESOURCE_PATH_INVALID'],
    ['空路径', './', 'FH2_RESOURCE_PATH_INVALID'],
    ['双斜杠', './/plugin.js', 'FH2_RESOURCE_PATH_INVALID'],
    ['反斜杠', './views\\plugin.js', 'FH2_RESOURCE_PATH_INVALID'],
    ['明文穿越', './../plugin.js', 'FH2_RESOURCE_PATH_TRAVERSAL'],
    ['编码穿越', './%2e%2e/plugin.js', 'FH2_RESOURCE_PATH_TRAVERSAL'],
    ['编码分隔符', './views%2fplugin.js', 'FH2_RESOURCE_PATH_TRAVERSAL'],
    ['双重编码', './%252e%252e/plugin.js', 'FH2_RESOURCE_PATH_TRAVERSAL'],
    ['query', './plugin.js?v=1', 'FH2_ENTRY_QUERY_NOT_ALLOWED'],
    ['fragment', './plugin.js#entry', 'FH2_ENTRY_QUERY_NOT_ALLOWED'],
    ['扩展名', './plugin.ts', 'FH2_ENTRY_EXTENSION_INVALID'],
  ])('拒绝 Plugin Entry %s', (_name, entry, code) => {
    expect(codes(validate({ ...VALID_MANIFEST, entry }))).toContain(code)
  })

  it('要求 View entry 与 View ID 映射并允许普通资源 fragment', () => {
    const result = validate({
      ...VALID_MANIFEST,
      views: { 'hello-view': { entry: './views/other.js', styles: ['./styles/view.css?v=1'] } },
    })
    expect(codes(result)).toContain('FH2_VIEW_OUTPUT_ENTRY_MISMATCH')
    expect(codes(result)).not.toContain('FH2_ENTRY_QUERY_NOT_ALLOWED')
  })
})

describe('validateSourceManifest Point static contract', () => {
  it('校验 state、method、未知和布局字段', () => {
    const result = validate({
      ...VALID_MANIFEST,
      extensions: [
        { id: 'message', point: 'message.alert-popups' },
        {
          id: 'action',
          point: 'cockpit.ui.toolbar-actions',
          label: 'state',
          onTrigger: 'method',
          unknown: true,
          order: 1,
        },
      ],
    })
    expect(codes(result)).toEqual(expect.arrayContaining([
      'FH2_EXTENSION_STATE_IN_MANIFEST',
      'FH2_EXTENSION_METHOD_IN_MANIFEST',
      'FH2_EXTENSION_FIELD_UNKNOWN',
      'FH2_EXTENSION_LAYOUT_FIELD_FORBIDDEN',
    ]))
  })

  it('通用处理 static 类型、enum、View/Icon 引用、optional 和 default', () => {
    const staticContract: Readonly<Record<string, FieldSpec>> = {
      label: { kind: 'static', type: 'string' },
      count: { kind: 'static', type: 'number' },
      enabled: { kind: 'static', type: 'boolean' },
      mode: { kind: 'static', type: 'enum', values: ['a', 'b'] },
      view: { kind: 'static', type: 'viewId' },
      icon: { kind: 'static', type: 'iconId' },
      optional: { kind: 'static', type: 'string', optional: true },
      defaulted: { kind: 'static', type: 'boolean', default: false },
    }
    const result = validate({
      ...VALID_MANIFEST,
      extensions: [{
        id: 'typed',
        point: 'cockpit.ui.toolbar-actions',
        label: 1,
        count: 'one',
        enabled: 'yes',
        mode: 'c',
        view: 'missing-view',
        icon: 'missing-icon',
      }],
    }, {
      ...dependencies,
      pointCatalog: { 'cockpit.ui.toolbar-actions': { contract: staticContract } },
    })
    expect(codes(result).filter(code => code === 'FH2_EXTENSION_STATIC_TYPE')).toHaveLength(3)
    expect(codes(result)).toEqual(expect.arrayContaining([
      'FH2_EXTENSION_STATIC_ENUM',
      'FH2_MANIFEST_VIEW_NOT_FOUND',
      'FH2_MANIFEST_ICON_NOT_FOUND',
    ]))
    expect(codes(result)).not.toContain('FH2_EXTENSION_STATIC_REQUIRED')
  })

  it('plan.form-extensions 允许缺省 anchor，非法 anchor 在 schema 层拒绝', () => {
    const valid = validate({
      ...VALID_MANIFEST,
      extensions: [{ id: 'form', point: 'plan.form-extensions', planType: 'normal' }],
    })
    expect(codes(valid)).not.toContain('FH2_EXTENSION_STATIC_REQUIRED')

    const afterStrategy = validate({
      ...VALID_MANIFEST,
      extensions: [{
        id: 'form',
        point: 'plan.form-extensions',
        anchor: 'task-strategy:after',
        planType: 'normal',
      }],
    })
    expect(codes(afterStrategy)).not.toContain('FH2_EXTENSION_STATIC_ENUM')

    const invalid = validate({
      ...VALID_MANIFEST,
      extensions: [{
        id: 'form',
        point: 'plan.form-extensions',
        anchor: 'mid-form',
        planType: 'normal',
      }],
    })
    expect(codes(invalid)).toContain('FH2_MANIFEST_SCHEMA_INVALID')
  })

  it('project 侧栏要求 path 并校验 position', () => {
    const missing = validate({
      ...VALID_MANIFEST,
      extensions: [{ id: 'sidebar', point: 'project.sidebar-actions' }],
    })
    expect(codes(missing)).toContain('FH2_EXTENSION_STATIC_REQUIRED')

    const invalid = validate({
      ...VALID_MANIFEST,
      extensions: [{
        id: 'sidebar',
        point: 'project.sidebar-actions',
        path: 'relative',
        position: -1,
      }],
    })
    expect(codes(invalid)).toEqual(expect.arrayContaining([
      'FH2_PROJECT_SIDEBAR_PATH_INVALID',
      'FH2_PROJECT_SIDEBAR_POSITION_INVALID',
    ]))

    const valid = validate({
      ...VALID_MANIFEST,
      extensions: [{
        id: 'sidebar',
        point: 'project.sidebar-actions',
        path: '/accident-response',
        position: 1,
      }],
    })
    expect(codes(valid)).toEqual([])
  })
})

describe('validateSourceManifest 输出稳定性和仓库 Manifest', () => {
  it('按 phase/path/line/column/code 稳定排序并产生字节稳定 JSON/text', () => {
    const input: ValidationDiagnostic[] = [
      { code: 'B', phase: 'contract', file: 'fh2-plugin.json', path: 'z', message: 'B' },
      { code: 'C', phase: 'semantic', file: 'fh2-plugin.json', path: 'a', line: 2, column: 1, message: 'C' },
      { code: 'A', phase: 'semantic', file: 'fh2-plugin.json', path: 'a', line: 1, column: 2, message: 'A' },
    ]
    const diagnostics = sortValidationDiagnostics(input)
    const result = { ok: false as const, diagnostics }
    expect(diagnostics.map(item => item.code)).toEqual(['A', 'C', 'B'])
    expect(formatValidationResultJson(result)).toBe(formatValidationResultJson(result))
    expect(formatValidationResultText(result, 'fh2-plugin.json')).toContain('fh2-plugin.json:1:2: a')
  })

  it.each([
    'packages/fh2-plugin-toolchain/src/__fixtures__/valid-source/fh2-plugin.json',
    'packages/fh2-traffic-capabilities/official_capture/frontend/official_traffic_capture/fh2-plugin.json',
    'packages/fh2-traffic-capabilities/official_parking/frontend/official_parking_patrol/fh2-plugin.json',
    'packages/fh2-traffic-capabilities/official_parking/frontend/official_wayline_teach/fh2-plugin.json',
    'packages/fh2-traffic-capabilities/official_accident/frontend/official_accident_response/fh2-plugin.json',
    'packages/fh2-traffic-capabilities/official_accident/frontend/official_alert_dispatch/fh2-plugin.json',
  ])('通过仓库 Source Manifest：%s', (manifestPath) => {
    expect(validateSourceManifest({ manifestPath: resolve(repositoryRoot, manifestPath) })).toMatchObject({ ok: true })
  })
})

function validate (
  value: unknown,
  customDependencies: ValidationDependencies = dependencies,
): ReturnType<typeof validateSourceManifestSnapshot> {
  return validateRaw(`${JSON.stringify(value, null, 2)}\n`, customDependencies)
}

function validateRaw (
  source: string,
  customDependencies: ValidationDependencies = dependencies,
): ReturnType<typeof validateSourceManifestSnapshot> {
  const directory = mkdtempSync(join(tmpdir(), 'fh2-validate-'))
  temporaryDirectories.push(directory)
  const manifestPath = join(directory, 'fh2-plugin.json')
  writeFileSync(manifestPath, source, 'utf8')
  return validateSourceManifestSnapshot({ manifestPath }, customDependencies)
}

function codes (result: ReturnType<typeof validateSourceManifestSnapshot>): readonly string[] {
  return result.ok ? [] : result.diagnostics.map(diagnostic => diagnostic.code)
}

function without (value: object, property: string): object {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== property))
}
