// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { BACKEND_SOURCE_DIRECTORIES } from '../project-policy.js'

export const NODE_BUILTIN_PREFIX = 'node:'
export const NODE_BUILTIN_MODULES = Object.freeze([
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
])
const nodeBuiltinSet = new Set<string>(NODE_BUILTIN_MODULES)
export function isNodeBuiltinSpecifier (specifier: string): boolean {
  return specifier.startsWith(NODE_BUILTIN_PREFIX) || nodeBuiltinSet.has(specifier)
}
export function isRelativeSpecifier (specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../')
}

// Preserve the existing regex checker, including its limited literal/statement coverage.
export const SOURCE_POLICY_PATTERNS = Object.freeze({
  runtimeImport: /^\s*import\s+(?!type\b)[\s\S]*?from\s+["']([^"']+)["']/gm,
  runtimeExport: /^\s*export\s+(?!type\b)[\s\S]*?from\s+["']([^"']+)["']/gm,
  dynamicImport: /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  importMeta: /\bimport\s*\.\s*meta\b/,
  require: /\brequire\s*\(\s*["']([^"']*)["']\s*\)/g,
  eval: /\beval\s*\(/,
  functionConstructor: /\bnew\s+Function\s*\(/,
  asyncFunction: /\basync\s+function\b/,
  asyncCall: /\basync\s*\(/,
  arrowAwait: /=>\s*\{?\s*await\b/,
  await: /\bawait\s+/,
  moduleStatement: /^\s*(import|export)\s/m,
  moduleDynamicImport: /\bimport\s*\(/,
  stringLiterals: /(["'`])(?:\\.|(?!\1)[\s\S])*\1/g,
  residualImport: /\bimport\s/,
  residualExport: /\bexport\s/,
  residualRequire: /\brequire\s*\(/,
})
export const FORBIDDEN_GLOBALS = Object.freeze(['setTimeout', 'setInterval', 'setImmediate'])
export function forbiddenGlobalPattern (global: string): RegExp {
  return new RegExp(`\\b${global}\\s*\\(`)
}
export function hasModuleSyntax (source: string): boolean {
  return SOURCE_POLICY_PATTERNS.moduleStatement.test(source) || SOURCE_POLICY_PATTERNS.moduleDynamicImport.test(source)
}

export const BACKEND_BUNDLE_OUTPUTS = Object.freeze({
  handlers: `${BACKEND_SOURCE_DIRECTORIES.scripts}/handlers.js`,
  events: `${BACKEND_SOURCE_DIRECTORIES.scripts}/events.js`,
  adapter: `${BACKEND_SOURCE_DIRECTORIES.scripts}/adapter.js`,
})
export const BACKEND_BUNDLE_GLOBALS = Object.freeze({ handlers: '__fh2_handlers', events: '__fh2_events', adapters: '__fh2_adapters' })
export const BACKEND_COMPILE_OPTIONS = Object.freeze({
  bundle: true,
  platform: 'neutral',
  format: 'iife',
  splitting: false,
  minify: false,
  write: false,
  metafile: true,
  sourcemap: 'external',
  target: 'es2015',
  legalComments: 'none',
  logLevel: 'silent',
} as const)
export const HANDLER_NAME_PATTERNS = Object.freeze({
  exportName: /^[a-z][A-Za-z0-9]*$/,
  domain: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
  alias: /^h_([a-z][A-Za-z0-9]*)_([a-z][A-Za-z0-9]*)$/,
})
export const PLATFORM_COLUMN_NAMES = Object.freeze(['id', 'created_at', 'updated_at', 'tenant_id'])
export const SCHEMA_SQL_TYPES = Object.freeze(['TEXT', 'TIMESTAMPTZ'] as const)
export type SchemaSqlType = typeof SCHEMA_SQL_TYPES[number]
export const SCHEMA_FIELD_TYPES = Object.freeze({ TEXT: 'string', TIMESTAMPTZ: 'datetime' } as const)
