// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { reactive, ref, shallowRef } from 'vue'
import {
  type CoreBBox,
  DEFAULT_DETECTOR_PARAMS,
  type DetectorCoreParams,
  type ValidCoreRegion,
  createDetectorCore,
} from '../../../src/hosts/cockpit/lane-change/detector-core'
import type { CarTargetLike } from '../../../src/hosts/cockpit/lane-change/target-filter'
import type { Scenario } from './types'
import { SimClock } from './clock'
import { type SimFrameSource, SyntheticFrameSource } from './frame-source'

export { getBBoxesAtTime } from './frame-source'

export interface SimEvent {
  id: string;
  time: number;
  type: 'trigger' | 'log';
  objId?: string | number;
  regionId?: string;
  rule?: string;
  channel?: string;
  payload?: unknown;
}

/** 触发后 1s 内对应目标在画布上高亮。 */
const TRIGGER_HIGHLIGHT_MS = 1000

/** 面板可写的参数副本（DetectorCoreParams 去 readonly）。 */
type MutableDetectorCoreParams = { -readonly [K in keyof DetectorCoreParams]: DetectorCoreParams[K] }

export class SimRunner {
  private static readonly DISCRETE_FRAME_EPSILON_MS = 0.5

  public clock = new SimClock()
  public scenario = shallowRef<Scenario | null>(null)
  public events = ref<SimEvent[]>([])
  public currentBBoxes = ref<CoreBBox[]>([])
  public currentRawTargets = ref<CarTargetLike[]>([])
  public showFilteredTargets = ref(false)
  public processedFrameCount = ref(0)
  public params = reactive<MutableDetectorCoreParams>({ ...DEFAULT_DETECTOR_PARAMS })
  public triggerHighlights = new Map<string | number, number>()

  public sourceControls = reactive({
    positionSigma: 0,
    sizeSigma: 0,
    dropoutRate: 0,
    /** null 表示按场景 keyframe；指定值覆盖所有合成目标的语义状态。 */
    stateOverride: null as string | null,
    seed: 1,
  })

  public hiddenRegionIds = ref<Set<string>>(new Set())
  private core = createDetectorCore()
  private frameSource: SimFrameSource = new SyntheticFrameSource([])
  private externalFrameSource: SimFrameSource | null = null
  private animationFrameId: number | null = null
  private lastVirtualTime = 0
  private processedDiscreteFrameKeys = new Set<string>()
  private manualRegions = ref<ValidCoreRegion[]>([])
  private frameSequence = 0
  private lastSourceSequence: number | null = null

  get activeRegions (): ValidCoreRegion[] {
    return this.allRegions.filter(region => !this.hiddenRegionIds.value.has(region.id))
  }

  get allRegions (): ValidCoreRegion[] {
    const scRegions = this.scenario.value?.regions ?? []
    return [...scRegions, ...this.manualRegions.value]
  }

  get manualRegionList (): ValidCoreRegion[] {
    return this.manualRegions.value
  }

  public toggleRegionVisibility (id: string) {
    if (this.hiddenRegionIds.value.has(id)) {
      this.hiddenRegionIds.value.delete(id)
    } else {
      this.hiddenRegionIds.value.add(id)
    }
    this.recreateCore()
    this.reset()
  }

  public addManualRegion (region: ValidCoreRegion) {
    this.manualRegions.value.push(region)
    this.recreateCore()
    this.reset()
  }

  public removeManualRegion (id: string) {
    this.manualRegions.value = this.manualRegions.value.filter(region => region.id !== id)
    this.recreateCore()
    this.reset()
  }

  public clearManualRegions () {
    this.manualRegions.value = []
    this.recreateCore()
    this.reset()
  }

  public loadScenario (scenario: Scenario) {
    this.scenario.value = scenario
    this.resetSourceControls()
    this.externalFrameSource = null
    this.frameSource = new SyntheticFrameSource(
      scenario.tracks,
      scenario.noiseProfile ?? null,
      scenario.frameTimes,
    )
    this.manualRegions.value = []
    this.recreateCore()
    this.reset()
  }

  public loadFrameSourceScenario (scenario: Scenario, frameSource: SimFrameSource) {
    this.scenario.value = scenario
    this.externalFrameSource = frameSource
    this.frameSource = frameSource
    this.manualRegions.value = []
    this.recreateCore()
    this.reset()
  }

  public applySourceControls () {
    if (!this.scenario.value || this.externalFrameSource) return
    this.frameSource = new SyntheticFrameSource(
      this.scenario.value.tracks,
      this.getEffectiveNoiseProfile(),
      this.scenario.value.frameTimes,
      this.sourceControls.stateOverride,
    )
    this.reset()
  }

  public resetParams () {
    Object.assign(this.params, DEFAULT_DETECTOR_PARAMS)
    this.resetSourceControls()
    if (this.scenario.value && !this.externalFrameSource) {
      this.frameSource = new SyntheticFrameSource(
        this.scenario.value.tracks,
        this.getEffectiveNoiseProfile(),
        this.scenario.value.frameTimes,
        this.sourceControls.stateOverride,
      )
    }
    this.recreateCore()
    this.reset()
  }

  public recreateCore () {
    this.core.reset()
    this.core = createDetectorCore({ paramsOverride: { ...this.params } })
    this.triggerHighlights.clear()
  }

  private addEvent (e: SimEvent) {
    this.events.value.push(e)
    // 限制事件列表长度，避免溢出
    if (this.events.value.length > 1000) {
      this.events.value.shift()
    }
  }

  private resetSourceControls () {
    const base = this.scenario.value?.noiseProfile
    Object.assign(this.sourceControls, {
      positionSigma: base?.positionSigma ?? 0,
      sizeSigma: base?.sizeSigma ?? 0,
      dropoutRate: base?.dropoutRate ?? 0,
      seed: base?.seed ?? 1,
      stateOverride: null,
    })
  }

  private getEffectiveNoiseProfile () {
    const { positionSigma, sizeSigma, dropoutRate, seed } = this.sourceControls
    if (positionSigma === 0 && sizeSigma === 0 && dropoutRate === 0) return null
    return { seed, positionSigma, sizeSigma, dropoutRate }
  }

  private getBBoxesAtTime (t: number): CoreBBox[] {
    return this.frameSource.getBBoxesAtTime(t)
  }

  private getDisplayTime (t: number): number | null {
    const frameTimes = this.getDiscreteFrameTimes()
    if (!frameTimes) return t
    let displayTime: number | null = null
    for (const frameT of frameTimes) {
      if (frameT > t + SimRunner.DISCRETE_FRAME_EPSILON_MS) break
      displayTime = frameT
    }
    return displayTime
  }

  private getDisplayBBoxesAtTime (t: number): CoreBBox[] {
    const displayTime = this.getDisplayTime(t)
    if (displayTime === null) return []
    return this.frameSource.getDisplayBBoxesAtTime?.(displayTime)
      ?? this.getBBoxesAtTime(displayTime)
  }

  private getDisplayRawTargetsAtTime (t: number): CarTargetLike[] {
    const displayTime = this.getDisplayTime(t)
    if (displayTime === null) return []
    return this.frameSource.getDisplayRawTargetsAtTime?.(displayTime)
      ?? this.frameSource.getRawTargetsAtTime?.(displayTime)
      ?? []
  }

  /** 刷新画布展示数据：参与判定的 bbox 与（可选）未过滤原始目标。 */
  private syncDisplayState (t: number) {
    this.currentBBoxes.value = this.getDisplayBBoxesAtTime(t)
    this.currentRawTargets.value = this.getDisplayRawTargetsAtTime(t)
  }

  private clearDisplayState () {
    this.currentBBoxes.value = []
    this.currentRawTargets.value = []
  }

  private getDiscreteFrameTimes (): number[] | null {
    return this.frameSource.getFrameTimes?.(this.scenario.value?.duration) ?? null
  }

  private getFrameTimeKey (t: number): string {
    return String(Math.round(t * 1000))
  }

  private getMatchedDiscreteFrameTime (t: number): number | null {
    const frameTimes = this.getDiscreteFrameTimes()
    if (!frameTimes) return null
    return frameTimes.find(frameT => Math.abs(frameT - t) <= SimRunner.DISCRETE_FRAME_EPSILON_MS) ?? null
  }

  private getNextDiscreteFrameTime (t: number): number | null {
    const frameTimes = this.getDiscreteFrameTimes()
    if (!frameTimes) return null
    return frameTimes.find(frameT => frameT > t + SimRunner.DISCRETE_FRAME_EPSILON_MS) ?? null
  }

  private getPrevDiscreteFrameTime (t: number): number | null {
    const frameTimes = this.getDiscreteFrameTimes()
    if (!frameTimes) return null
    for (let i = frameTimes.length - 1; i >= 0; i--) {
      if (frameTimes[i]! < t - SimRunner.DISCRETE_FRAME_EPSILON_MS) return frameTimes[i]!
    }
    return null
  }

  private processDiscreteFramesBetween (fromExclusive: number, toInclusive: number) {
    const frameTimes = this.getDiscreteFrameTimes()
    if (!frameTimes) return false
    for (const frameT of frameTimes) {
      if (frameT > fromExclusive + SimRunner.DISCRETE_FRAME_EPSILON_MS
        && frameT <= toInclusive + SimRunner.DISCRETE_FRAME_EPSILON_MS) {
        this.processFrameAt(frameT)
      }
    }
    return true
  }

  private processFrameAt (t: number) {
    const frameTimes = this.getDiscreteFrameTimes()
    const matchedFrameTime = frameTimes ? this.getMatchedDiscreteFrameTime(t) : null
    if (frameTimes && matchedFrameTime === null) return
    if (frameTimes) {
      const key = this.getFrameTimeKey(matchedFrameTime!)
      if (this.processedDiscreteFrameKeys.has(key)) return
      this.processedDiscreteFrameKeys.add(key)
    }

    const sourceSequence = this.frameSource.getSequenceAtTime?.(t) ?? null
    const sourceContinuous = sourceSequence === null
      || this.lastSourceSequence === null
      || sourceSequence === this.lastSourceSequence + 1
    if (sourceSequence !== null) this.lastSourceSequence = sourceSequence
    const events = this.core.processFrame({
      now: t,
      sequence: this.frameSequence++,
      continuous: sourceContinuous,
      regions: this.activeRegions,
      bboxes: this.getBBoxesAtTime(t),
    })
    this.processedFrameCount.value += 1
    for (const event of events) {
      this.triggerHighlights.set(event.objId, t)
      this.addEvent({
        id: Math.random().toString(36).substring(2, 9),
        time: t,
        type: 'trigger',
        objId: event.objId,
        regionId: event.regionId,
        rule: event.rule,
        payload: event,
      })
    }
  }

  /** 当前时刻是否处于触发高亮窗口（画布着色用）。 */
  public isTriggered (objId: string | number): boolean {
    const triggeredAt = this.triggerHighlights.get(objId)
    return triggeredAt !== undefined && this.clock.virtualNow - triggeredAt < TRIGGER_HIGHLIGHT_MS
  }

  public play () {
    if (this.clock.running) return
    this.clock.start()
    this.lastVirtualTime = this.clock.virtualNow
    this.loop()
  }

  public pause () {
    this.clock.pause()
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId)
      this.animationFrameId = null
    }
  }

  public stepForward () {
    this.pause()
    const scenarioDuration = this.scenario.value?.duration ?? 3000
    const targetT = Math.min(
      scenarioDuration,
      this.getNextDiscreteFrameTime(this.clock.virtualNow) ?? this.clock.virtualNow + 16,
    )
    this.processFrameAt(targetT)
    this.clock.virtualNow = targetT
    this.lastVirtualTime = targetT
    this.syncDisplayState(targetT)
  }

  public stepBackward () {
    this.pause()
    const targetTime = Math.max(0, this.getPrevDiscreteFrameTime(this.clock.virtualNow) ?? this.clock.virtualNow - 16)
    this.jumpToTime(targetTime)
  }

  public reset () {
    this.pause()
    this.clock.virtualNow = 0
    this.lastVirtualTime = 0
    this.processedFrameCount.value = 0
    this.frameSequence = 0
    this.lastSourceSequence = null
    this.processedDiscreteFrameKeys.clear()
    this.events.value = []
    this.clearDisplayState()
    this.triggerHighlights.clear()
    this.core.reset()
    this.syncToTime()
  }

  public jumpToTime (t: number) {
    this.pause()
    const isBackward = t < this.clock.virtualNow
    this.clock.virtualNow = t
    this.lastVirtualTime = t

    if (isBackward || this.getDiscreteFrameTimes()) {
      // 倒退时需要重置 core 并从 0 重新追赶数据，保证状态机正确
      this.core.reset()
      this.frameSequence = 0
      this.lastSourceSequence = null
      this.processedFrameCount.value = 0
      this.processedDiscreteFrameKeys.clear()
      this.events.value = []
      this.clearDisplayState()
      this.triggerHighlights.clear()
      const frameTimes = this.getDiscreteFrameTimes()
      if (frameTimes) {
        for (const frameT of frameTimes) {
          if (frameT > t + SimRunner.DISCRETE_FRAME_EPSILON_MS) break
          this.processFrameAt(frameT)
        }
      } else {
        // 从 0 开始，16ms 步长模拟到 t
        let simT = 0
        const stepSize = 16
        while (simT < t) {
          this.processFrameAt(simT)
          simT += stepSize
        }
      }
    }

    this.syncToTime()
  }

  public syncToTime () {
    const t = this.clock.virtualNow
    this.syncDisplayState(t)
    this.processFrameAt(t)
  }

  private loop = () => {
    if (!this.clock.running) return

    this.clock.tick()
    const currentT = this.clock.virtualNow

    if (this.processDiscreteFramesBetween(this.lastVirtualTime, currentT)) {
      this.lastVirtualTime = currentT
    } else {
      // 每一帧以 16ms 的步长喂给 core，确保状态机精确
      const stepSize = 16
      let t = this.lastVirtualTime + stepSize
      while (t <= currentT) {
        this.processFrameAt(t)
        // 保留未满 16ms 的残余时间，防低速下吞帧
        this.lastVirtualTime = t
        t += stepSize
      }
    }

    this.syncDisplayState(currentT)

    const scenarioDuration = this.scenario.value?.duration ?? 3000
    if (currentT >= scenarioDuration) {
      this.pause()
      this.clock.virtualNow = scenarioDuration
      this.syncToTime()
      return
    }

    this.animationFrameId = requestAnimationFrame(this.loop)
  }
}
