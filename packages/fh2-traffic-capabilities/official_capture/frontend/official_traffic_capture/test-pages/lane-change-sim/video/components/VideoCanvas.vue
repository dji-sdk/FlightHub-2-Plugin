<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="video-canvas-container">
    <div class="canvas-wrapper" ref="wrapperRef" @dragover.prevent @drop.prevent="handleDrop">
      <video
        ref="videoRef"
        class="background-video"
        :src="videoUrl ?? undefined"
        muted
        playsinline
        preload="auto"
        @loadedmetadata="handleVideoLoaded"
        @error="videoState = 'error'"
      ></video>

      <canvas
        ref="canvasRef"
        @mousedown="handleMouseDown"
        @mousemove="handleMouseMove"
      ></canvas>

      <div v-if="!videoUrl" class="placeholder-tip">
        <p>尚未加载真机录像</p>
        <p class="placeholder-sub">使用下方控制条上传 DJI 机载 MP4，或将文件拖入此处</p>
      </div>
      <div v-else-if="videoState === 'loading'" class="placeholder-tip">
        <p>视频加载中…</p>
      </div>
      <div v-else-if="videoState === 'error'" class="placeholder-tip error">
        <p>视频加载失败：浏览器无法解码该文件</p>
        <p class="placeholder-sub">可先转码为 H.264 MP4 后重试</p>
      </div>

      <div v-if="addingMode" class="drawing-tip">
        <div class="drawing-info-header">
          <span class="pulse-dot"></span>
          <h4>正在绘制 {{ addingMode === 'line' ? '实线 (LINE)' : '导流线 (POLYGON)' }}</h4>
        </div>
        <p class="points-stats">已有点数: <strong>{{ currentPoints.length }}</strong></p>
        <div class="shortcuts-guide">
          <span>快捷键：</span>
          <ul>
            <li>回车 (Enter): 完成并保存</li>
            <li>退格 (Backspace): 撤销上一个点</li>
            <li>ESC: 取消绘制</li>
          </ul>
        </div>
        <div class="drawing-actions">
          <button
            class="btn btn-primary"
            :disabled="currentPoints.length < (addingMode === 'line' ? 2 : 3)"
            @click="finishDrawing"
          >
            完成 (Done)
          </button>
          <button class="btn btn-danger" @click="cancelDrawing">
            取消 (Cancel)
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { computed, defineComponent, onMounted, onUnmounted, ref, watch, type PropType } from 'vue'
import type { SimRunner } from '../../sim/runner'
import type { Point2D } from '../../../../src/hosts/cockpit/lane-change/detector-core'
import { canvasToVideoNorm, computeLetterbox, videoToCanvasNorm, type VideoLayout } from '../../sim/video-layout'

/**
 * 真机录像验证画布：`<video>` object-fit: contain 背景叠加 canvas 标注层。
 *
 * 区域与 bbox 的坐标都是视频画面归一化空间（与 djmd 万分比一致）；
 * 绘制与鼠标交互经 letterbox 映射互转，黑边区域点击无效。
 * 视频播放由 SimClock 驱动（漂移超阈值再校正），判定数据不受视频解码影响。
 */
export default defineComponent({
  name: 'VideoCanvas',
  props: {
    runner: {
      type: Object as PropType<SimRunner>,
      required: true,
    },
    addingMode: {
      type: String as PropType<'line' | 'polygon' | null>,
      default: null,
    },
  },
  emits: ['draw-finished', 'draw-cancelled', 'video-dropped'],
  setup (props, { emit }) {
    const canvasRef = ref<HTMLCanvasElement | null>(null)
    const wrapperRef = ref<HTMLDivElement | null>(null)
    const videoRef = ref<HTMLVideoElement | null>(null)
    const currentPoints = ref<Point2D[]>([])
    const hoverPoint = ref<Point2D | null>(null)
    const videoState = ref<'loading' | 'ready' | 'error'>('loading')

    const videoUrl = computed(() => props.runner.scenario.value?.video?.url ?? null)
    const videoSize = computed(() => {
      const video = props.runner.scenario.value?.video
      return video ? { w: video.width, h: video.height } : null
    })

    /** letterbox 上下文；视频元信息未就绪时退化为铺满画布。 */
    const layoutOf = (): VideoLayout | null => {
      const canvas = canvasRef.value
      if (!canvas) return null
      const size = videoSize.value
      if (!size) return computeLetterbox(canvas.width, canvas.height, canvas.width, canvas.height)
      return computeLetterbox(canvas.width, canvas.height, size.w, size.h)
    }

    const videoToPx = (x: number, y: number, layout: VideoLayout) => {
      const p = videoToCanvasNorm(x, y, layout)
      return { x: p.x * layout.canvasW, y: p.y * layout.canvasH }
    }

    // === 视频元素与虚拟时钟同步 ===

    const VIDEO_SYNC_THRESHOLD_MS = 250
    /** Chrome playbackRate 上限 16；超出时视频降速播放，detector 判定不受影响。 */
    const MAX_VIDEO_RATE = 16

    const syncVideoToClock = () => {
      const video = videoRef.value
      if (!video || !videoUrl.value || videoState.value !== 'ready') return
      const targetSec = props.runner.clock.virtualNow / 1000
      const syncThresholdMs = props.runner.clock.running ? VIDEO_SYNC_THRESHOLD_MS : 1
      if (Math.abs(video.currentTime - targetSec) * 1000 > syncThresholdMs) {
        video.currentTime = Math.max(0, Math.min(targetSec, video.duration || targetSec))
      }
      const rate = Math.min(props.runner.clock.playbackRate, MAX_VIDEO_RATE)
      if (video.playbackRate !== rate) video.playbackRate = rate
      if (props.runner.clock.running && video.paused) {
        void video.play().catch(() => {})
      } else if (!props.runner.clock.running && !video.paused) {
        video.pause()
      }
    }

    let syncRAF: number | null = null
    const syncLoop = () => {
      syncVideoToClock()
      syncRAF = requestAnimationFrame(syncLoop)
    }

    watch(videoUrl, (url) => {
      videoState.value = 'loading'
      if (url) props.runner.pause()
    })

    // === 标注层绘制 ===

    const drawPolygonPath = (
      ctx: CanvasRenderingContext2D,
      points: readonly Point2D[],
      layout: VideoLayout,
    ) => {
      if (points.length === 0) return
      const first = videoToPx(points[0]!.x, points[0]!.y, layout)
      ctx.beginPath()
      ctx.moveTo(first.x, first.y)
      for (let i = 1; i < points.length; i++) {
        const p = videoToPx(points[i]!.x, points[i]!.y, layout)
        ctx.lineTo(p.x, p.y)
      }
      ctx.closePath()
    }

    const draw = () => {
      const canvas = canvasRef.value
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return

      const w = canvas.width
      const h = canvas.height
      ctx.clearRect(0, 0, w, h)

      const layout = layoutOf()
      if (!layout) return

      const regions = props.runner.activeRegions
      const bboxes = props.runner.currentBBoxes.value
      const showRaw = props.runner.showFilteredTargets.value
      const rawTargets = showRaw ? props.runner.currentRawTargets.value : []
      const bboxObjIds = new Set(bboxes.map(bbox => String(bbox.objId)))

      for (const region of regions) {
        if (region.points.length < 2) continue
        ctx.lineWidth = Math.max(2.5, w * 0.0025)
        if (region.kind === 'line') {
          ctx.strokeStyle = '#38bdf8'
          const first = videoToPx(region.points[0]!.x, region.points[0]!.y, layout)
          ctx.beginPath()
          ctx.moveTo(first.x, first.y)
          for (let i = 1; i < region.points.length; i++) {
            const p = videoToPx(region.points[i]!.x, region.points[i]!.y, layout)
            ctx.lineTo(p.x, p.y)
          }
          ctx.stroke()
        } else {
          ctx.strokeStyle = '#facc15'
          ctx.fillStyle = 'rgba(250, 204, 21, 0.14)'
          drawPolygonPath(ctx, region.points, layout)
          ctx.fill()
          drawPolygonPath(ctx, region.points, layout)
          ctx.stroke()
        }

        ctx.fillStyle = region.kind === 'line' ? '#38bdf8' : '#facc15'
        for (const p of region.points) {
          const px = videoToPx(p.x, p.y, layout)
          ctx.beginPath()
          ctx.arc(px.x, px.y, 4.5, 0, 2 * Math.PI)
          ctx.fill()
        }
        const first = videoToPx(region.points[0]!.x, region.points[0]!.y, layout)
        ctx.fillStyle = region.kind === 'line' ? '#bae6fd' : '#fef08a'
        ctx.font = 'bold 11px monospace'
        ctx.fillText(region.id, first.x + 8, first.y - 5)
      }

      if (showRaw) {
        for (const target of rawTargets) {
          if (bboxObjIds.has(String(target.targetId))) continue
          const p1 = videoToPx(target.bbox.x, target.bbox.y, layout)
          const p2 = videoToPx(
            target.bbox.x + target.bbox.width,
            target.bbox.y + target.bbox.height,
            layout,
          )
          ctx.save()
          ctx.setLineDash([6, 4])
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)'
          ctx.lineWidth = 1.5
          ctx.strokeRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y)
          ctx.restore()
          ctx.fillStyle = 'rgba(148, 163, 184, 0.85)'
          ctx.font = '10px monospace'
          ctx.fillText(
            `#${target.targetId} type=${target.type} state=${target.state}`,
            p1.x + 3,
            p1.y + 12,
          )
        }
      }

      const blinkOn = Math.floor(performance.now() / 500) % 2 === 0
      for (const bbox of bboxes) {
        const p1 = videoToPx(bbox.rect.x1, bbox.rect.y1, layout)
        const p2 = videoToPx(bbox.rect.x2, bbox.rect.y2, layout)
        const bw = p2.x - p1.x
        const bh = p2.y - p1.y

        let color = 'rgba(148, 163, 184, 0.18)'
        let borderStyle = 'rgba(148, 163, 184, 0.7)'
        let borderThickness = 1.5

        if (props.runner.isTriggered(bbox.objId)) {
          if (blinkOn) {
            color = 'rgba(239, 68, 68, 0.4)'
            borderStyle = '#ef4444'
            borderThickness = 3
          } else {
            color = 'rgba(239, 68, 68, 0.18)'
            borderStyle = 'rgba(239, 68, 68, 0.6)'
            borderThickness = 2
          }
        }

        ctx.fillStyle = color
        ctx.strokeStyle = borderStyle
        ctx.lineWidth = borderThickness
        ctx.fillRect(p1.x, p1.y, bw, bh)
        ctx.strokeRect(p1.x, p1.y, bw, bh)

        ctx.fillStyle = '#fff'
        ctx.font = 'bold 11px sans-serif'
        ctx.fillText(`ID: ${bbox.objId}`, p1.x + 4, p1.y + 14)
      }

      if (props.addingMode && currentPoints.value.length > 0) {
        ctx.lineWidth = 2
        ctx.strokeStyle = '#FFd700'
        ctx.fillStyle = 'rgba(255, 215, 0, 0.1)'

        ctx.beginPath()
        const first = videoToPx(currentPoints.value[0]!.x, currentPoints.value[0]!.y, layout)
        ctx.moveTo(first.x, first.y)
        for (let i = 1; i < currentPoints.value.length; i++) {
          const p = videoToPx(currentPoints.value[i]!.x, currentPoints.value[i]!.y, layout)
          ctx.lineTo(p.x, p.y)
        }
        if (hoverPoint.value) {
          const hp = videoToPx(hoverPoint.value.x, hoverPoint.value.y, layout)
          ctx.lineTo(hp.x, hp.y)
        }
        if (props.addingMode === 'polygon' && currentPoints.value.length >= 2) {
          ctx.closePath()
          ctx.fill()
        }
        ctx.stroke()

        for (const p of currentPoints.value) {
          const px = videoToPx(p.x, p.y, layout)
          ctx.beginPath()
          ctx.fillStyle = '#FFd700'
          ctx.arc(px.x, px.y, 5, 0, 2 * Math.PI)
          ctx.fill()
        }
        if (hoverPoint.value) {
          const hp = videoToPx(hoverPoint.value.x, hoverPoint.value.y, layout)
          ctx.beginPath()
          ctx.strokeStyle = '#ff9100'
          ctx.arc(hp.x, hp.y, 8, 0, 2 * Math.PI)
          ctx.stroke()
        }
      }
    }

    // === 交互 ===

    const eventToVideoNorm = (e: MouseEvent): Point2D | null => {
      const canvas = canvasRef.value
      const layout = layoutOf()
      if (!canvas || !layout) return null
      const rect = canvas.getBoundingClientRect()
      const x = e.offsetX / rect.width
      const y = e.offsetY / rect.height
      return canvasToVideoNorm(x, y, layout)
    }

    const handleMouseDown = (e: MouseEvent) => {
      if (!props.addingMode) return
      const point = eventToVideoNorm(e)
      if (!point) return

      if (props.addingMode === 'polygon' && currentPoints.value.length >= 3) {
        const first = currentPoints.value[0]!
        const dist = Math.sqrt((point.x - first.x) ** 2 + (point.y - first.y) ** 2)
        if (dist < 0.02) {
          finishDrawing()
          return
        }
      }

      currentPoints.value.push(point)
      draw()
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (!props.addingMode) return
      hoverPoint.value = eventToVideoNorm(e)
      draw()
    }

    const handleDrop = (e: DragEvent) => {
      const file = e.dataTransfer?.files?.[0]
      if (file) emit('video-dropped', file)
    }

    const cancelDrawing = () => {
      currentPoints.value = []
      hoverPoint.value = null
      emit('draw-cancelled')
      draw()
    }

    const finishDrawing = () => {
      const minPoints = props.addingMode === 'line' ? 2 : 3
      if (currentPoints.value.length < minPoints) return
      emit('draw-finished', [...currentPoints.value])
      currentPoints.value = []
      hoverPoint.value = null
      draw()
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!props.addingMode) return
      if (e.key === 'Escape') {
        cancelDrawing()
      } else if (e.key === 'Enter') {
        const minPoints = props.addingMode === 'line' ? 2 : 3
        if (currentPoints.value.length >= minPoints) {
          finishDrawing()
        }
      } else if (e.key === 'Backspace') {
        currentPoints.value.pop()
        draw()
      }
    }

    const handleVideoLoaded = () => {
      videoState.value = 'ready'
      syncVideoToClock()
      draw()
    }

    const resizeCanvas = () => {
      const canvas = canvasRef.value
      const wrapper = wrapperRef.value
      if (!canvas || !wrapper) return
      const rect = wrapper.getBoundingClientRect()
      // tab 处于 display:none 时 rect 为 0×0，不把画布重置成 1×1
      if (rect.width < 1 || rect.height < 1) return
      canvas.width = Math.max(1, Math.round(rect.width))
      canvas.height = Math.max(1, Math.round(rect.height))
      draw()
    }

    // v-show 隐藏挂载与 tab 切换不触发 window resize，用 ResizeObserver 跟踪可见性/尺寸变化
    let resizeObserver: ResizeObserver | null = null

    onMounted(() => {
      resizeCanvas()
      resizeObserver = new ResizeObserver(() => resizeCanvas())
      if (wrapperRef.value) resizeObserver.observe(wrapperRef.value)
      window.addEventListener('resize', resizeCanvas)
      window.addEventListener('keydown', handleKeyDown)
      syncRAF = requestAnimationFrame(syncLoop)
    })

    onUnmounted(() => {
      resizeObserver?.disconnect()
      resizeObserver = null
      window.removeEventListener('resize', resizeCanvas)
      window.removeEventListener('keydown', handleKeyDown)
      if (syncRAF !== null) cancelAnimationFrame(syncRAF)
    })

    watch(
      () => [
        props.runner.currentBBoxes.value,
        props.runner.currentRawTargets.value,
        props.runner.showFilteredTargets.value,
        props.runner.clock.virtualNow,
        props.runner.activeRegions,
      ],
      () => draw(),
      { deep: true },
    )

    return {
      canvasRef,
      wrapperRef,
      videoRef,
      videoUrl,
      videoState,
      currentPoints,
      handleMouseDown,
      handleMouseMove,
      handleDrop,
      handleVideoLoaded,
      cancelDrawing,
      finishDrawing,
    }
  },
})
</script>

<style scoped>
.video-canvas-container {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  background-color: #0b0f17;
  overflow: hidden;
}

.canvas-wrapper {
  position: absolute;
  inset: 0;
  background-color: #0b0f17;
}

.background-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #0b0f17;
}

.canvas-wrapper canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  cursor: crosshair;
}

.placeholder-tip {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: #64748b;
  text-align: center;
  pointer-events: none;
}

.placeholder-tip p {
  margin: 0 0 6px;
  font-size: 14px;
}

.placeholder-tip .placeholder-sub {
  font-size: 12px;
  color: #475569;
}

.placeholder-tip.error p {
  color: #fca5a5;
}

.drawing-tip {
  position: absolute;
  bottom: 12px;
  right: 12px;
  background-color: rgba(15, 23, 42, 0.95);
  color: #f1f5f9;
  padding: 12px;
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12px;
  border: 1px solid #334155;
  pointer-events: auto;
  width: 220px;
  box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4);
  z-index: 300;
}

.drawing-info-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.drawing-info-header h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: #38bdf8;
}

.pulse-dot {
  width: 8px;
  height: 8px;
  background-color: #f97316;
  border-radius: 50%;
  animation: video-pulse 1.2s infinite;
}

@keyframes video-pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(249, 115, 22, 0.7);
  }
  70% {
    box-shadow: 0 0 0 6px rgba(249, 115, 22, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(249, 115, 22, 0);
  }
}

.points-stats {
  margin: 0;
  font-size: 12px;
  color: #94a3b8;
}

.points-stats strong {
  color: #00e676;
  font-size: 14px;
}

.shortcuts-guide {
  font-size: 11px;
  color: #64748b;
  border-top: 1px solid #1e293b;
  padding-top: 8px;
}

.shortcuts-guide span {
  display: block;
  font-weight: 500;
  margin-bottom: 4px;
}

.shortcuts-guide ul {
  margin: 0;
  padding-left: 12px;
}

.shortcuts-guide li {
  list-style-type: square;
  margin-bottom: 2px;
}

.drawing-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.drawing-actions .btn {
  flex: 1;
  border: none;
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}

.drawing-actions .btn-primary {
  background-color: #10b981;
  color: #fff;
}

.drawing-actions .btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.drawing-actions .btn-danger {
  background-color: #ef4444;
  color: #fff;
}
</style>
