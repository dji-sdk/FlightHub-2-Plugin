// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/**
 * N2：Start Center 状态机。
 *
 * loading →（工作区有效）ready
 *        →（无有效工程）start-center → opening / creating → ready
 *        → error（启动失败，可重试）
 *
 * opening/creating 失败回到 start-center 并保留错误信息（可恢复）。
 */
export type StartupPhase = 'loading' | 'start-center' | 'opening' | 'creating' | 'ready' | 'error'

export const useStartupStore = defineStore('startup', () => {
  const phase = ref<StartupPhase>('loading')
  /** opening/creating 的可恢复错误（展示在 Start Center）。 */
  const startupError = ref<string | null>(null)

  const showStartCenter = computed(() =>
    phase.value === 'start-center' || phase.value === 'opening' || phase.value === 'creating')
  const busy = computed(() => phase.value === 'opening' || phase.value === 'creating')

  function setPhase (next: StartupPhase): void {
    phase.value = next
    if (next === 'ready' || next === 'loading') startupError.value = null
  }

  /** 可恢复失败：回到 start-center 并展示原因。 */
  function fail (message: string): void {
    startupError.value = message
    phase.value = 'start-center'
  }

  return { phase, startupError, showStartCenter, busy, setPhase, fail }
})
