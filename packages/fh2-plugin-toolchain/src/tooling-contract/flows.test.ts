// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { isIgnoredWatchPath } from '../build/runner.js'
import { CLI_CONTRACT } from './cli.js'
import { CONTEXT_DISCOVERY_CONTRACT, contextDescriptor } from './context.js'
import { classifyDiagnostic } from './diagnostics.js'
import {
  BUILD_FLOWS_CONTRACT,
  buildFlowDescriptor,
  serializeBuildFlowsContract,
} from './flows.js'

describe('build flows contract', () => {
  it('覆盖四个流程且 ID 唯一、source 非空、阶段为用户可观察命名', () => {
    expect(BUILD_FLOWS_CONTRACT.flows.map(item => item.id)).toEqual([
      'frontend-plugin-build',
      'backend-plugin-build',
      'capability-build',
      'industry-workspace-build',
    ])
    for (const flow of BUILD_FLOWS_CONTRACT.flows) {
      expect(flow.source.trim().length, `${flow.id} 缺少 source`).toBeGreaterThan(0)
      expect(flow.preconditions.length, `${flow.id} 缺少 preconditions`).toBeGreaterThan(0)
      expect(flow.observablePhases.length, `${flow.id} 缺少 observablePhases`).toBeGreaterThan(0)
      expect(flow.outputs.length, `${flow.id} 缺少 outputs`).toBeGreaterThan(0)
      expect(flow.failureBehavior.length, `${flow.id} 缺少 failureBehavior`).toBeGreaterThan(0)
      expect(flow.sides.length).toBeGreaterThan(0)
      // observablePhases 只允许 validate/generate/compile/verify/commit 用户可观察阶段名。
      for (const phase of flow.observablePhases) {
        expect(/^(validate|generate|compile|verify|commit)（/.test(phase), `${flow.id} 阶段命名不合规：${phase}`).toBe(true)
      }
    }
    for (const id of BUILD_FLOWS_CONTRACT.flows.map(item => item.id)) {
      expect(buildFlowDescriptor(BUILD_FLOWS_CONTRACT, id).id).toBe(id)
    }
  })

  it('supportsWatch/Config/Filters 与 build-command 上下文限制一致（矩阵）', () => {
    const flags = (id: string) => {
      const flow = buildFlowDescriptor(BUILD_FLOWS_CONTRACT, id)
      return { watch: flow.supportsWatch, config: flow.supportsConfig, filters: flow.supportsFilters }
    }
    expect(flags('frontend-plugin-build')).toEqual({ watch: true, config: true, filters: false })
    expect(flags('backend-plugin-build')).toEqual({ watch: false, config: false, filters: false })
    expect(flags('capability-build')).toEqual({ watch: true, config: true, filters: true })
    expect(flags('industry-workspace-build')).toEqual({ watch: false, config: false, filters: false })
  })

  it('流程上下文与 CLI_CONTRACT.build / CONTEXT_DISCOVERY_CONTRACT 双向一致', () => {
    const build = CLI_CONTRACT.commands.find(command => command.name === 'build')
    expect(build).toBeDefined()
    for (const flow of BUILD_FLOWS_CONTRACT.flows) {
      expect(build?.contexts, `build 命令应支持上下文 ${flow.context}`).toContain(flow.context)
      const context = CONTEXT_DISCOVERY_CONTRACT.contexts.find(item => item.id === flow.context)
      expect(context?.supportedCommands, `上下文 ${flow.context} 应支持 build`).toContain('build')
    }
    // 上下文限制与流程能力矩阵互证（CLI notes 与 CONTEXT constraints 原文）。
    const notes = build?.notes ?? []
    expect(notes.some(note => note.includes('行业 Capability 工作区不支持 --watch/--config/--frontend/--backend'))).toBe(true)
    expect(notes.some(note => note.includes('独立后端插件不支持 --watch 与 --config'))).toBe(true)
    expect(notes.some(note => note.includes('Capability 根使用 --config 时必须且只能指定一个 --frontend <pluginId>'))).toBe(true)

    const workspace = contextDescriptor(CONTEXT_DISCOVERY_CONTRACT, 'industry-capability-workspace')
    expect(workspace.constraints.some(item => item.includes('build 不支持 --watch、--config、--frontend、--backend'))).toBe(true)
    const backend = contextDescriptor(CONTEXT_DISCOVERY_CONTRACT, 'backend-plugin')
    expect(backend.constraints.some(item => item.includes('独立后端插件 build 不支持 --watch；不支持 --config'))).toBe(true)
    const capability = contextDescriptor(CONTEXT_DISCOVERY_CONTRACT, 'capability-project')
    expect(capability.constraints.some(item => item.includes('--config 必须且只能指定一个 --frontend'))).toBe(true)
    expect(capability.constraints.some(item => item.includes('build 支持 --watch'))).toBe(true)
  })

  it('freshnessRules 与 --no-build 的新鲜度语义及 pack 命令限制一致', () => {
    expect(BUILD_FLOWS_CONTRACT.freshnessRules.map(rule => rule.id)).toEqual([
      'capability-pack-no-build-freshness',
    ])
    const rule = BUILD_FLOWS_CONTRACT.freshnessRules[0]!
    expect(rule.command).toBe('pack --no-build')
    expect(rule.reuseConditions.length).toBeGreaterThanOrEqual(10)
    expect(rule.rejectionConditions.length).toBeGreaterThanOrEqual(9)
    // 拒绝条件覆盖任务指定的三类：自定义 config / 外部依赖 / 构建期源码变更。
    expect(rule.rejectionConditions.some(item => item.includes('自定义 Rsbuild 配置'))).toBe(true)
    expect(rule.rejectionConditions.some(item => item.includes('Capability 外源码依赖'))).toBe(true)
    expect(rule.rejectionConditions.some(item => item.includes('Capability 外的 Rsbuild 配置依赖'))).toBe(true)
    expect(rule.rejectionConditions.some(item => item.includes('生成期间源码发生变化'))).toBe(true)
    // 拒绝码可被诊断注册表分类（来源 capability/pack.ts）。
    expect(() => classifyDiagnostic(rule.rejectionCode, 'capability/pack.ts')).not.toThrow()
    expect(rule.rejectionCode).toBe('FH2_CAPABILITY_BUILD_STALE')
    // pack 命令的 --no-build 限制与 scope 一致（仅 Capability 根）。
    const pack = CLI_CONTRACT.commands.find(command => command.name === 'pack')
    expect(pack?.notes?.some(note => note.includes('--no-build 只能在 Capability 根执行'))).toBe(true)
  })

  it('transaction 事实与 build/transaction.ts 诊断码及 watch 忽略行为一致', () => {
    const transaction = BUILD_FLOWS_CONTRACT.transaction
    // 目录模式写死对照（createCandidateDirectory/commitCandidateDirectory 的 join 模式）。
    expect(transaction.candidateDirectory).toBe('.dist.fh2-next-<uuid>')
    expect(transaction.backupDirectory).toBe('.dist.fh2-backup-<uuid>')
    // 诊断码写死对照，且都能被诊断注册表分类（来源 build/transaction.ts）。
    expect(transaction.diagnostics).toEqual([
      'FH2_DIST_COMMIT_FAILED',
      'FH2_DIST_COMMIT_ROLLBACK_FAILED',
      'FH2_DIST_BACKUP_CLEANUP_FAILED',
    ])
    for (const code of transaction.diagnostics) {
      expect(() => classifyDiagnostic(code, 'build/transaction.ts')).not.toThrow()
    }
    // watch 忽略 .dist.fh2-next-* / .dist.fh2-backup-* 事务目录（isIgnoredWatchPath 探针）。
    const descriptor = {
      manifestPath: '/proj/fh2-plugin.json',
      projectRoot: '/proj',
      pluginEntry: '/proj/src/plugin.ts',
      typesOutDir: '/proj/src/generated',
      distRoot: '/proj/dist',
    }
    expect(isIgnoredWatchPath('/proj/.dist.fh2-next-abc123', descriptor)).toBe(true)
    expect(isIgnoredWatchPath('/proj/.dist.fh2-backup-abc123', descriptor)).toBe(true)
    expect(isIgnoredWatchPath('/proj/src/plugin.ts', descriptor)).toBe(false)
    // Capability 后端 watch 忽略规则与 notes 一致（isBackendWatchIgnored 行为写进 notes）。
    expect(transaction.notes?.some(note => note.includes('isIgnoredWatchPath'))).toBe(true)
  })

  it('capability-build 与 industry-workspace-build 的关键行为事实', () => {
    const capability = buildFlowDescriptor(BUILD_FLOWS_CONTRACT, 'capability-build')
    expect(capability.outputs.some(item => item.includes('.fh2/build-report.json'))).toBe(true)
    expect(capability.notes?.some(note => note.includes('watchCapability'))).toBe(true)
    expect(capability.failureBehavior.some(item => item.includes('FH2_CAPABILITY_BUILD_INPUT_CHANGED'))).toBe(true)

    const workspace = buildFlowDescriptor(BUILD_FLOWS_CONTRACT, 'industry-workspace-build')
    expect(workspace.preconditions.some(item => item.includes('capabilityIds 双向一致'))).toBe(true)
    expect(workspace.failureBehavior.some(item => item.includes('FH2_INDUSTRY_CAPABILITY_WORKSPACE_BUILD_ABORTED'))).toBe(true)
    expect(workspace.observablePhases.some(item => item.includes('串行构建每个 Capability'))).toBe(true)
  })

  it('序列化双跑字节一致且契约对象冻结', () => {
    expect(serializeBuildFlowsContract()).toBe(serializeBuildFlowsContract())
    expect(Object.isFrozen(BUILD_FLOWS_CONTRACT)).toBe(true)
    expect(Object.isFrozen(BUILD_FLOWS_CONTRACT.flows)).toBe(true)
    expect(Object.isFrozen(BUILD_FLOWS_CONTRACT.freshnessRules)).toBe(true)
    expect(Object.isFrozen(BUILD_FLOWS_CONTRACT.transaction)).toBe(true)
    for (const flow of BUILD_FLOWS_CONTRACT.flows) {
      expect(Object.isFrozen(flow)).toBe(true)
      expect(Object.isFrozen(flow.observablePhases)).toBe(true)
      expect(Object.isFrozen(flow.failureBehavior)).toBe(true)
    }
  })
})
