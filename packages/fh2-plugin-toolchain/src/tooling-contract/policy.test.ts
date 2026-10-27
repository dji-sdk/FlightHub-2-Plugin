// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { deflateRawSync } from 'node:zlib'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BACKEND_BUNDLE_OUTPUTS, FORBIDDEN_GLOBALS, SOURCE_POLICY_PATTERNS } from '../backend/policy.js'
import { validateModuleSyntax } from '../backend/source-contract.js'
import type { BackendContractDiagnostic } from '../backend/contract.js'
import { createDeterministicZip } from '../capability/zip.js'
import { digestSourceDirectory } from '../capability/build-report.js'
import { ZIP_COMPRESSION_LEVEL } from '../capability/policy.js'
import { createCandidateDirectory } from '../build/transaction.js'
import { resolveBuildDescriptor } from '../build/paths.js'
import { PROJECT_PATHS } from '../project-policy.js'
import { buildRuntimePolicyReport, serializeRuntimePolicyReport } from './policy.js'
import { scanDiagnosticSources } from './diagnostics.js'

const srcRoot = resolve(import.meta.dirname, '..')

describe('runtime policy evidence', () => {
  it('projects executed regex/global rules without changing the static checker boundary', () => {
    const report = buildRuntimePolicyReport(srcRoot)
    for (const global of report.backend.forbiddenGlobals) {
      const diagnostics: BackendContractDiagnostic[] = []
      validateModuleSyntax('/root', 'a.ts', `${global}(() => {}, 1)`, diagnostics)
      expect(diagnostics.map(item => item.code)).toContain('FH2_BACKEND_TIMER_FORBIDDEN')
    }
    expect(report.backend.forbiddenGlobals).toBe(FORBIDDEN_GLOBALS)
    expect(report.backend.sourcePatterns.runtimeImport).toEqual({ source: SOURCE_POLICY_PATTERNS.runtimeImport.source, flags: 'gm' })
    const diagnostics: BackendContractDiagnostic[] = []
    validateModuleSyntax('/root', 'a.ts', 'import x from "../../outside.js"', diagnostics)
    expect(diagnostics).toEqual([])
    expect(report.backend.specifierChecks.containmentPhase).toBe('esbuild-onResolve-only')
    expect(report.backend.bundleOutputs).toBe(BACKEND_BUNDLE_OUTPUTS)
  })

  it('zIP bytes and source digest actually use the projected compression and exclusions', () => {
    const root = mkdtempSync(join(tmpdir(), 'fh2-policy-'))
    try {
      const data = Buffer.from('repeat this block;'.repeat(1000))
      const zip = createDeterministicZip([{ path: 'a.txt', data }])
      const start = 30 + zip.readUInt16LE(26)
      expect(zip.readUInt16LE(8)).toBe(8)
      expect(zip.subarray(start, start + zip.readUInt32LE(18))).toEqual(deflateRawSync(data, { level: ZIP_COMPRESSION_LEVEL }))
      writeFileSync(join(root, 'a.ts'), 'export const a = 1')
      const before = digestSourceDirectory(root)
      const candidate = createCandidateDirectory(join(root, PROJECT_PATHS.dist))
      writeFileSync(join(candidate, 'a.js'), 'different output')
      expect(digestSourceDirectory(root)).toBe(before)
      const report = buildRuntimePolicyReport(srcRoot)
      expect(candidate.split('/').at(-1)?.startsWith(`.${PROJECT_PATHS.dist}${report.build.transaction.candidateSuffix}`)).toBe(true)
      writeFileSync(join(root, PROJECT_PATHS.sourceManifest), '{}')
      expect(resolveBuildDescriptor(root, {}).manifestPath).toBe(realpathSync(join(root, report.project.paths.sourceManifest)))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('scans literal, shared and unresolved phases; references/environment names do not create codes', () => {
    const root = mkdtempSync(join(tmpdir(), 'fh2-diagnostic-scan-'))
    try {
      mkdirSync(join(root, 'build'))
      writeFileSync(join(root, 'build', 'sample.ts'), `
import { BUILD_PHASES } from './policy.js'
const a = { code: 'FH2_REAL_CODE', phase: 'config' }
const b = { code: 'FH2_REAL_CODE', phase: BUILD_PHASES.compile }
const c = { code: 'FH2_REAL_CODE', phase: callerPhase }
const text = \`FH2_PREFIX_CODE: error \${value}\`
const environment = 'FH2_ENVIRONMENT_NAME'
const onlyMentioned = 'set FH2_ENVIRONMENT_NAME before running'
const inline = buildError(BUILD_PHASES.generate, 'FH2_INLINE_CODE', error)
const caught = asBuildError(error, BUILD_PHASES.compile, 'FH2_CAUGHT_CODE')
const diagnostic = buildDiagnostic('resolve', 'FH2_DIAGNOSTIC_CODE')
const unknown = asBuildError(error, callerPhase, 'FH2_UNKNOWN_CODE')
const wrongPosition = asBuildError('compile', 'FH2_SECOND_ARGUMENT_CODE', error)
`)
      const scanned = scanDiagnosticSources(root)
      expect(scanned.map(item => item.code)).toEqual(['FH2_CAUGHT_CODE', 'FH2_DIAGNOSTIC_CODE', 'FH2_INLINE_CODE', 'FH2_PREFIX_CODE', 'FH2_REAL_CODE', 'FH2_SECOND_ARGUMENT_CODE', 'FH2_UNKNOWN_CODE'])
      expect(scanned.find(item => item.code === 'FH2_REAL_CODE')?.occurrences.map(item => [item.phaseOrigin, item.phases])).toEqual([
        ['literal', ['config']],
        ['shared-policy', ['compile']],
        ['unresolved', []],
      ])
      expect(scanned.find(item => item.code === 'FH2_PREFIX_CODE')?.occurrences[0]?.usage).toBe('message-prefix')
      expect(scanned.find(item => item.code === 'FH2_INLINE_CODE')?.occurrences[0]).toMatchObject({ phaseOrigin: 'shared-policy', phases: ['generate'] })
      expect(scanned.find(item => item.code === 'FH2_CAUGHT_CODE')?.occurrences[0]).toMatchObject({ phaseOrigin: 'shared-policy', phases: ['compile'] })
      expect(scanned.find(item => item.code === 'FH2_DIAGNOSTIC_CODE')?.occurrences[0]).toMatchObject({ phaseOrigin: 'literal', phases: ['resolve'] })
      expect(scanned.find(item => item.code === 'FH2_UNKNOWN_CODE')?.occurrences[0]).toMatchObject({ phaseOrigin: 'unresolved', phases: [] })
      expect(scanned.find(item => item.code === 'FH2_SECOND_ARGUMENT_CODE')?.occurrences[0]).toMatchObject({ phaseOrigin: 'unresolved', phases: [] })
      writeFileSync(join(root, 'build', 'local.ts'), `
const BUILD_PHASES = { compile: 'guessed' }
const value = { code: 'FH2_LOCAL_CODE', phase: BUILD_PHASES.compile }
`)
      expect(scanDiagnosticSources(root).find(item => item.code === 'FH2_LOCAL_CODE')?.occurrences[0]).toMatchObject({ phaseOrigin: 'unresolved', phases: [] })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves the imported binding, not parameter/local/catch shadows or type-only imports', () => {
    const root = mkdtempSync(join(tmpdir(), 'fh2-phase-bindings-'))
    try {
      mkdirSync(join(root, 'build'))
      writeFileSync(join(root, 'build/bindings.ts'), `
import { BUILD_PHASES, BUILD_PHASES as phases } from './policy.js'
function parameter(BUILD_PHASES: any) {
  return asBuildError(error, BUILD_PHASES.compile, 'FH2_PARAMETER_CODE')
}
function local() {
  const BUILD_PHASES = { compile: 'local' }
  return { code: 'FH2_LOCAL_SHADOW_CODE', phase: BUILD_PHASES.compile }
}
function hoisted() {
  const result = { code: 'FH2_HOISTED_CODE', phase: BUILD_PHASES.compile }
  var BUILD_PHASES
  return result
}
try {} catch (BUILD_PHASES) {
  buildError(BUILD_PHASES.compile, 'FH2_CATCH_SHADOW_CODE', error)
}
function unrelated() { const BUILD_PHASES = {} }
const valid = { code: 'FH2_VALID_CODE', phase: BUILD_PHASES.compile }
const alias = { code: 'FH2_ALIAS_CODE', phase: phases.generate }
`)
      writeFileSync(join(root, 'build/types.ts'), `
import type { BUILD_PHASES } from './policy.js'
const invalid = { code: 'FH2_TYPE_IMPORT_CODE', phase: BUILD_PHASES.compile }
`)
      const scanned = scanDiagnosticSources(root)
      for (const code of ['FH2_PARAMETER_CODE', 'FH2_LOCAL_SHADOW_CODE', 'FH2_HOISTED_CODE', 'FH2_CATCH_SHADOW_CODE', 'FH2_TYPE_IMPORT_CODE']) {
        expect(scanned.find(item => item.code === code)?.occurrences[0], code).toMatchObject({ phaseOrigin: 'unresolved', phases: [] })
      }
      expect(scanned.find(item => item.code === 'FH2_VALID_CODE')?.occurrences[0]).toMatchObject({ phaseOrigin: 'shared-policy', phases: ['compile'] })
      expect(scanned.find(item => item.code === 'FH2_ALIAS_CODE')?.occurrences[0]).toMatchObject({ phaseOrigin: 'shared-policy', phases: ['generate'] })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps classification stage labels separate from actual source phases and exports deterministically', () => {
    const report = buildRuntimePolicyReport(srcRoot)
    const bundle = report.diagnostics.find(item => item.code === 'FH2_BACKEND_BUNDLE_FAILED')!
    expect(bundle.occurrences.flatMap(item => item.phases)).toContain('config')
    expect(bundle.occurrences.flatMap(item => item.phases)).toContain('compile')
    expect(bundle.metadataOrigin).toBe('manual-tool-classification')
    expect(bundle.classifications[0]).toHaveProperty('stageLabel')
    expect(bundle.classifications[0]).not.toHaveProperty('phase')
    expect(report.diagnostics.map(item => item.code)).toContain('FH2_BACKEND_IMPORT_OUTSIDE_ROOT')
    expect(report.diagnostics.map(item => item.code)).toContain('FH2_BACKEND_DEV_START_FAILED')
    expect(serializeRuntimePolicyReport(srcRoot)).toBe(serializeRuntimePolicyReport(srcRoot))
  })

  it('retains report machine keys while reclassifying shared flow options', () => {
    const report = buildRuntimePolicyReport(srcRoot)
    expect(Object.keys(report.build.cliSupport).sort()).toEqual(['origin', 'reason'])
    expect(report.build.cliSupport.origin).toBe('shared-build-context-policy')
    expect(report.manualFields['build-flows.json']).not.toContain('supportsWatch')
    expect(report.manualFields['build-flows.json']).not.toContain('supportsConfig')
    expect(report.manualFields['build-flows.json']).not.toContain('supportsFilters')
    expect(report.manualFields['source-build-rules.json'].some(field => field.startsWith('pack.includes (readonly'))).toBe(true)
  })
})
