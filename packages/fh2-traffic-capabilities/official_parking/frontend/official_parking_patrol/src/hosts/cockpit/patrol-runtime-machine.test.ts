// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { createInitialRuntimeControlState, reducePatrolRuntimeControl } from './patrol-runtime-machine'

describe('patrol runtime control state', () => {
  it('运行任务经过三次识别失败后挂起，显式刷新重新开始', () => {
    let state = createInitialRuntimeControlState()
    state = reducePatrolRuntimeControl(state, { type: 'wayline-task-changed', taskId: 'task-1', status: 'running', flightId: 'flight-1' })

    for (let attempt = 1; attempt <= 3; attempt++) {
      state = reducePatrolRuntimeControl(state, { type: 'classification-started' })
      state = reducePatrolRuntimeControl(state, { type: 'classification-failed', maxAttempts: 3 })
      expect(state.kind).toBe(attempt === 3 ? 'classification-paused' : 'classification-wait')
      if (attempt < 3) state = reducePatrolRuntimeControl(state, { type: 'classification-retry' })
    }

    const oldEpoch = state.epoch
    state = reducePatrolRuntimeControl(state, { type: 'classification-refresh' })
    expect(state).toMatchObject({ kind: 'candidate', attempts: 0, epoch: oldEpoch + 1 })
  })

  it('taskId 清空后保留已激活任务，新任务到达才替换', () => {
    let state = createInitialRuntimeControlState()
    state = reducePatrolRuntimeControl(state, { type: 'wayline-task-changed', taskId: 'task-1', status: 'running', flightId: 'flight-1' })
    state = reducePatrolRuntimeControl(state, { type: 'task-activated', taskUuid: 'task-1' })
    const trackingEpoch = state.epoch
    state = reducePatrolRuntimeControl(state, { type: 'wayline-task-changed', taskId: '', status: null, flightId: '' })
    expect(state).toMatchObject({ kind: 'tracking', taskUuid: 'task-1', observedTaskId: 'task-1', epoch: trackingEpoch })

    state = reducePatrolRuntimeControl(state, { type: 'wayline-task-changed', taskId: 'task-1', status: 'running', flightId: 'flight-1' })
    expect(state).toMatchObject({ kind: 'tracking', taskUuid: 'task-1', observedTaskId: 'task-1', epoch: trackingEpoch })

    state = reducePatrolRuntimeControl(state, { type: 'task-finished' })
    state = reducePatrolRuntimeControl(state, { type: 'wayline-task-changed', taskId: 'task-2', status: 'running', flightId: 'flight-2' })
    expect(state).toMatchObject({ kind: 'candidate', taskUuid: 'task-2' })
  })

  it('冷启动终态任务被忽略，同一任务恢复运行后重新判别', () => {
    let state = createInitialRuntimeControlState()
    state = reducePatrolRuntimeControl(state, { type: 'wayline-task-changed', taskId: 'task-1', status: 'completed', flightId: 'flight-1' })
    expect(state.kind).toBe('ignored-terminal')

    state = reducePatrolRuntimeControl(state, { type: 'wayline-task-changed', taskId: 'task-1', status: 'running', flightId: 'flight-1' })
    expect(state).toMatchObject({ kind: 'candidate', taskUuid: 'task-1', attempts: 0 })
  })

  it('项目变化开启新 epoch 并重新判别当前观察任务', () => {
    let state = createInitialRuntimeControlState()
    state = reducePatrolRuntimeControl(state, { type: 'wayline-task-changed', taskId: 'task-1', status: 'running', flightId: 'flight-1' })
    const oldEpoch = state.epoch

    state = reducePatrolRuntimeControl(state, {
      type: 'context-changed',
      projectId: 'project-2',
      gatewaySn: 'dock-2',
    })
    expect(state).toMatchObject({ kind: 'candidate', taskUuid: 'task-1', epoch: oldEpoch + 1 })
  })

  it('同任务状态和 gateway 变化不重置已耗尽的识别次数', () => {
    let state = createInitialRuntimeControlState()
    state = reducePatrolRuntimeControl(state, { type: 'wayline-task-changed', taskId: 'task-1', status: 'running', flightId: 'flight-1' })
    for (let attempt = 0; attempt < 3; attempt++) {
      state = reducePatrolRuntimeControl(state, { type: 'classification-started' })
      state = reducePatrolRuntimeControl(state, { type: 'classification-failed', maxAttempts: 3 })
      if (state.kind === 'classification-wait') {
        state = reducePatrolRuntimeControl(state, { type: 'classification-retry' })
      }
    }
    expect(state).toMatchObject({ kind: 'classification-paused', attempts: 3 })

    state = reducePatrolRuntimeControl(state, { type: 'wayline-task-changed', taskId: 'task-1', status: 'paused', flightId: 'flight-1' })
    state = reducePatrolRuntimeControl(state, { type: 'context-changed', projectId: '', gatewaySn: 'dock-2' })
    expect(state).toMatchObject({ kind: 'classification-paused', attempts: 3 })
  })

  it('已激活巡逻任务被新 wayline taskId 替换，reviewing 同样先释放再判别', () => {
    let state = createInitialRuntimeControlState()
    state = reducePatrolRuntimeControl(state, { type: 'wayline-task-changed', taskId: 'patrol-task', status: 'running', flightId: 'flight-1' })
    state = reducePatrolRuntimeControl(state, { type: 'task-activated', taskUuid: 'patrol-task' })
    const trackingEpoch = state.epoch

    // 即时航线不再进入状态机；wayline 通道出现新 taskId 即任务替换，与 flightId 是否已知无关
    state = reducePatrolRuntimeControl(state, { type: 'wayline-task-changed', taskId: 'next-task', status: 'running', flightId: 'flight-1' })
    expect(state).toMatchObject({ kind: 'candidate', taskUuid: 'next-task', patrolFlightId: '', epoch: trackingEpoch + 1 })

    state = reducePatrolRuntimeControl(state, { type: 'task-activated', taskUuid: 'next-task' })
    state = reducePatrolRuntimeControl(state, { type: 'task-finished' })
    state = reducePatrolRuntimeControl(state, { type: 'wayline-task-changed', taskId: 'final-task', status: 'running', flightId: 'flight-2' })
    expect(state).toMatchObject({ kind: 'candidate', taskUuid: 'final-task', epoch: trackingEpoch + 2 })
  })

  it('新 taskId 缺少 flightId 时仍按任务替换处理', () => {
    let state = createInitialRuntimeControlState()
    state = reducePatrolRuntimeControl(state, { type: 'wayline-task-changed', taskId: 'patrol-task', status: 'running', flightId: 'flight-1' })
    state = reducePatrolRuntimeControl(state, { type: 'task-activated', taskUuid: 'patrol-task' })

    state = reducePatrolRuntimeControl(state, { type: 'wayline-task-changed', taskId: 'unknown-task', status: 'running', flightId: '' })
    expect(state).toMatchObject({ kind: 'candidate', taskUuid: 'unknown-task', patrolFlightId: '' })
  })

  it('flightId 已跨航次时即使 taskId 为空或不变也释放旧巡逻任务', () => {
    let state = createInitialRuntimeControlState()
    state = reducePatrolRuntimeControl(state, { type: 'wayline-task-changed', taskId: 'patrol-task', status: 'running', flightId: 'flight-1' })
    state = reducePatrolRuntimeControl(state, { type: 'task-activated', taskUuid: 'patrol-task' })
    const trackingEpoch = state.epoch

    // 新航次先到、taskId 暂空 → 立即释放
    state = reducePatrolRuntimeControl(state, { type: 'wayline-task-changed', taskId: '', status: null, flightId: 'flight-2' })
    expect(state).toMatchObject({ kind: 'idle', patrolFlightId: '', epoch: trackingEpoch + 1 })

    // 同一 taskId 但 flightId 跨航次 → 释放并重新判别
    state = reducePatrolRuntimeControl(state, { type: 'wayline-task-changed', taskId: 'patrol-task', status: 'running', flightId: 'flight-1' })
    state = reducePatrolRuntimeControl(state, { type: 'task-activated', taskUuid: 'patrol-task' })
    const secondEpoch = state.epoch
    state = reducePatrolRuntimeControl(state, { type: 'wayline-task-changed', taskId: 'patrol-task', status: 'running', flightId: 'flight-3' })
    expect(state).toMatchObject({ kind: 'candidate', taskUuid: 'patrol-task', epoch: secondEpoch + 1 })
  })
})
