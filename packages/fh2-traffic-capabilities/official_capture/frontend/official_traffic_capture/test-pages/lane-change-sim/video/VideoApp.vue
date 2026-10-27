<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="video-app">
    <main class="video-shell">
      <aside class="video-left-column">
        <sim-annotation-panel
          :runner="runner"
          :adding-mode="addingMode"
          @start-draw="handleStartDraw"
        />
        <sim-params-panel :runner="runner" />

        <div class="video-log-panel">
          <sim-event-log :runner="runner" />
        </div>
      </aside>

      <section class="video-right-column">
        <div class="video-stage">
          <video-canvas
            :runner="runner"
            :adding-mode="addingMode"
            @draw-finished="handleDrawFinished"
            @draw-cancelled="handleDrawCancelled"
            @video-dropped="handleVideoDropped"
          />

          <div class="stage-header right">
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

        <div class="video-control-panel">
          <video-controls ref="controlsRef" :runner="runner" />
        </div>
      </section>
    </main>
  </div>
</template>

<script lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { defineComponent, ref, computed } from 'vue'
import { SimRunner } from '../sim/runner'
import type { Point2D, ValidCoreRegion } from '../../../src/hosts/cockpit/lane-change/detector-core'
import SimAnnotationPanel from '../components/SimAnnotationPanel.vue'
import SimParamsPanel from '../components/SimParamsPanel.vue'
import SimEventLog from '../components/SimEventLog.vue'
import VideoCanvas from './components/VideoCanvas.vue'
import VideoControls from './components/VideoControls.vue'

/**
 * 真机录像验证页（独立 tab）：上传 DJI 机载 MP4 提取 djmd 检测数据，
 * 在真实录像画面上绘制标注并回放生产 detector，验证违规是否可检出。
 */
export default defineComponent({
  name: 'VideoSimApp',
  components: {
    SimAnnotationPanel,
    SimParamsPanel,
    SimEventLog,
    VideoCanvas,
    VideoControls,
  },
  setup () {
    const runner = new SimRunner()
    const addingMode = ref<'line' | 'polygon' | null>(null)
    const controlsRef = ref<InstanceType<typeof VideoControls> | null>(null)

    const isPlaying = computed(() => runner.clock.running)
    const virtualNow = computed(() => runner.clock.virtualNow)

    const handleStartDraw = (kind: 'line' | 'polygon' | null) => {
      addingMode.value = kind
    }

    const handleDrawCancelled = () => {
      addingMode.value = null
    }

    const handleDrawFinished = (points: Point2D[]) => {
      const kind = addingMode.value!
      addingMode.value = null

      const prefix = kind === 'line' ? 'VIDEO_LINE' : 'VIDEO_POLY'
      const id = `${prefix}_${Math.random().toString(36).substring(2, 6).toUpperCase()}`

      const region: ValidCoreRegion = kind === 'line'
        ? { id, kind: 'line', valid: true, points }
        : { id, kind: 'polygon', valid: true, points }
      const replayTo = runner.clock.virtualNow
      runner.addManualRegion(region)
      // 画线会重建 Core；立即重放到当前画面，避免用户再次从 0 播放整段录像。
      if (replayTo > 0) runner.jumpToTime(replayTo)
    }

    const handleVideoDropped = (file: File) => {
      controlsRef.value?.uploadDroppedFile(file)
    }

    return {
      runner,
      addingMode,
      controlsRef,
      isPlaying,
      virtualNow,
      handleStartDraw,
      handleDrawCancelled,
      handleDrawFinished,
      handleVideoDropped,
    }
  },
})
</script>

<style scoped>
.video-app {
  width: 100%;
  height: 100%;
  color: #e2e8f0;
}

.video-shell {
  display: grid;
  grid-template-columns: minmax(280px, 32fr) minmax(0, 68fr);
  gap: 8px;
  width: 100%;
  height: 100%;
  padding: 8px;
  overflow: hidden;
  background: #050607;
}

.video-left-column {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.video-left-column .sim-params-panel {
  flex: 0 1 300px;
}

.video-left-column .sim-annotation-panel {
  flex: 0 0 auto;
}

.video-log-panel {
  flex: 1 1 180px;
  min-width: 0;
  min-height: 0;
}

.video-right-column {
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 8px;
  min-width: 0;
  min-height: 0;
}

.video-stage {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: #0b0b0b;
  border: 1px solid rgba(60, 67, 78, 0.92);
  border-radius: 4px;
}

.stage-header.right {
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 120;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
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

.video-control-panel {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

@media (max-width: 900px) {
  .video-shell {
    grid-template-columns: 1fr;
    grid-template-rows: 42% minmax(0, 58%);
  }

  .video-right-column {
    order: 1;
  }

  .video-left-column {
    order: 2;
  }
}
</style>
