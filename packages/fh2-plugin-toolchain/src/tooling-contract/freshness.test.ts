// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const srcRoot = resolve(import.meta.dirname, '..')
const roots: string[] = []

afterEach(() => {
  vi.doUnmock('../capability/policy.js')
  vi.doUnmock('../project-policy.js')
  vi.resetModules()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('freshness implementation identity', () => {
  it('executes the production predicates with reusable and rejected inputs', async () => {
    const { BUILD_REPORT_MATCH_CHECKS: matches, BUILD_REPORT_REUSE_CHECKS: rejects } = await import('../capability/policy.js')
    expect(matches.capabilityId('a', 'a')).toBe(true)
    expect(matches.capabilityId('a', 'b')).toBe(false)
    expect(matches.metadataDigest('a', 'a')).toBe(true)
    expect(matches.metadataDigest('a', 'b')).toBe(false)
    expect(matches.packageManifestRecorded('a')).toBe(true)
    expect(matches.packageManifestRecorded(undefined)).toBe(false)
    expect(matches.packageManifestDigest('a', 'a')).toBe(true)
    expect(matches.packageManifestDigest('a', 'b')).toBe(false)
    expect(matches.packageManifestDigest(undefined, undefined)).toBe(false)
    expect(matches.currentMembers({ a: {} }, ['a'])).toBe(true)
    expect(matches.currentMembers({ b: {} }, ['a'])).toBe(false)
    expect(matches.distDigest({ digest: 'a' }, 'a')).toBe(true)
    expect(matches.distDigest({ digest: 'a' }, 'b')).toBe(false)
    expect(matches.distDigest(undefined, 'a')).toBe(false)
    expect(matches.sourceDigest('a', 'a')).toBe(true)
    expect(matches.sourceDigest('a', 'b')).toBe(false)
    for (const key of ['hasExternalSourceDependencies', 'hasExternalConfigDependencies', 'sourceChangedDuringBuild'] as const) {
      expect(rejects[key]({})).toBe(false)
      expect(rejects[key]({ [key]: false })).toBe(false)
      expect(rejects[key]({ [key]: true })).toBe(true)
    }
    expect(rejects.customConfig({})).toBe(false)
    expect(rejects.customConfig({ configPath: 'custom.ts' })).toBe(true)
    expect(rejects.customConfig({ configDigest: 'a' })).toBe(true)
    expect(rejects.customConfig({ configPath: 'custom.ts', configDigest: 'a' })).toBe(true)
  })

  it('changing a loaded predicate changes its identity, report and full build section digest', async () => {
    const { buildRuntimePolicyReport: originalReport } = await import('./policy.js')
    const before = originalReport(srcRoot)
    vi.resetModules()
    vi.doMock('../capability/policy.js', async (importOriginal) => {
      const original = await importOriginal<typeof import('../capability/policy.js')>()
      return {
        ...original,
        BUILD_REPORT_REUSE_CHECKS: {
          ...original.BUILD_REPORT_REUSE_CHECKS,
          customConfig: (entry: { readonly configPath?: string; readonly configDigest?: string }) => entry.configPath !== undefined && entry.configDigest !== undefined,
        },
      }
    })
    const { BUILD_REPORT_REUSE_CHECKS } = await import('../capability/policy.js')
    const { buildRuntimePolicyReport } = await import('./policy.js')
    const { serializeContract } = await import('./shared.js')
    expect(BUILD_REPORT_REUSE_CHECKS.customConfig({ configDigest: 'a' })).toBe(false)
    expect(BUILD_REPORT_REUSE_CHECKS.customConfig({ configPath: 'custom.ts', configDigest: 'a' })).toBe(true)
    const after = buildRuntimePolicyReport(srcRoot)
    const identity = after.build.freshness.implementationIdentity
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    expect(identity.predicateSha256.customConfig).toBe(hash(Function.prototype.toString.call(BUILD_REPORT_REUSE_CHECKS.customConfig)))
    expect(identity.predicateSha256.customConfig).not.toBe(before.build.freshness.implementationIdentity.predicateSha256.customConfig)
    expect(identity.sha256).not.toBe(before.build.freshness.implementationIdentity.sha256)
    expect(after.build.freshness.predicateKeys).toEqual(before.build.freshness.predicateKeys)
    expect(after.build.freshness.predicateSource).toBe(before.build.freshness.predicateSource)
    expect(serializeContract(after)).not.toBe(serializeContract(before))
    expect(hash(serializeContract(after.build))).not.toBe(hash(serializeContract(before.build)))
    expect(identity.meaning).toBe('implementation-identity-not-behavior-verification')
  })

  it('binds digest closure data: a changed default changes actual digest behavior and dependency identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fh2-freshness-identity-'))
    roots.push(root)
    writeFileSync(join(root, 'entry.ts'), 'export const value = 1')
    mkdirSync(join(root, 'dist'))
    const { digestSourceDirectory: beforeDigest } = await import('../capability/build-report.js')
    const { buildFreshnessImplementationIdentity: beforeIdentity } = await import('./policy.js')
    const identity = beforeIdentity()
    const digest = beforeDigest(root)
    writeFileSync(join(root, 'dist/output.js'), 'output')
    expect(beforeDigest(root)).toBe(digest)
    vi.resetModules()
    vi.doMock('../project-policy.js', async (importOriginal) => {
      const original = await importOriginal<typeof import('../project-policy.js')>()
      return { ...original, PROJECT_PATHS: { ...original.PROJECT_PATHS, dist: 'build-output' } }
    })
    const { digestSourceDirectory, BUILD_REPORT_DIGEST_IMPLEMENTATION } = await import('../capability/build-report.js')
    const { buildFreshnessImplementationIdentity } = await import('./policy.js')
    expect(digestSourceDirectory(root)).not.toBe(digest)
    const beforeOutput = digestSourceDirectory(root)
    mkdirSync(join(root, 'build-output'))
    writeFileSync(join(root, 'build-output/output.js'), 'new output')
    expect(digestSourceDirectory(root)).toBe(beforeOutput)
    const after = buildFreshnessImplementationIdentity()
    expect(after.dependencies.dataSha256).not.toBe(identity.dependencies.dataSha256)
    expect(after.dependencies.sha256).not.toBe(identity.dependencies.sha256)
    expect(after.sha256).not.toBe(identity.sha256)
    expect(after.dependencies.functionSha256).toHaveProperty('collectFiles')
    expect(BUILD_REPORT_DIGEST_IMPLEMENTATION.data.sourceIgnoredAtRoot).toContain('build-output')
  })
})
