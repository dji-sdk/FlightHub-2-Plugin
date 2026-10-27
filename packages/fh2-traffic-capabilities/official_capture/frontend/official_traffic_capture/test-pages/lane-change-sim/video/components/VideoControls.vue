<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="video-controls-panel">
    <div class="control-row">
      <div class="control-item upload-item">
        <input
          ref="fileInput"
          type="file"
          accept="video/mp4,video/quicktime,.mp4,.mov"
          class="video-file-input"
          @change="handleFileChange"
        >
        <button class="control-btn upload-btn" :disabled="extracting" @click="openFilePicker">
          {{ extracting ? '提取检测数据中…' : '上传机载 MP4 提取检测数据' }}
        </button>
        <span v-if="uploadedName" class="upload-name" :title="uploadedName">{{ uploadedName }}</span>
      </div>

      <div class="control-item play-buttons">
        <button
          class="control-btn play-pause-btn"
          :class="{ playing: isPlaying }"
          :disabled="!hasVideo"
          @click="togglePlay"
        >
          {{ isPlaying ? '暂停' : '播放' }}
        </button>
        <button class="control-btn" :disabled="!hasVideo" @click="stepBackward">上一帧</button>
        <button class="control-btn" :disabled="!hasVideo" @click="stepForward">下一帧</button>
        <button class="control-btn btn-reset" :disabled="!hasVideo" @click="reset">重置</button>
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

      <label class="control-item filter-toggle">
        <input v-model="showFiltered" type="checkbox">
        显示被过滤目标
      </label>
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
          :disabled="!hasVideo"
          @input="handleSliderInput"
        >
      </div>
      <span class="time-label">{{ formatTime(duration) }}</span>
    </div>

    <p v-if="extractError" class="extract-error">{{ extractError }}</p>

    <div v-if="replayAnalysis" class="replay-analysis">
      <div class="analysis-title">
        检测数据摘要
        <span v-if="videoInfoText" class="analysis-video">{{ videoInfoText }}</span>
      </div>
      <div class="analysis-grid">
        <span v-if="replayAnalysis.sourcePackets !== undefined">packets {{ replayAnalysis.sourcePackets }}</span>
        <span>AI frames {{ replayAnalysis.frames }}</span>
        <span>detector {{ replayAnalysis.avgFps.toFixed(1) }} fps</span>
        <span>interval p50 {{ Math.round(replayAnalysis.frameIntervalP50Ms) }}ms</span>
        <span>p95 {{ Math.round(replayAnalysis.frameIntervalP95Ms) }}ms</span>
        <span>targets {{ Math.round(replayAnalysis.targetCountAvg) }} avg</span>
        <span>ids {{ replayAnalysis.uniqueIds }}</span>
        <span>valid {{ replayAnalysis.validCarCountAvg.toFixed(1) }} avg</span>
        <span>short {{ replayAnalysis.shortLivedIds }} / {{ (replayAnalysis.shortLivedIdRatio * 100).toFixed(1) }}%</span>
      </div>
      <p v-for="note in replayAnalysis.notes" :key="note" class="analysis-note">{{ note }}</p>
      <p v-if="validTargetsZero" class="analysis-note warning">
        录制中没有任何目标通过生产过滤（type=3 且可跟踪状态）；可勾选「显示被过滤目标」诊断真实 type/state 取值。
      </p>
    </div>
  </div>
</template>

<script lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { computed, defineComponent, onUnmounted, ref, watch, type PropType } from 'vue'
import type { SimRunner } from '../../sim/runner'
import {
  createReplayScenario,
  parseLaneChangeReplayNdjson,
  ReplayFrameSource,
} from '../../sim/replay-source'
import { analyzeLaneChangeReplay, type ReplayAnalysisSummary } from '../../sim/replay-analysis'
import { SIM_EXTRACT_ENDPOINT } from '../../sim/djmd/endpoint'

/**
 * 真机录像验证控制条：上传 MP4 → dev 中间件提取 djmd → 加载回放场景。
 *
 * 上传的文件本体通过 objectURL 直接喂给 <video>（VideoCanvas），
 * 检测 bbox 走 /sim-api/extract 返回的 NDJSON。
 */
export default defineComponent({
  name: 'VideoControls',
  props: {
    runner: {
      type: Object as PropType<SimRunner>,
      required: true,
    },
  },
  setup (props) {
    const fileInput = ref<HTMLInputElement | null>(null)
    const extracting = ref(false)
    const extractError = ref('')
    const uploadedName = ref('')
    const replayAnalysis = ref<ReplayAnalysisSummary | null>(null)
    let currentObjectUrl: string | null = null

    const isPlaying = computed(() => props.runner.clock.running)
    const playbackRate = computed(() => props.runner.clock.playbackRate)
    const virtualNow = computed(() => props.runner.clock.virtualNow)
    const hasVideo = computed(() => props.runner.scenario.value?.video !== undefined)
    const duration = computed(() => props.runner.scenario.value?.duration ?? 3000)
    const showFiltered = computed({
      get: () => props.runner.showFilteredTargets.value,
      set: (value: boolean) => {
        props.runner.showFilteredTargets.value = value
      },
    })

    const videoInfoText = computed(() => {
      const video = props.runner.scenario.value?.video
      if (!video) return ''
      const fps = video.fps !== undefined ? ` · ${video.fps.toFixed(2)}fps` : ''
      return `${video.width}×${video.height}${fps}`
    })

    const validTargetsZero = computed(() =>
      replayAnalysis.value !== null && replayAnalysis.value.validCarCountAvg === 0,
    )

    const revokeObjectUrl = () => {
      if (currentObjectUrl !== null) {
        URL.revokeObjectURL(currentObjectUrl)
        currentObjectUrl = null
      }
    }

    const loadExtractedReplay = (fileName: string, ndjson: string, videoUrl: string) => {
      const replay = parseLaneChangeReplayNdjson(ndjson)
      if (replay.frames.length === 0) {
        throw new Error('提取结果没有检测帧，无法回放')
      }
      const scenario = createReplayScenario(fileName, replay, {
        id: `djmd-${Date.now()}`,
        name: `真机录像·${fileName}`,
        videoUrl,
      })
      replayAnalysis.value = analyzeLaneChangeReplay(replay)
      props.runner.loadFrameSourceScenario(scenario, new ReplayFrameSource(replay))
    }

    const uploadVideo = async (file: File) => {
      if (extracting.value) return
      extracting.value = true
      extractError.value = ''
      let nextUrl: string | null = null
      try {
        const response = await fetch(SIM_EXTRACT_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: file,
        })
        if (!response.ok) {
          const detail = await response.json().catch(() => null) as { error?: string } | null
          throw new Error(detail?.error ?? `提取失败: HTTP ${response.status}`)
        }
        const ndjson = await response.text()
        nextUrl = URL.createObjectURL(file)
        loadExtractedReplay(file.name, ndjson, nextUrl)
        revokeObjectUrl()
        currentObjectUrl = nextUrl
        nextUrl = null
        uploadedName.value = `${file.name}（${(file.size / 1024 / 1024).toFixed(1)}MB）`
      } catch (error) {
        if (nextUrl !== null) URL.revokeObjectURL(nextUrl)
        extractError.value = error instanceof Error ? error.message : String(error)
      } finally {
        extracting.value = false
      }
    }

    const openFilePicker = () => {
      fileInput.value?.click()
    }

    /** 画布拖拽上传入口（父组件转发）。 */
    const uploadDroppedFile = (file: File) => {
      void uploadVideo(file)
    }

    const handleFileChange = (e: Event) => {
      const input = e.target as HTMLInputElement
      const file = input.files?.[0]
      if (file) void uploadVideo(file)
      input.value = ''
    }

    const togglePlay = () => {
      if (props.runner.clock.running) {
        props.runner.pause()
      } else {
        props.runner.play()
      }
    }

    const stepForward = () => props.runner.stepForward()
    const stepBackward = () => props.runner.stepBackward()
    const reset = () => props.runner.reset()

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

    const formatTime = (ms: number) => `${(ms / 1000).toFixed(2)}s`

    watch(() => props.runner.scenario.value, (scenario) => {
      if (!scenario) {
        replayAnalysis.value = null
        uploadedName.value = ''
        revokeObjectUrl()
      }
    })

    onUnmounted(revokeObjectUrl)

    return {
      fileInput,
      extracting,
      extractError,
      uploadedName,
      replayAnalysis,
      isPlaying,
      playbackRate,
      virtualNow,
      hasVideo,
      duration,
      showFiltered,
      videoInfoText,
      validTargetsZero,
      openFilePicker,
      uploadDroppedFile,
      handleFileChange,
      togglePlay,
      stepForward,
      stepBackward,
      reset,
      handleRateChange,
      handleSliderInput,
      formatTime,
    }
  },
})
</script>

<style scoped>
.video-controls-panel {
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

.control-btn:hover:not(:disabled) {
  background-color: #2d3f59;
  color: #fff;
}

.control-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.upload-btn {
  border-color: rgba(56, 189, 248, 0.5);
  color: #7dd3fc;
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

.upload-item {
  position: relative;
}

.video-file-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.upload-name {
  color: #94a3b8;
  font-size: 11px;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.filter-toggle {
  color: #94a3b8;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

.filter-toggle input {
  accent-color: #3b82f6;
  cursor: pointer;
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

.slider-wrapper input[type="range"]:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.extract-error {
  margin: 0;
  color: #fca5a5;
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
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.analysis-video {
  color: #7dd3fc;
  font-weight: 400;
  font-family: monospace;
}

.analysis-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  color: #cbd5e1;
  font-size: 11px;
  font-family: monospace;
}

.analysis-note {
  margin: 4px 0 0;
  color: #94a3b8;
  font-size: 11px;
}

.analysis-note.warning {
  color: #fbbf24;
}
</style>
