// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { ConfigFieldSchema, ExtensionDeclaration, PluginManifest } from '../contracts/index.js'

/**
 * Manifest 类型生成器（toolchain 设计 §5）。
 *
 * **Node-only**：只在构建期跑，不进插件产物。
 * 输出 `plugin-types.ts`，包含 `ExtensionId` / `ExtensionsByHost` / `ViewId` /
 * `PluginConfig` 以及绑好 `PluginConfig` 的各 Host Context 别名。
 *
 * 刻意**不用** module augmentation 隐式改写 `PluginContext` 的默认泛型——
 * 那样类型来源在代码里无迹可寻。
 */

export interface GenerateTypesOptions {
  readonly manifest: PluginManifest;
  readonly outDir: string;
}

export interface GeneratedTypes {
  readonly fileName: 'plugin-types.ts';
  readonly source: string;
}

/** Extension 归属的 Host：由 Point 的 domain 前缀派生（决策 7） */
function hostOf (point: string): string {
  const dot = point.indexOf('.')
  return dot > 0 ? point.slice(0, dot) : point
}

function configFieldType (field: ConfigFieldSchema): string {
  switch (field.type) {
    case 'boolean':
      return 'boolean'
    case 'number':
      return 'number'
    case 'string':
      return field.enum ? field.enum.map(tsStringLiteral).join(' | ') : 'string'
  }
}

function interfaceBlock (name: string, body: string): string {
  return [`export interface ${name} {`, ...(body === '' ? [] : [body]), '}'].join('\n')
}

function propertyName (value: string): string {
  return /^[$A-Z_a-z][$\w]*$/.test(value) ? value : tsStringLiteral(value)
}

function tsStringLiteral (value: string): string {
  let escaped = ''
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (character === '\\') escaped += '\\\\'
    else if (character === '\'') escaped += String.raw`\'`
    else if (character === '\n') escaped += '\\n'
    else if (character === '\r') escaped += '\\r'
    else if (character === '\t') escaped += '\\t'
    else if (code < 0x20) escaped += `\\x${code.toString(16).padStart(2, '0')}`
    else if (code === 0x2028 || code === 0x2029) escaped += `\\u${code.toString(16)}`
    else if (character.length === 1 && code >= 0xD800 && code <= 0xDFFF)
      escaped += `\\u${code.toString(16).padStart(4, '0')}`
    else escaped += character
  }
  return `'${escaped}'`
}

export function generatePluginTypes (options: GenerateTypesOptions): GeneratedTypes {
  const { manifest } = options

  // —— ExtensionId ——
  const extensionIds = manifest.extensions.map(extension => tsStringLiteral(extension.id))
  const extensionIdType = extensionIds.length > 0
    ? `\n${extensionIds.map(id => `  | ${id}`).join('\n')}`
    : 'never'

  // —— ExtensionsByHost ——
  const byHost = new Map<string, string[]>()
  for (const ext of manifest.extensions) {
    const host = hostOf(ext.point)
    const list = byHost.get(host) ?? []
    list.push(tsStringLiteral(ext.id))
    byHost.set(host, list)
  }
  const hostBlocks = [...byHost.entries()].map(([host, ids]) => {
    const body = ids.join(' | ')
    return `  readonly ${propertyName(host)}: ${body};`
  }).join('\n')

  // —— ViewId ——
  const viewIds = Object.keys(manifest.views ?? {})
  const viewIdType = viewIds.length > 0
    ? `\n${viewIds.map(id => `  | ${tsStringLiteral(id)}`).join('\n')}`
    : 'never'

  // —— PluginConfig ——
  const configFields = Object.entries(manifest.config ?? {})
    .map(([name, field]) => `  readonly ${propertyName(name)}: ${configFieldType(field)};`)
    .join('\n')

  // —— 各 Host 的 Context 别名 ——
  const hostNames = [...byHost.keys()]
  const contextAliases = hostNames.map((host) => {
    const pascal = host.charAt(0).toUpperCase() + host.slice(1)
    const baseType = host === 'cockpit' ? 'CockpitPluginContext' : 'PluginContext'
    const extensions = manifest.extensions
      .filter(extension => hostOf(extension.point) === host)
      .map(extension => `  readonly ${propertyName(extension.id)}: ${tsStringLiteral(extension.point)};`)
      .join('\n')
    return [
      `export type App${pascal}Context = import('fh2-plugin-sdk').${baseType}<PluginConfig, {`,
      extensions,
      '}>',
    ].join('\n')
  }).join('\n')

  const sections = [
    [
      '// 本文件由 fh2-plugin generate 生成，请勿手改。',
      `// 来源 Manifest: ${manifest.id}@${manifest.version}`,
    ].join('\n'),
    `export type ExtensionId =${extensionIdType.startsWith('\n') ? '' : ' '}${extensionIdType}`,
    interfaceBlock('ExtensionsByHost', hostBlocks),
    `export type ViewId =${viewIdType.startsWith('\n') ? '' : ' '}${viewIdType}`,
    interfaceBlock('PluginConfig', configFields),
    contextAliases,
    'export type { CockpitPluginContext, PluginContext } from \'fh2-plugin-sdk\'',
  ].filter(section => section !== '')

  const source = `${sections.join('\n\n')}\n`

  return {
    fileName: 'plugin-types.ts',
    source,
  }
}

export type { ExtensionDeclaration, PluginManifest }
