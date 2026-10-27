// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { ref } from 'vue'

export class SimClock {
  private readonly virtualNowValue = ref(0)
  private lastRealTime = 0
  private readonly rate = ref(1.0)
  private readonly isPlaying = ref(false)

  get virtualNow () {
    return this.virtualNowValue.value
  }

  set virtualNow (val: number) {
    this.virtualNowValue.value = val
  }

  get playbackRate () {
    return this.rate.value
  }

  set playbackRate (r: number) {
    this.rate.value = r
  }

  get running () {
    return this.isPlaying.value
  }

  start () {
    this.isPlaying.value = true
    this.lastRealTime = performance.now()
  }

  pause () {
    this.isPlaying.value = false
  }

  step (dtMs: number) {
    this.virtualNowValue.value += dtMs
  }

  tick (): number {
    if (!this.isPlaying.value) return 0
    const now = performance.now()
    const dtReal = now - this.lastRealTime
    this.lastRealTime = now
    const dtVirtual = dtReal * this.rate.value
    this.virtualNowValue.value += dtVirtual
    return dtVirtual
  }
}
