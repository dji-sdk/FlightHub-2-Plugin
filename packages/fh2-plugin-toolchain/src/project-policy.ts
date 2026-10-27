// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/** Executable defaults. Descriptive tooling contracts project these values, not vice versa. */
export const PROJECT_PATHS = Object.freeze({
  sourceManifest: 'fh2-plugin.json',
  runtimeManifest: 'plugin.json',
  capabilityMetadata: 'capabilities.json',
  packageManifest: 'packages.json',
  tsconfig: 'tsconfig.json',
  dist: 'dist',
  release: 'release',
  frontendSource: 'src',
  pluginEntry: 'src/plugin.ts',
  views: 'src/views',
  generatedTypes: 'src/generated',
  generatedTypesFile: 'plugin-types.ts',
  backendTypes: 'types',
  schemaSql: 'schema.sql',
  buildInfo: 'build-info.json',
  localState: '.fh2',
  buildReport: 'build-report.json',
  public: 'public',
  mock: 'mock',
  frontend: 'frontend',
  backend: 'backend',
})

export const BACKEND_SOURCE_DIRECTORIES = Object.freeze({
  handlers: 'handlers',
  events: 'events',
  adapters: 'adapters',
  evaluators: 'evaluators',
  shared: 'shared',
  workflows: 'workflows',
  scripts: 'scripts',
})

export const CONTEXT_PRECEDENCE: readonly { readonly markerFile: string; readonly contextIds: readonly ('capability-project' | 'frontend-plugin' | 'backend-plugin' | 'industry-capability-workspace')[] }[] = Object.freeze([
  { markerFile: PROJECT_PATHS.capabilityMetadata, contextIds: ['capability-project'] as const },
  { markerFile: PROJECT_PATHS.sourceManifest, contextIds: ['frontend-plugin', 'backend-plugin'] as const },
  { markerFile: PROJECT_PATHS.packageManifest, contextIds: ['industry-capability-workspace'] as const },
])

export const MANIFEST_SIDE_DETECTION = Object.freeze({
  rule: 'backend-marker-present-and-frontend-marker-absent' as const,
  fallbackSide: 'frontend' as const,
  sides: [
    { side: 'frontend' as const, markerFields: ['entry', 'extensions', 'views', 'contributes'] },
    { side: 'backend' as const, markerFields: ['contractsRange', 'flows', 'scripts', 'connections', 'eventStatuses', 'entities', 'events', 'evaluators'] },
  ],
})

export const CAPABILITY_METADATA_FIELDS: readonly string[] = Object.freeze(['name', 'description'])
export const CAPABILITY_METADATA_SCHEMA = Object.freeze({
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'fh2://schema/capability-metadata',
  title: 'FH2 Capability Metadata',
  type: 'object',
  additionalProperties: false,
  required: CAPABILITY_METADATA_FIELDS,
  properties: Object.fromEntries(CAPABILITY_METADATA_FIELDS.map(field => [field, { type: 'string', minLength: 1, pattern: '\\S' }])),
})

export function manifestSide (manifest: Readonly<Record<string, unknown>>): 'frontend' | 'backend' {
  const keys = Object.keys(manifest)
  const [frontend, backend] = MANIFEST_SIDE_DETECTION.sides
  return backend!.markerFields.some(field => keys.includes(field)) && !frontend!.markerFields.some(field => keys.includes(field))
    ? 'backend'
    : MANIFEST_SIDE_DETECTION.fallbackSide
}
