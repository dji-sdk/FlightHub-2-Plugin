// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BUILD_CONTEXT_OPTIONS, BuildContextOptions } from '../build/policy.js'

const roots: string[] = []

afterEach(() => {
  vi.doUnmock('../build/policy.js')
  vi.doUnmock('../project-policy.js')
  vi.resetModules()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('shared build context options', () => {
  it.each([
    ['supportsWatch', ['--watch']],
    ['supportsConfig', ['--config', 'custom.ts']],
    ['supportsFilters', ['--frontend', 'exp_front']],
  ] as const)('changing %s changes real CLI rejection and flow serialization together', async (key, args) => {
    const root = mkdtempSync(join(tmpdir(), 'fh2-build-option-policy-'))
    roots.push(root)
    writeFileSync(join(root, 'capabilities.json'), JSON.stringify({ name: 'fixture', description: 'fixture' }))
    mkdirSync(join(root, 'frontend/exp_front'), { recursive: true })
    writeFileSync(join(root, 'frontend/exp_front/fh2-plugin.json'), JSON.stringify({ id: 'exp_front' }))
    const buildCapability = vi.fn(async () => ({ ok: true, diagnostics: [] }))
    const stdout: string[] = []
    const stderr: string[] = []
    const options = {
      cwd: root,
      args: key === 'supportsConfig' ? [...args, '--frontend', 'exp_front'] : args,
      operationLockHeld: true,
      stdout: { write: (value: string) => stdout.push(value) },
      stderr: { write: (value: string) => stderr.push(value) },
      signals: { on: () => {}, off: () => {} },
    }
    // Config/filter baseline uses the real CLI adapter and a successful coordinator fixture.
    if (key !== 'supportsWatch') {
      const { runBuildCommand } = await import('../commands/build-command.js')
      expect(await runBuildCommand({ ...options, buildCapability })).toBe(0)
      expect(buildCapability).toHaveBeenCalledOnce()
      buildCapability.mockClear()
    }

    vi.resetModules()
    vi.doMock('../build/policy.js', async (importOriginal) => {
      const original = await importOriginal<typeof import('../build/policy.js')>()
      return {
        ...original,
        BUILD_CONTEXT_OPTIONS: {
          ...original.BUILD_CONTEXT_OPTIONS,
          'capability-project': { ...original.BUILD_CONTEXT_OPTIONS['capability-project'], [key]: false },
        } satisfies Readonly<Record<keyof typeof BUILD_CONTEXT_OPTIONS, BuildContextOptions>>,
      }
    })
    const { runBuildCommand } = await import('../commands/build-command.js')
    const { BUILD_FLOWS_CONTRACT, serializeBuildFlowsContract } = await import('./flows.js')
    const flow = BUILD_FLOWS_CONTRACT.flows.find(item => item.context === 'capability-project')!
    expect(flow[key]).toBe(false)
    const document = JSON.parse(serializeBuildFlowsContract())
    expect(document.flows.find((item: { context: string }) => item.context === 'capability-project')[key]).toBe(false)
    // Watch uses the production CLI call without a coordinator/runner injection; rejection prevents startup.
    expect(await runBuildCommand(key === 'supportsWatch' ? options : { ...options, buildCapability })).toBe(2)
    expect(buildCapability).not.toHaveBeenCalled()
    expect(stderr.join('')).toContain('Capability')
  })

  it('default Capability config still requires exactly one distinct frontend ID', async () => {
    const { BUILD_CONTEXT_OPTIONS, isCapabilityBuildConfigSelection } = await import('../build/policy.js')
    const { BUILD_FLOWS_CONTRACT } = await import('./flows.js')
    expect(BUILD_CONTEXT_OPTIONS['capability-project'].supportsConfig).toBe(true)
    expect(BUILD_FLOWS_CONTRACT.flows.find(item => item.context === 'capability-project')?.supportsConfig).toBe(true)
    expect(isCapabilityBuildConfigSelection(new Set())).toBe(false)
    expect(isCapabilityBuildConfigSelection(new Set(['exp_front', 'exp_front']))).toBe(true)
    expect(isCapabilityBuildConfigSelection(new Set(['exp_front', 'exp_other']))).toBe(false)
  })

  it('changing default paths changes real build/profile resolution and SourceBuildRules together', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fh2-build-default-policy-'))
    roots.push(root)
    writeFileSync(join(root, 'fh2-plugin.json'), JSON.stringify({ id: 'exp_defaults', entry: './plugin.js' }))
    vi.doMock('../project-policy.js', async (importOriginal) => {
      const original = await importOriginal<typeof import('../project-policy.js')>()
      return {
        ...original,
        PROJECT_PATHS: { ...original.PROJECT_PATHS, tsconfig: 'tsconfig.custom.json', pluginEntry: 'code/main.ts', generatedTypes: 'code/types', dist: 'build-output' },
        BACKEND_SOURCE_DIRECTORIES: { ...original.BACKEND_SOURCE_DIRECTORIES, scripts: 'runtime-scripts', workflows: 'worker-flows' },
      }
    })
    vi.resetModules()
    const { resolveBuildDescriptor } = await import('../build/paths.js')
    const { resolveRuntimeProfile } = await import('../services/application/runtime-profile.js')
    const { serializeSourceBuildRules } = await import('../source-build-rules.js')
    const { HANDLERS_OUTPUT, EVENTS_OUTPUT, ADAPTER_OUTPUT } = await import('../backend/compiler.js')
    const descriptor = resolveBuildDescriptor(root, {})
    expect(descriptor.pluginEntry).toBe(join(descriptor.projectRoot, 'code/main.ts'))
    expect(descriptor.typesOutDir).toBe(join(descriptor.projectRoot, 'code/types'))
    expect(descriptor.distRoot).toBe(join(descriptor.projectRoot, 'build-output'))
    const rules = JSON.parse(serializeSourceBuildRules())
    expect(rules.typecheck.every((item: { tsconfigPath: string }) => item.tsconfigPath === 'tsconfig.custom.json')).toBe(true)
    expect(resolveRuntimeProfile(root).frontend[0]?.tsconfigPath).toBe(join(root, 'tsconfig.custom.json'))
    expect(rules.sourceDiscovery.find((item: { id: string }) => item.id === 'frontend-plugin-entry').include).toEqual(['code/main.ts'])
    expect(rules.buildTargets.every((item: { outputDirectory: string }) => item.outputDirectory === 'build-output')).toBe(true)
    expect(rules.pathRewrites[0].to).toBe('build-output/plugin.json')
    expect(rules.pack.find((item: { id: string }) => item.id === 'backend-plugin').includes).toEqual(['plugin.json', 'runtime-scripts/**', 'worker-flows/**'])
    expect([HANDLERS_OUTPUT, EVENTS_OUTPUT, ADAPTER_OUTPUT]).toEqual(['runtime-scripts/handlers.js', 'runtime-scripts/events.js', 'runtime-scripts/adapter.js'])
    expect(rules.pathRewrites.find((item: { from: string }) => item.from === 'handlers').to).toBe('build-output/runtime-scripts')
    expect(rules.pathRewrites.find((item: { from: string }) => item.from === 'worker-flows').to).toBe('build-output/worker-flows')
  })
})
