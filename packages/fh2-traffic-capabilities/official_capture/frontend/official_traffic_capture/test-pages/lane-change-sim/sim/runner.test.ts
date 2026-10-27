// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { SCENARIOS } from '../scenarios/presets'
import type { CoreBBox } from '../../../src/hosts/cockpit/lane-change/detector-core'
import { type SimFrameSource, SyntheticFrameSource } from './frame-source'
import { SimRunner } from './runner'

describe('合成场景回放', () => {
  it('噪声显式设为 0 时使用无扰动 bbox，切换场景恢复该场景默认值', () => {
    const base = SCENARIOS.find(scenario => scenario.id === 'line-diagonal-concurrent-traffic')!
    const scenario = { ...base, noiseProfile: { seed: 45, positionSigma: 0.003, sizeSigma: 0.004 } }
    const runner = new SimRunner()
    runner.loadScenario(scenario)
    runner.jumpToTime(1120)
    const expected = new SyntheticFrameSource(base.tracks).getBBoxesAtTime(1120)
    expect(runner.currentBBoxes.value).not.toEqual(expected)
    runner.sourceControls.positionSigma = 0
    runner.sourceControls.sizeSigma = 0
    runner.applySourceControls()
    runner.jumpToTime(1120)
    expect(runner.currentBBoxes.value).toEqual(expected)
    runner.loadScenario(base)
    expect(runner.sourceControls.positionSigma).toBe(0)
    expect(runner.sourceControls.sizeSigma).toBe(0)
  })

  it('斜拍逐帧回放先直行零事件，再各车跨线一次，倒退重放结果一致', () => {
    const scenario = SCENARIOS.find(item => item.id === 'line-diagonal-concurrent-traffic')!
    const runner = new SimRunner()
    runner.loadScenario(scenario)
    runner.jumpToTime(840)
    expect(runner.events.value).toEqual([])
    runner.jumpToTime(scenario.duration)
    const pairs = runner.events.value.map(event => [event.objId, event.regionId])
    expect(pairs).toHaveLength(6)
    runner.jumpToTime(840)
    expect(runner.events.value).toEqual([])
    runner.jumpToTime(scenario.duration)
    expect(runner.events.value.map(event => [event.objId, event.regionId])).toEqual(pairs)
  })

  it('录制源检测序号跳号时仍连接同 ID 稀疏轨迹', () => {
    const times = [0, 100, 200, 300]
    const sequences = [0, 1, 2, 4]
    const boxes = [0.44, 0.44, 0.44, 0.56].map((cy): CoreBBox[] => [{
      objId: 1,
      rect: { x1: 0.38, y1: cy - 0.02, x2: 0.42, y2: cy + 0.02 },
    }])
    const source: SimFrameSource = {
      getFrameTimes: () => times,
      getBBoxesAtTime: t => boxes[times.indexOf(t)] ?? [],
      getSequenceAtTime: t => sequences[times.indexOf(t)] ?? null,
    }
    const runner = new SimRunner()
    runner.loadFrameSourceScenario({
      id: 'gap',
      name: 'gap',
      description: 'gap',
      duration: 300,
      regions: [{ id: 'line', kind: 'line', valid: true, points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }] }],
      tracks: [],
    }, source)
    runner.jumpToTime(300)
    expect(runner.events.value.map(event => event.rule)).toEqual(['line-enter'])
  })

  it('首个检测帧到达前不提前展示未来 bbox', () => {
    const bbox: CoreBBox = { objId: 1, rect: { x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 } }
    const source: SimFrameSource = {
      getFrameTimes: () => [100],
      getBBoxesAtTime: () => [bbox],
    }
    const runner = new SimRunner()
    runner.loadFrameSourceScenario({ id: 'future', name: 'future', description: 'future', duration: 200, regions: [], tracks: [] }, source)
    expect(runner.currentBBoxes.value).toEqual([])
    runner.jumpToTime(100)
    expect(runner.currentBBoxes.value).toEqual([bbox])
  })
})
