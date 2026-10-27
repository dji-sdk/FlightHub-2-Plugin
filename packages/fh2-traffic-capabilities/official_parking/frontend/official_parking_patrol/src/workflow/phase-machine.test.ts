// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import type { PatrolPhase } from './phase-machine'
import {
  isPatrolPhase,
  isTerminalPhase,
  shouldDropSnapshotRevision,
  shouldDropWsRevision,
  shouldUpdatePhase,
} from './phase-machine'

describe('phase 单调保护', () => {
  it('非终态按序严格递增', () => {
    expect(shouldUpdatePhase('dispatching', 'pending')).toBe(true)
    expect(shouldUpdatePhase('pending', 'phase1')).toBe(true)
    expect(shouldUpdatePhase('phase1', 'phase1_done')).toBe(true)
    expect(shouldUpdatePhase('phase1_done', 'phase2')).toBe(true)
    expect(shouldUpdatePhase('phase2', 'completed')).toBe(true)
  })

  it('回退被拒绝', () => {
    expect(shouldUpdatePhase('phase2', 'phase1')).toBe(false)
    expect(shouldUpdatePhase('phase1_done', 'pending')).toBe(false)
    expect(shouldUpdatePhase('completed', 'phase2')).toBe(false)
  })

  it('终态吸收：终态之间同序号不互相覆盖', () => {
    expect(shouldUpdatePhase('completed', 'failed')).toBe(false)
    expect(shouldUpdatePhase('manual_control', 'completed')).toBe(false)
    expect(shouldUpdatePhase('skipped', 'manual_control')).toBe(false)
  })

  it('终态判定', () => {
    const phases: PatrolPhase[] = ['completed', 'failed', 'skipped', 'manual_control']
    for (const phase of phases) expect(isTerminalPhase(phase)).toBe(true)
    for (const phase of ['dispatching', 'pending', 'phase1', 'phase1_done', 'phase2'] as PatrolPhase[]) {
      expect(isTerminalPhase(phase)).toBe(false)
    }
  })

  it('phase 字面量校验', () => {
    expect(isPatrolPhase('phase1')).toBe(true)
    expect(isPatrolPhase('initial')).toBe(false)
    expect(isPatrolPhase('')).toBe(false)
  })
})

describe('revision 防乱序', () => {
  it('wS 增量：<= 当前值整条丢弃（含相等）', () => {
    expect(shouldDropWsRevision(10, 9)).toBe(true)
    expect(shouldDropWsRevision(10, 10)).toBe(true)
    expect(shouldDropWsRevision(10, 11)).toBe(false)
  })

  it('hTTP 快照：仅更旧（<）丢弃，同 revision 允许权威覆盖', () => {
    expect(shouldDropSnapshotRevision(10, 9)).toBe(true)
    expect(shouldDropSnapshotRevision(10, 10)).toBe(false)
    expect(shouldDropSnapshotRevision(10, 11)).toBe(false)
  })

  it('revision=0/缺失 视为旧协议兼容，不丢弃', () => {
    expect(shouldDropWsRevision(10, 0)).toBe(false)
    expect(shouldDropWsRevision(10, Number.NaN)).toBe(false)
    expect(shouldDropSnapshotRevision(10, 0)).toBe(false)
  })
})
