<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="sim-controls-panel">
    <div class="control-row">
      <div class="control-item scenario-select">
        <label>场景预设：</label>
        <select :value="currentScenarioId" @change="handleScenarioChange">
          <option
            v-for="sc in scenarioOptions"
            :key="sc.id"
            :value="sc.id"
          >
            {{ sc.name }}
          </option>
        </select>
      </div>

      <div class="control-item play-buttons">
        <button
          class="control-btn play-pause-btn"
          :class="{ playing: isPlaying }"
          @click="togglePlay"
        >
          {{ isPlaying ? '暂停' : '播放' }}
        </button>

        <button class="control-btn" @click="stepBackward">
          上一帧
        </button>

        <button class="control-btn" @click="stepForward">
          下一帧
        </button>

        <button class="control-btn btn-reset" @click="reset">
          重置
        </button>
      </div>

      <div class="control-item playback-rate">
        <label>播放倍速：</label>
        <select :value="playbackRate" @change="handleRateChange">
          <option :value="0.1">0.1x</option>
          <option :value="0.25">0.25x</option>
          <option :value="0.5">0.5x</option>
          <option :value="1">1.0x</option>
          <option :value="2">2.0x</option>
          <option :value="5">5.0x</option>
          <option :value="10">10x</option>
        </select>
      </div>

      <div class="control-item replay-loader">
        <input
          ref="replayFileInput"
          type="file"
          accept=".ndjson,.jsonl,.txt"
          class="replay-file-input"
          @change="handleReplayFileChange"
        >
        <button class="control-btn" @click="openReplayFile">
          加载录制
        </button>
        <span v-if="replayLoadError" class="replay-error">{{ replayLoadError }}</span>
      </div>
    </div>

    <div class="progress-row">
      <span class="time-label">{{ formatTime(virtualNow) }}</span>
      <div class="slider-wrapper">
        <input
          type="range"
          :value="virtualNow"
          :min="0"
          :max="duration"
          :step="16"
          @input="handleSliderInput"
        >
      </div>
      <span class="time-label">{{ formatTime(duration) }}</span>
    </div>

    <div v-if="currentScenario" class="scenario-desc">
      <div class="desc-header">
        <span class="info-icon">ℹ</span>
        <strong>场景验证说明：</strong>
      </div>
      <p class="desc-text">{{ currentScenario.description }}</p>
    </div>

    <div v-if="replayAnalysis" class="replay-analysis">
      <div class="analysis-title">录制摘要</div>
      <div class="analysis-grid">
        <span>frames {{ replayAnalysis.frames }}</span>
        <span>{{ replayAnalysis.avgFps.toFixed(1) }} fps</span>
        <span>interval p50 {{ Math.round(replayAnalysis.frameIntervalP50Ms) }}ms</span>
        <span>p95 {{ Math.round(replayAnalysis.frameIntervalP95Ms) }}ms</span>
        <span>targets {{ Math.round(replayAnalysis.targetCountAvg) }} avg</span>
        <span>ids {{ replayAnalysis.uniqueIds }}</span>
        <span>short {{ replayAnalysis.shortLivedIds }} / {{ (replayAnalysis.shortLivedIdRatio * 100).toFixed(1) }}%</span>
        <span>bbox p50 {{ replayAnalysis.bboxWidthP50.toFixed(4) }}</span>
        <span>offscreen {{ (replayAnalysis.offscreenBBoxRatio * 100).toFixed(2) }}%</span>
        <span>dup {{ replayAnalysis.duplicatePairCount }}</span>
        <span v-if="replayAnalysis.aglMeters !== undefined">AGL {{ formatNumber(replayAnalysis.aglMeters, 1) }}m</span>
        <span v-else-if="replayAnalysis.height !== undefined">height {{ formatNumber(Number(replayAnalysis.height), 1) }}m</span>
        <span v-if="replayAnalysis.zoomFactor !== undefined">zoom {{ replayAnalysis.zoomFactor }}</span>
        <span v-if="replayAnalysis.parseErrors > 0" class="analysis-warning">skip {{ replayAnalysis.parseErrors }} bad lines</span>
      </div>
      <p v-if="replayAnalysis.notes.length > 0" class="analysis-note">
        {{ replayAnalysis.notes[0] }}
      </p>
    </div>
  </div>
</template>

<script lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { computed, defineComponent, ref, type PropType } from 'vue'
import type { SimRunner } from '../sim/runner'
import type { Scenario } from '../sim/types'
import { createReplayScenario, parseLaneChangeReplayNdjson, ReplayFrameSource } from '../sim/replay-source'
import { analyzeLaneChangeReplay, type ReplayAnalysisSummary } from '../sim/replay-analysis'
import { BUILT_IN_REPLAY_RECORDINGS } from '../recordings'

export default defineComponent({
  name: 'SimControls',
  props: {
    runner: {
      type: Object as PropType<SimRunner>,
      required: true,
    },
    scenarios: {
      type: Array as PropType<Scenario[]>,
      required: true,
    },
  },
  emits: ['scenario-changed'],
  setup (props, { emit }) {
    const isPlaying = computed(() => props.runner.clock.running)
    const playbackRate = computed(() => props.runner.clock.playbackRate)
    const virtualNow = computed(() => props.runner.clock.virtualNow)
    const duration = computed(() => props.runner.scenario.value?.duration ?? 3000)
    const currentScenario = computed(() => props.runner.scenario.value)
    const currentScenarioId = computed(() => props.runner.scenario.value?.id ?? '')
    const replayFileInput = ref<HTMLInputElement | null>(null)
    const replayLoadError = ref('')
    const replayAnalysis = ref<ReplayAnalysisSummary | null>(null)
    const scenarioOptions = computed(() => {
      const current = currentScenario.value
      const baseOptions = [
        ...props.scenarios.map(scenario => ({ id: scenario.id, name: scenario.name })),
        ...BUILT_IN_REPLAY_RECORDINGS.map(recording => ({
          id: recording.id,
          name: recording.name,
        })),
      ]
      if (!current || baseOptions.some(sc => sc.id === current.id)) return baseOptions
      return [{ id: current.id, name: current.name }, ...baseOptions]
    })

    const togglePlay = () => {
      if (props.runner.clock.running) {
        props.runner.pause()
      } else {
        props.runner.play()
      }
    }

    const stepForward = () => {
      props.runner.stepForward()
    }

    const stepBackward = () => {
      props.runner.stepBackward()
    }

    const reset = () => {
      props.runner.reset()
    }

    const loadReplayText = (fileName: string, text: string, options?: { id?: string; name?: string }) => {
      replayLoadError.value = ''
      const replay = parseLaneChangeReplayNdjson(text)
      if (replay.frames.length === 0) {
        replayAnalysis.value = null
        replayLoadError.value = '录制文件没有 frame'
        return
      }
      const scenario = createReplayScenario(fileName, replay, options)
      replayAnalysis.value = analyzeLaneChangeReplay(replay)
      props.runner.loadFrameSourceScenario(scenario, new ReplayFrameSource(replay))
    }

    const loadBuiltInReplay = async (recording: typeof BUILT_IN_REPLAY_RECORDINGS[number]) => {
      replayLoadError.value = ''
      const response = await fetch(recording.url)
      if (!response.ok) {
        throw new Error(`加载内置录制失败: ${response.status} ${response.statusText}`)
      }
      loadReplayText(recording.fileName, await response.text(), {
        id: recording.id,
        name: recording.name,
      })
    }

    const handleScenarioChange = (e: Event) => {
      const id = (e.target as HTMLSelectElement).value
      replayAnalysis.value = null
      replayLoadError.value = ''
      const builtIn = BUILT_IN_REPLAY_RECORDINGS.find(recording => recording.id === id)
      if (builtIn) {
        void loadBuiltInReplay(builtIn).catch(error => {
          replayLoadError.value = error instanceof Error ? error.message : String(error)
        })
        return
      }
      emit('scenario-changed', id)
    }

    const handleRateChange = (e: Event) => {
      const value = Number((e.target as HTMLSelectElement).value)
      if (Number.isFinite(value) && value > 0) {
        props.runner.clock.playbackRate = value
      }
    }

    const handleSliderInput = (e: Event) => {
      const value = Number((e.target as HTMLInputElement).value)
      if (Number.isFinite(value)) {
        props.runner.jumpToTime(Math.max(0, Math.min(duration.value, value)))
      }
    }

    const openReplayFile = () => {
      replayFileInput.value?.click()
    }

    const handleReplayFileChange = (e: Event) => {
      const input = e.target as HTMLInputElement
      const file = input.files?.[0]
      if (!file) return
      void file.text().then((text) => {
        loadReplayText(file.name, text)
      }).finally(() => {
        input.value = ''
      })
    }

    const formatTime = (ms: number) => {
      return `${(ms / 1000).toFixed(2)}s`
    }

    const formatNumber = (value: number, digits: number) => {
      return Number.isFinite(value) ? value.toFixed(digits) : 'n/a'
    }

    return {
      isPlaying,
      playbackRate,
      virtualNow,
      duration,
      currentScenario,
      currentScenarioId,
      scenarioOptions,
      replayFileInput,
      replayLoadError,
      replayAnalysis,
      togglePlay,
      stepForward,
      stepBackward,
      reset,
      handleScenarioChange,
      handleRateChange,
      handleSliderInput,
      openReplayFile,
      handleReplayFileChange,
      formatTime,
      formatNumber,
    }
  },
})
</script>

<style scoped>
.sim-controls-panel {
  background-color: rgba(17, 17, 17, 0.76);
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 4px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(8px);
}

.control-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.control-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.control-item label {
  color: #94a3b8;
  font-size: 12px;
  white-space: nowrap;
}

.control-item select {
  background-color: rgba(17, 21, 29, 0.94);
  border: 1px solid #2d3748;
  color: #e2e8f0;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  cursor: pointer;
  max-width: 250px;
}

.control-item select:hover {
  border-color: #3b82f6;
}

.control-item select option {
  background-color: #1a1f29;
  color: #94a3b8;
}

.scenario-select select {
  width: 250px;
}

.playback-rate select {
  width: 90px;
}

.play-buttons {
  gap: 6px;
}

.control-btn {
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 4px;
  border: 1px solid #3b4d6b;
  background-color: #242f41;
  color: #cbd5e1;
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}

.control-btn:hover {
  background-color: #2d3f59;
  color: #fff;
}

.control-btn.play-pause-btn {
  border-color: rgba(52, 211, 153, 0.5);
  color: #6ee7b7;
}

.control-btn.play-pause-btn.playing {
  border-color: rgba(248, 113, 113, 0.5);
  color: #fca5a5;
}

.control-btn.btn-reset {
  border-color: rgba(239, 68, 68, 0.5);
  color: #fca5a5;
}

.replay-loader {
  position: relative;
}

.replay-file-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.replay-error {
  color: #fca5a5;
  font-size: 11px;
}

.progress-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.time-label {
  color: #7dd3fc;
  font-size: 11px;
  font-family: monospace;
  width: 44px;
  text-align: center;
}

.slider-wrapper {
  flex: 1;
  min-width: 0;
}

.slider-wrapper input[type="range"] {
  width: 100%;
  accent-color: #3b82f6;
  cursor: pointer;
}

.scenario-desc {
  padding: 6px 8px;
  background-color: rgba(30, 58, 138, 0.18);
  border: 1px solid rgba(59, 130, 246, 0.25);
  border-radius: 4px;
}

.desc-header {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #93c5fd;
  font-size: 11px;
}

.info-icon {
  font-style: normal;
}

.desc-text {
  margin: 3px 0 0;
  color: #cbd5e1;
  font-size: 11.5px;
  line-height: 1.5;
}

.replay-analysis {
  padding: 6px 8px;
  background-color: rgba(15, 23, 42, 0.6);
  border: 1px solid rgba(100, 116, 139, 0.3);
  border-radius: 4px;
}

.analysis-title {
  color: #94a3b8;
  font-size: 11px;
  font-weight: 600;
  margin-bottom: 4px;
}

.analysis-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  color: #cbd5e1;
  font-size: 11px;
  font-family: monospace;
}

.analysis-warning {
  color: #fbbf24;
}

.analysis-note {
  margin: 4px 0 0;
  color: #94a3b8;
  font-size: 11px;
}
</style>
