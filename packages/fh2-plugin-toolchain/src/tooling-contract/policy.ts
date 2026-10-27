// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createHash } from 'node:crypto'
import process from 'node:process'
import { BACKEND_SOURCE_DIRECTORIES, CAPABILITY_METADATA_FIELDS, CONTEXT_PRECEDENCE, MANIFEST_SIDE_DETECTION, PROJECT_PATHS } from '../project-policy.js'
import { BACKEND_BUNDLE_GLOBALS, BACKEND_BUNDLE_OUTPUTS, BACKEND_COMPILE_OPTIONS, FORBIDDEN_GLOBALS, HANDLER_NAME_PATTERNS, NODE_BUILTIN_MODULES, NODE_BUILTIN_PREFIX, PLATFORM_COLUMN_NAMES, SCHEMA_FIELD_TYPES, SCHEMA_SQL_TYPES, SOURCE_POLICY_PATTERNS, forbiddenGlobalPattern } from '../backend/policy.js'
import { BUILD_PHASES, DIST_TRANSACTION_POLICY, FRONTEND_BACKEND_WATCH_DIRECTORIES, FRONTEND_OUTPUT_POLICY, FRONTEND_WATCH_DIRECTORIES, INFRASTRUCTURE_FAILURE_CODES, PLUGIN_MODULE_POLICY } from '../build/policy.js'
import { BACKEND_WATCH_TRANSACTION_PREFIX, BUILD_DIGEST_IGNORED_AT_ROOT, BUILD_REPORT_MATCH_CHECKS, BUILD_REPORT_REUSE_CHECKS, CAPABILITY_BACKEND_COPY_EXCLUSIONS, CAPABILITY_ZIP_EXCLUSIONS, SOURCE_DIGEST_IGNORED_AT_ROOT, SOURCE_DIGEST_IGNORED_EVERYWHERE, STANDALONE_PACK_EXCLUSIONS, WINDOWS_RESERVED_NAMES, ZIP_COMPRESSION_LEVEL } from '../capability/policy.js'
import { BUILD_REPORT_DIGEST_IMPLEMENTATION } from '../capability/build-report.js'
import { serializeContract } from './shared.js'
import { classifyDiagnostic, scanDiagnosticSources } from './diagnostics.js'

/** Hash loaded function text, not an arbitrary source/dist file snapshot or a behavioral attestation. */
export function buildFreshnessImplementationIdentity () {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const functions = (values: Readonly<Record<string, (...args: never[]) => unknown>>) => Object.fromEntries(Object.entries(values)
    .map(([name, fn]) => [name, hash(Function.prototype.toString.call(fn))]))
  const dependencies = {
    functionSha256: functions(BUILD_REPORT_DIGEST_IMPLEMENTATION.functions),
    dataSha256: hash(serializeContract(BUILD_REPORT_DIGEST_IMPLEMENTATION.data)),
    nodeVersion: process.versions.node,
  }
  const identity = {
    origin: 'loaded-runtime-function-text',
    scope: 'freshness-predicates-and-directory-digests; excludes Pack orchestration and external manifest resolution',
    meaning: 'implementation-identity-not-behavior-verification',
    predicateSha256: functions(BUILD_REPORT_REUSE_CHECKS),
    matchSha256: functions(BUILD_REPORT_MATCH_CHECKS),
    dependencies: { ...dependencies, sha256: hash(serializeContract(dependencies)) },
  }
  return { ...identity, sha256: hash(serializeContract(identity)) }
}

/** New report, separate from persisted v1 Bundle schemas. Functions are identified, never serialized as prose policy. */
export function buildRuntimePolicyReport (srcRoot: string) {
  const patterns = (values: Readonly<Record<string, RegExp>>) => Object.fromEntries(Object.entries(values).map(([name, regex]) => [name, { source: regex.source, flags: regex.flags }]))
  return {
    schemaVersion: 1,
    profile: 'toolchain-runtime-policy',
    legacyDocuments: { schemaVersion: 1, interpretation: 'policy-projection-with-manual-descriptions' },
    manualFields: {
      'context-discovery.json': ['contexts.supportedCommands (derived from manual execution-command metadata, not dispatch)', 'contexts.constraints', 'membershipRules.rule', 'source'],
      'build-flows.json': ['preconditions', 'observablePhases', 'outputs', 'failureBehavior', 'notes', 'freshnessRules.reuseConditions', 'freshnessRules.rejectionConditions', 'transaction.steps'],
      'artifact-layouts.json': ['root (path-derived layout explanation)', 'required', 'optional', 'generated', 'excluded (policy-list projection with manual copy/rejection explanation)', 'archivePrefix (layout summary, not ZIP executor)', 'notes', 'archivePolicy.pathRules (runtime lists projected where available; validation explanation remains manual)', 'archivePolicy.pathOrder', 'archivePolicy.storeFallback', 'source'],
      'source-runtime-transforms.json': ['inputs', 'outputs', 'behavior', 'conditions', 'notes'],
      'source-restrictions.json': ['scope', 'forbidden (runtime regex/list projection with manual explanation; uncovered validator lists referenced, not copied)', 'allowedExceptions', 'diagnosticCodes (cross-references, not execution emitters)', 'reason', 'alternatives', 'notes', 'source'],
      'diagnostics-catalog.json': ['family', 'commands', 'phase', 'classification', 'public'],
      'source-build-rules.json': ['sourceDiscovery (shared path conventions; only handler/packed discovery interprets include/exclude as a discovery inventory)', 'typecheck (default tsconfig path, not proof every build typechecks)', 'pack.includes (readonly layout summary derived from paths, not copy allowlist)', 'pathRewrites (readonly summary derived from paths, not rewrite executor)'],
    } as const,
    project: { paths: PROJECT_PATHS, backendDirectories: BACKEND_SOURCE_DIRECTORIES, contextPrecedence: CONTEXT_PRECEDENCE, manifestSideDetection: MANIFEST_SIDE_DETECTION, capabilityMetadataFields: CAPABILITY_METADATA_FIELDS },
    backend: {
      nodeBuiltinPrefix: NODE_BUILTIN_PREFIX,
      nodeBuiltinModules: NODE_BUILTIN_MODULES,
      specifierChecks: { node: 'backend/policy.ts#isNodeBuiltinSpecifier', relative: 'backend/policy.ts#isRelativeSpecifier', containmentPhase: 'esbuild-onResolve-only' },
      sourcePatterns: patterns(SOURCE_POLICY_PATTERNS),
      forbiddenGlobals: FORBIDDEN_GLOBALS,
      globalPatterns: patterns(Object.fromEntries(FORBIDDEN_GLOBALS.map(global => [global, forbiddenGlobalPattern(global)]))),
      moduleSyntax: 'backend/policy.ts#hasModuleSyntax',
      bundleOutputs: BACKEND_BUNDLE_OUTPUTS,
      bundleGlobals: BACKEND_BUNDLE_GLOBALS,
      compileOptions: BACKEND_COMPILE_OPTIONS,
      handlerPatterns: patterns(HANDLER_NAME_PATTERNS),
      platformColumns: PLATFORM_COLUMN_NAMES,
      schemaSqlTypes: SCHEMA_SQL_TYPES,
      schemaFieldTypes: SCHEMA_FIELD_TYPES,
    },
    frontend: { output: FRONTEND_OUTPUT_POLICY, modulePolicy: { vueResource: patterns({ vue: PLUGIN_MODULE_POLICY.vueResource }).vue, forbiddenTypePrefixes: PLUGIN_MODULE_POLICY.forbiddenTypePrefixes } },
    build: {
      diagnosticPhases: BUILD_PHASES,
      watch: { frontendDirectories: FRONTEND_WATCH_DIRECTORIES, withBackendDirectories: FRONTEND_BACKEND_WATCH_DIRECTORIES, backendTransactionPrefix: BACKEND_WATCH_TRANSACTION_PREFIX, fatalCodes: INFRASTRUCTURE_FAILURE_CODES },
      transaction: { ...DIST_TRANSACTION_POLICY, prefixFunction: 'build/policy.ts#distTransactionPrefix', implementation: 'build/transaction.ts#commitCandidateDirectory' },
      filters: { function: 'capability/policy.ts#selectBuildProjects', undefined: 'all', emptySet: 'none', validation: 'capability/build.ts#selectProjects' },
      freshness: {
        implementationIdentity: buildFreshnessImplementationIdentity(),
        predicateKeys: Object.keys(BUILD_REPORT_REUSE_CHECKS),
        predicateSource: 'capability/policy.ts#BUILD_REPORT_REUSE_CHECKS',
        matchKeys: Object.keys(BUILD_REPORT_MATCH_CHECKS),
        matchSource: 'capability/policy.ts#BUILD_REPORT_MATCH_CHECKS',
        inputResolution: 'capability/pack.ts#verifyFreshBuild,verifyReportEntry,verifyReportEntries',
        digestIgnoredAtRoot: BUILD_DIGEST_IGNORED_AT_ROOT,
        sourceIgnoredAtRoot: SOURCE_DIGEST_IGNORED_AT_ROOT,
        sourceIgnoredEverywhere: SOURCE_DIGEST_IGNORED_EVERYWHERE,
      },
      cliSupport: { origin: 'shared-build-context-policy', reason: 'src/build/policy.ts#BUILD_CONTEXT_OPTIONS is consumed by existing CLI gates and flow supports*; isCapabilityBuildConfigSelection checks the deduplicated single frontend condition. Non-watch Application Service dispatch retains its existing validation path.' },
    },
    pack: { standaloneExclusions: STANDALONE_PACK_EXCLUSIONS, capabilityBackendCopyExclusions: CAPABILITY_BACKEND_COPY_EXCLUSIONS, capabilityZipExclusions: CAPABILITY_ZIP_EXCLUSIONS, compressionLevel: ZIP_COMPRESSION_LEVEL, windowsReservedNames: WINDOWS_RESERVED_NAMES, pathOrderFunction: 'capability/policy.ts#compareArchivePaths', fallbackFunction: 'capability/policy.ts#useDeflate' },
    diagnosticPhaseResolution: 'source-literals-and-imported-policy-only; caller/helper phases remain unresolved; not an observed execution trace',
    diagnostics: scanDiagnosticSources(srcRoot).map(({ code, occurrences }) => ({
      code,
      occurrences,
      metadataOrigin: 'manual-tool-classification',
      classifications: [...new Set(occurrences.map(item => item.module))].map((module) => {
        const record = classifyDiagnostic(code, module)
        return { sourceModule: module, family: record.family, commands: record.commands, stageLabel: record.phase, classification: record.classification }
      }),
    })),
  }
}

export function serializeRuntimePolicyReport (srcRoot: string): string {
  return serializeContract(buildRuntimePolicyReport(srcRoot))
}
