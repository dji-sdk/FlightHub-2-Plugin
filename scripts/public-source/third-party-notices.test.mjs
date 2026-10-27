// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const rootNoticePath = fileURLToPath(new URL('../../NOTICE', import.meta.url))
const sourceNoticePath = fileURLToPath(new URL('../../.fh2-public/NOTICE.candidate.txt', import.meta.url))
const noticePath = existsSync(rootNoticePath) ? rootNoticePath : sourceNoticePath
const indexPath = fileURLToPath(new URL('./THIRD-PARTY-NOTICES.md', import.meta.url))
const ideNoticePath = fileURLToPath(new URL('../../packages/fh2-plugin-toolchain/ide/public/THIRD-PARTY-NOTICES.txt', import.meta.url))
const notice = readFileSync(noticePath, 'utf8')

const directDependencies = [
  '@antfu/eslint-config',
  '@dnd-kit/dom',
  '@dnd-kit/vue',
  '@imengyu/vue3-context-menu',
  '@modelcontextprotocol/sdk',
  '@rsbuild/core',
  '@rsbuild/plugin-vue',
  '@turf/boolean-disjoint',
  '@turf/helpers',
  '@turf/intersect',
  '@types/geojson',
  '@types/node',
  '@types/semver',
  '@types/ws',
  '@vicons/ionicons5',
  '@vitejs/plugin-vue',
  '@vue/language-server',
  '@vue/typescript-plugin',
  '@vueuse/core',
  '@xterm/addon-fit',
  '@xterm/xterm',
  'ajv',
  'chokidar',
  'cross-env',
  'd3-dag',
  'es-module-lexer',
  'esbuild',
  'eslint',
  'happy-dom',
  'ignore',
  'jsonc-parser',
  'minisearch',
  'monaco-editor',
  'monaco-languageclient',
  'monaco-sql-languages',
  'naive-ui',
  'open',
  'pinia',
  'postcss-value-parser',
  'reveal-file',
  'rimraf',
  'semver',
  'splitpanes',
  'tsup',
  'typescript',
  'typescript-language-server',
  'vite',
  'vitest',
  'vue',
  'vue-tsc',
  'ws',
  'zod',
]

function assertIncludes (text, expected, label = expected) {
  assert.ok(text.includes(expected), `missing ${label}`)
}

function extractFencedBlock (text, header) {
  const start = text.indexOf('```text', text.indexOf(header))
  assert.notEqual(start, -1, `missing fenced block after ${header}`)
  const bodyStart = text.indexOf('\n', start) + 1
  const end = text.indexOf('```', bodyStart)
  assert.notEqual(end, -1, `unterminated fenced block after ${header}`)
  return text.slice(bodyStart, end)
}

function normalizeLicenseText (text) {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim()
}

test('NOTICE原样保留52个直接依赖Markdown', () => {
  const section = notice.slice(notice.indexOf('## 二、'), notice.indexOf('## 三、'))
  const start = section.indexOf('# FH2 插件开发工具包：52 个直接声明第三方依赖')
  const end = section.lastIndexOf('|') + 2
  const original = section.slice(start, end)
  assert.equal(
    createHash('sha256').update(original).digest('hex'),
    'ee9d99aa4508f946c3be734c9fa20df6a1f55bd415aa46f71544b7ef9bced223',
    '原始Markdown标题、表格、版本、链接及末尾换行必须完整保留',
  )
  for (const name of directDependencies) {
    assert.match(section, new RegExp(`^\\| \\d+ \\| \`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\` \\|`, 'm'), `missing direct dependency ${name}`)
  }
})

test('三方文件只作索引，BlueOak链接位于根NOTICE最后', () => {
  const index = readFileSync(indexPath, 'utf8')
  assert.ok(index.length < 2000)
  assertIncludes(index, '仓库根 `NOTICE`')
  assert.ok(!index.includes('Permission is hereby granted'))
  assert.ok(notice.trimEnd().endsWith('https://blueoakcouncil.org/license/1.0.0'))
  for (const marker of ['### 4.1 MIT License', '### 4.2 Apache License 2.0', '### 4.3 ISC License']) {
    assertIncludes(notice, marker)
  }
})

test('Mock Host 关键内嵌组件与附加条款已归因', () => {
  for (const name of ['ant-design-vue', 'lodash', 'import-html-entry', '@babel/runtime', 'ajv', 'semver', 'qrcode', 'dijkstrajs', 'fast-uri', 'fast-deep-equal', 'json-schema-traverse', 'core-js-pure', '@swc/helpers', 'vue-loader', 'rspack-vue-loader', 'babel-runtime', 'core-js', 'add-dom-event-listener', 'component-classes', 'component-indexof', 'dom-align', 'vue-ref', 'babel-helper-vue-jsx-merge-props', 'postcss-value-parser']) {
    assert.match(notice, new RegExp(`\`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``), `missing bundled component ${name}`)
  }
  assertIncludes(notice, 'Copyright (c) 2015-present Alipay.com', 'ant-design-vue Alipay copyright')
  assertIncludes(notice, 'Copyright OpenJS Foundation and other contributors', 'lodash OpenJS copyright')
  assertIncludes(notice, 'Based on Underscore.js', 'lodash Underscore declaration')
  assertIncludes(notice, 'Copyright and related rights for sample code are waived via CC0', 'lodash CC0 sample clause')
  assertIncludes(notice, 'Copyright (c) 2018 Kuitos', 'import-html-entry copyright')
  assertIncludes(notice, 'Copyright 2024 SWC contributors.', 'SWC helpers copyright')
  assertIncludes(notice, 'Copyright (c) Microsoft Corporation. All rights reserved.', 'TypeScript copyright')
})

test('TypeScript 与 typescript-language-server 上游原文完整', () => {
  const tsBlock = extractFencedBlock(notice, '### 5.1')
  const tlsBlock = extractFencedBlock(notice, '### 5.2')

  for (const marker of ['TypeScript ThirdPartyNotices', 'DefinitelyTyped', 'Unicode', 'WebGL', 'End of ThirdPartyNotices']) {
    assertIncludes(tsBlock, marker, `TypeScript notice marker ${marker}`)
  }
  for (const marker of ['Parts of the code copied from the https://github.com/microsoft/vscode repository', 'Apache License', 'END OF TERMS AND CONDITIONS']) {
    assertIncludes(tlsBlock, marker, `typescript-language-server notice marker ${marker}`)
  }

  const tsSource = fileURLToPath(new URL('../../node_modules/typescript/ThirdPartyNoticeText.txt', import.meta.url))
  if (existsSync(tsSource)) {
    assert.equal(normalizeLicenseText(tsBlock), normalizeLicenseText(readFileSync(tsSource, 'utf8')))
  }

  const tlsCandidates = [
    fileURLToPath(new URL('../../packages/fh2-plugin-toolchain/node_modules/typescript-language-server/LICENSE', import.meta.url)),
    fileURLToPath(new URL('../../node_modules/typescript-language-server/LICENSE', import.meta.url)),
  ]
  const tlsSource = tlsCandidates.find(path => existsSync(path))
  if (tlsSource) {
    assert.equal(normalizeLicenseText(tlsBlock), normalizeLicenseText(readFileSync(tlsSource, 'utf8')))
  }
})

test('已知文案修正与分发边界', () => {
  assertIncludes(notice, '| `spdx-license-ids` | 3.0.24 | CC0-1.0 |', 'spdx-license-ids license')
  assertIncludes(notice, 'Copyright © 2004, John Gruber', 'marked Markdown copyright')
  assertIncludes(notice, 'Neither the name “Markdown” nor the names of its contributors', 'marked BSD clause')
  assertIncludes(notice, 'Copyright 2025 Dr.-Ing. Mario Heiderich, Cure53', 'DOMPurify copyright')
  assertIncludes(notice, 'Vue.js v2.7.16', 'Vue 2.7 banner')
  assertIncludes(notice, 'Shell 使用 Vue 2.7.16', 'shell Vue 2.7.16')
  assert.ok(!notice.includes('Vue 3.5.44 — MIT — lib-vue'), 'shell must not be described as Vue 3.5')
  assert.ok(!notice.includes('617.*.js'), 'must not pin stale vue2 chunk number')
  assertIncludes(notice, '当前发行包不含 Web IDE 预构建产物', 'current package excludes IDE prebuild')
  assertIncludes(notice, '须保留该产物适用的许可声明', 'local build obligations')
})

test('IDE notice 覆盖实际 import 且不声称预构建随候选分发', (t) => {
  if (!existsSync(ideNoticePath)) {
    t.skip('IDE notice not present in this export')
    return
  }
  const ideNotice = readFileSync(ideNoticePath, 'utf8')
  for (const name of ['vue', 'pinia', '@vicons/ionicons5', '@vueuse/core', '@imengyu/vue3-context-menu', 'monaco-sql-languages', 'marked', 'DOMPurify']) {
    assertIncludes(ideNotice, name, `IDE component ${name}`)
  }
  assertIncludes(ideNotice, 'Copyright (c) 2015-present Ionic', 'Ionicons copyright')
  assertIncludes(ideNotice, 'Copyright 2025 Dr.-Ing. Mario Heiderich, Cure53', 'DOMPurify copyright')
  assertIncludes(ideNotice, '当前 1.0.0 发行包 **不含 Web IDE 预构建产物**', 'IDE prebuild boundary')
  assertIncludes(ideNotice, 'jschardet', 'jschardet dev-chain note')
  assertIncludes(ideNotice, '当前发行包不含 Web IDE 预构建产物', 'jschardet boundary')
})
