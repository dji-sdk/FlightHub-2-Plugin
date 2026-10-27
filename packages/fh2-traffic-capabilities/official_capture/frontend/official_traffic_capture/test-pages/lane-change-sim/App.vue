<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="sim-app">
    <main class="sim-cockpit-shell">
      <aside class="sim-left-column">
        <sim-annotation-panel
          :runner="runner"
          :adding-mode="addingMode"
          @start-draw="handleStartDraw"
        />
        <sim-params-panel :runner="runner" />

        <div class="sim-log-panel">
          <sim-event-log :runner="runner" />
        </div>
      </aside>

      <section class="sim-right-column">
        <div class="sim-live-stage">
          <sim-canvas
            :runner="runner"
            :adding-mode="addingMode"
            @draw-finished="handleDrawFinished"
            @draw-cancelled="handleDrawCancelled"
          />

          <div class="cockpit-live-header-wrapper">
            <div class="header-logo">
              <span class="logo-icon">LC</span>
              <h1>变道抓拍算法验证模拟器</h1>
              <span class="version-tag">Detector Core</span>
            </div>
          </div>

          <div class="cockpit-live-header-wrapper right">
            <div class="header-chip status-chip" :class="{ playing: isPlaying }">
              <span class="chip-label">状态</span>
              <span class="chip-value">{{ isPlaying ? '运行中' : '暂停' }}</span>
            </div>
            <div class="header-chip time-chip">
              <span class="chip-label">虚拟时钟</span>
              <span class="chip-value">{{ (virtualNow / 1000).toFixed(3) }}s</span>
            </div>
          </div>
        </div>

        <div class="sim-control-panel">
          <sim-controls
            :runner="runner"
            :scenarios="scenarios"
            @scenario-changed="handleScenarioChanged"
          />
        </div>
      </section>
    </main>
  </div>
</template>

<script lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { defineComponent, onMounted, onUnmounted, ref, computed } from 'vue'
import { SimRunner } from './sim/runner'
import { SCENARIOS } from './scenarios'
import type { Point2D, ValidCoreRegion } from '../../src/hosts/cockpit/lane-change/detector-core'

import SimCanvas from './components/SimCanvas.vue'
import SimControls from './components/SimControls.vue'
import SimEventLog from './components/SimEventLog.vue'
import SimParamsPanel from './components/SimParamsPanel.vue'
import SimAnnotationPanel from './components/SimAnnotationPanel.vue'

export default defineComponent({
  name: 'LaneChangeSimApp',
  components: {
    SimCanvas,
    SimControls,
    SimEventLog,
    SimParamsPanel,
    SimAnnotationPanel,
  },
  setup () {
    const runner = new SimRunner()
    const scenarios = SCENARIOS
    const addingMode = ref<'line' | 'polygon' | null>(null)

    const isPlaying = computed(() => runner.clock.running)
    const virtualNow = computed(() => runner.clock.virtualNow)

    const handleScenarioChanged = (id: string) => {
      const found = scenarios.find(scenario => scenario.id === id)
      if (found) {
        runner.loadScenario(found)
      }
    }

    const handleStartDraw = (kind: 'line' | 'polygon' | null) => {
      addingMode.value = kind
    }

    const handleDrawCancelled = () => {
      addingMode.value = null
    }

    const handleDrawFinished = (points: Point2D[]) => {
      const kind = addingMode.value!
      addingMode.value = null

      const prefix = kind === 'line' ? 'MANUAL_LINE' : 'MANUAL_POLY'
      const id = `${prefix}_${Math.random().toString(36).substring(2, 6).toUpperCase()}`

      const region: ValidCoreRegion = kind === 'line'
        ? { id, kind: 'line', valid: true, points }
        : { id, kind: 'polygon', valid: true, points }
      runner.addManualRegion(region)
    }

    onMounted(() => {
      const defaultScenario = scenarios.find(scenario => scenario.id === 'line-slow-cross') ?? scenarios[0]
      if (defaultScenario) {
        runner.loadScenario(defaultScenario)
      }
    })

    onUnmounted(() => {
      runner.pause()
    })

    return {
      runner,
      scenarios,
      addingMode,
      isPlaying,
      virtualNow,
      handleScenarioChanged,
      handleStartDraw,
      handleDrawCancelled,
      handleDrawFinished,
    }
  },
})
</script>

<style>
html,
body,
#app {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
}

* {
  box-sizing: border-box;
}

::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

::-webkit-scrollbar-track {
  background: rgba(10, 13, 18, 0.8);
}

::-webkit-scrollbar-thumb {
  background: #303947;
  border-radius: 4px;
}

::-webkit-scrollbar-thumb:hover {
  background: #4a5568;
}

.sim-app {
  width: 100%;
  height: 100%;
  background: #050607;
  color: #e2e8f0;
}

.sim-cockpit-shell {
  display: grid;
  grid-template-columns: minmax(280px, 32fr) minmax(0, 68fr);
  gap: 8px;
  width: 100%;
  height: 100%;
  padding: 8px;
  overflow: hidden;
  background: #050607;
}

.sim-left-column {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.sim-right-column {
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 8px;
  min-width: 0;
  min-height: 0;
}

.sim-live-stage {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: #0b0b0b;
  border: 1px solid rgba(60, 67, 78, 0.92);
  border-radius: 4px;
}

.cockpit-live-header-wrapper {
  position: absolute;
  top: 4px;
  left: 4px;
  z-index: 120;
  display: flex;
  align-items: center;
  pointer-events: auto;
}

.cockpit-live-header-wrapper.right {
  right: 4px;
  left: auto;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}

.header-logo {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 4px 8px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 4px;
  background: rgba(17, 17, 17, 0.72);
  backdrop-filter: blur(8px);
}

.header-logo .logo-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  background: rgba(14, 165, 233, 0.18);
  border: 1px solid rgba(56, 189, 248, 0.42);
  color: #7dd3fc;
  font-size: 11px;
  font-weight: 700;
}

.header-logo h1 {
  margin: 0;
  color: #f8fafc;
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
}

.header-logo .version-tag {
  padding: 2px 6px;
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 4px;
  color: #94a3b8;
  background: rgba(15, 23, 42, 0.64);
  font-size: 10px;
  font-weight: 500;
  white-space: nowrap;
}

.header-chip {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 30px;
  padding: 4px 8px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 4px;
  background: rgba(17, 17, 17, 0.72);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.22);
  backdrop-filter: blur(8px);
  font-size: 12px;
}

.header-chip .chip-label {
  color: #94a3b8;
  font-weight: 500;
}

.header-chip .chip-value {
  color: #f1f5f9;
  font-family: Monaco, Consolas, monospace;
  font-weight: 700;
}

.header-chip.status-chip {
  border-color: rgba(248, 113, 113, 0.38);
}

.header-chip.status-chip .chip-value {
  color: #fca5a5;
}

.header-chip.status-chip.playing {
  border-color: rgba(52, 211, 153, 0.42);
}

.header-chip.status-chip.playing .chip-value {
  color: #6ee7b7;
}

.header-chip.time-chip .chip-value {
  color: #7dd3fc;
}

.sim-control-panel {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.sim-log-panel {
  flex: 1 1 180px;
  min-width: 0;
  min-height: 0;
}

.sim-left-column .sim-params-panel {
  flex: 0 1 300px;
}

.sim-left-column .sim-annotation-panel {
  flex: 0 0 auto;
}

@media (max-width: 1180px) {
  .sim-cockpit-shell {
    grid-template-columns: minmax(260px, 32fr) minmax(0, 68fr);
  }
}

@media (max-width: 900px) {
  .sim-cockpit-shell {
    grid-template-columns: 1fr;
    grid-template-rows: 42% minmax(0, 58%);
  }

  .sim-right-column {
    order: 1;
  }

  .sim-left-column {
    order: 2;
  }
}
</style>
