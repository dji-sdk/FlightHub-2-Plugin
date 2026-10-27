<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="sim-canvas-container">
    <div class="canvas-wrapper" ref="wrapperRef">
      <canvas
        ref="canvasRef"
        @mousedown="handleMouseDown"
        @mousemove="handleMouseMove"
      ></canvas>

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
import { defineComponent, onMounted, onUnmounted, ref, watch, type PropType } from 'vue'
import type { SimRunner } from '../sim/runner'
import type { Point2D } from '../../../src/hosts/cockpit/lane-change/detector-core'

export default defineComponent({
  name: 'SimCanvas',
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
  emits: ['draw-finished', 'draw-cancelled'],
  setup (props, { emit }) {
    const canvasRef = ref<HTMLCanvasElement | null>(null)
    const wrapperRef = ref<HTMLDivElement | null>(null)
    const currentPoints = ref<Point2D[]>([])
    const hoverPoint = ref<Point2D | null>(null)
    const lastBlinkState = ref(true)

    let blinkInterval: ReturnType<typeof setInterval> | null = null
    let resizeObserver: ResizeObserver | null = null

    const roadTopY = 0
    const roadBottomY = 1
    const pavementLeftTopX = 0.02
    const pavementLeftBottomX = -0.04
    const pavementRightTopX = 0.98
    const pavementRightBottomX = 1.04
    const roadLeftEdgeTopX = 0.290
    const roadLeftEdgeBottomX = 0.110
    const roadRightEdgeTopX = 0.710
    const roadRightEdgeBottomX = 0.920
    const laneMarks = [
      { topX: 0.405, bottomX: 0.285, color: 'rgba(236, 240, 219, 0.45)', dash: true },
      { topX: 0.500, bottomX: 0.515, color: 'rgba(246, 196, 83, 0.72)', dash: false },
      { topX: 0.595, bottomX: 0.725, color: 'rgba(236, 240, 219, 0.45)', dash: true },
    ]

    const roadXAtY = (topX: number, bottomX: number, yNorm: number) => {
      const ratio = Math.max(0, Math.min(1, (yNorm - roadTopY) / (roadBottomY - roadTopY)))
      return topX + (bottomX - topX) * ratio
    }

    const drawPerspectiveLine = (
      ctx: CanvasRenderingContext2D,
      w: number,
      h: number,
      topX: number,
      bottomX: number,
      color: string,
      dashed: boolean,
    ) => {
      ctx.save()
      ctx.strokeStyle = color
      ctx.lineCap = 'round'
      if (!dashed) {
        ctx.lineWidth = Math.max(2, w * 0.0022)
        ctx.beginPath()
        ctx.moveTo(topX * w, roadTopY * h)
        ctx.lineTo(bottomX * w, roadBottomY * h)
        ctx.stroke()
        ctx.restore()
        return
      }

      const dashCount = 15
      for (let i = 0; i < dashCount; i++) {
        const t0 = i / dashCount
        const t1 = Math.min(1, t0 + 0.030 + t0 * 0.030)
        const y0 = roadTopY + (roadBottomY - roadTopY) * t0
        const y1 = roadTopY + (roadBottomY - roadTopY) * t1
        ctx.globalAlpha = 0.45 + 0.45 * t0
        ctx.lineWidth = 1 + 3 * t0
        ctx.beginPath()
        ctx.moveTo(roadXAtY(topX, bottomX, y0) * w, y0 * h)
        ctx.lineTo(roadXAtY(topX, bottomX, y1) * w, y1 * h)
        ctx.stroke()
      }
      ctx.restore()
    }

    const drawPolygonPath = (
      ctx: CanvasRenderingContext2D,
      points: readonly Point2D[],
      w: number,
      h: number,
    ) => {
      if (points.length === 0) return
      ctx.beginPath()
      ctx.moveTo(points[0]!.x * w, points[0]!.y * h)
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i]!.x * w, points[i]!.y * h)
      }
      ctx.closePath()
    }

    const drawPolygonHatching = (
      ctx: CanvasRenderingContext2D,
      points: readonly Point2D[],
      w: number,
      h: number,
    ) => {
      if (points.length < 3) return
      const minX = Math.min(...points.map(p => p.x)) * w
      const maxX = Math.max(...points.map(p => p.x)) * w
      const minY = Math.min(...points.map(p => p.y)) * h
      const maxY = Math.max(...points.map(p => p.y)) * h
      const span = Math.max(maxX - minX, maxY - minY)

      ctx.save()
      drawPolygonPath(ctx, points, w, h)
      ctx.clip()
      ctx.strokeStyle = 'rgba(255, 232, 128, 0.42)'
      ctx.lineWidth = Math.max(1.5, w * 0.0016)
      for (let x = minX - span; x < maxX + span; x += Math.max(12, w * 0.016)) {
        ctx.beginPath()
        ctx.moveTo(x, maxY + 10)
        ctx.lineTo(x + span, minY - 10)
        ctx.stroke()
      }
      ctx.restore()
      ctx.beginPath()
    }

    const drawRoadScene = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      if (props.runner.scenario.value?.roadLayout === 'diagonal') {
        ctx.fillStyle = '#252a2d'
        ctx.fillRect(0, 0, w, h)
        // 只绘制与斜拍实线同向的道路边缘，避免叠加原来的纵向道路。
        ctx.strokeStyle = '#a0a6a9'
        ctx.lineWidth = 2
        for (const intercept of [0.32, 1.68]) {
          ctx.beginPath()
          ctx.moveTo(0, intercept * h)
          ctx.lineTo(w, (intercept - 1) * h)
          ctx.stroke()
        }
        ctx.fillStyle = '#e2e8f0'
        ctx.font = '12px sans-serif'
        ctx.fillText('单向上行 ↗  ·  橙：右下角上→下  ·  紫：左下角下→上', 12, 60)
        ctx.fillText('虚线为对应下角的完整轨迹，圆点为当前角点', 12, 79)
        return
      }
      const sceneGradient = ctx.createLinearGradient(0, 0, 0, h)
      sceneGradient.addColorStop(0, '#151712')
      sceneGradient.addColorStop(0.48, '#20231f')
      sceneGradient.addColorStop(1, '#11130f')
      ctx.fillStyle = sceneGradient
      ctx.fillRect(0, 0, w, h)

      ctx.fillStyle = '#232620'
      ctx.beginPath()
      ctx.moveTo(pavementLeftTopX * w, roadTopY * h)
      ctx.lineTo(pavementRightTopX * w, roadTopY * h)
      ctx.lineTo(pavementRightBottomX * w, roadBottomY * h)
      ctx.lineTo(pavementLeftBottomX * w, roadBottomY * h)
      ctx.closePath()
      ctx.fill()

      ctx.fillStyle = '#1c1f1a'
      ctx.beginPath()
      ctx.moveTo(pavementLeftTopX * w, roadTopY * h)
      ctx.lineTo(roadLeftEdgeTopX * w, roadTopY * h)
      ctx.lineTo(roadLeftEdgeBottomX * w, roadBottomY * h)
      ctx.lineTo(pavementLeftBottomX * w, roadBottomY * h)
      ctx.closePath()
      ctx.fill()

      ctx.beginPath()
      ctx.moveTo(roadRightEdgeTopX * w, roadTopY * h)
      ctx.lineTo(pavementRightTopX * w, roadTopY * h)
      ctx.lineTo(pavementRightBottomX * w, roadBottomY * h)
      ctx.lineTo(roadRightEdgeBottomX * w, roadBottomY * h)
      ctx.closePath()
      ctx.fill()

      ctx.fillStyle = '#2c2e2a'
      ctx.beginPath()
      ctx.moveTo(roadLeftEdgeTopX * w, roadTopY * h)
      ctx.lineTo(roadRightEdgeTopX * w, roadTopY * h)
      ctx.lineTo(roadRightEdgeBottomX * w, roadBottomY * h)
      ctx.lineTo(roadLeftEdgeBottomX * w, roadBottomY * h)
      ctx.closePath()
      ctx.fill()

      const roadGradient = ctx.createLinearGradient(0, roadTopY * h, 0, roadBottomY * h)
      roadGradient.addColorStop(0, 'rgba(255, 255, 255, 0.02)')
      roadGradient.addColorStop(1, 'rgba(255, 255, 255, 0.10)')
      ctx.fillStyle = roadGradient
      ctx.fill()

      drawPerspectiveLine(ctx, w, h, roadLeftEdgeTopX, roadLeftEdgeBottomX, 'rgba(238, 239, 224, 0.78)', false)
      drawPerspectiveLine(ctx, w, h, roadRightEdgeTopX, roadRightEdgeBottomX, 'rgba(238, 239, 224, 0.78)', false)
      laneMarks.forEach(mark => drawPerspectiveLine(ctx, w, h, mark.topX, mark.bottomX, mark.color, mark.dash))

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)'
      ctx.lineWidth = 1
      for (let i = 1; i < 7; i++) {
        const yNorm = roadTopY + (roadBottomY - roadTopY) * (i / 7)
        ctx.beginPath()
        ctx.moveTo(roadXAtY(roadLeftEdgeTopX, roadLeftEdgeBottomX, yNorm) * w, yNorm * h)
        ctx.lineTo(roadXAtY(roadRightEdgeTopX, roadRightEdgeBottomX, yNorm) * w, yNorm * h)
        ctx.stroke()
      }
    }

    const getViewport = (width: number, height: number) => {
      if (props.runner.scenario.value?.roadLayout !== 'diagonal') return { x: 0, y: 0, width, height }
      const size = Math.min(width, height)
      return { x: (width - size) / 2, y: (height - size) / 2, width: size, height: size }
    }

    const pointerPoint = (e: MouseEvent): Point2D | null => {
      const rect = canvasRef.value!.getBoundingClientRect()
      const viewport = getViewport(rect.width, rect.height)
      const x = (e.offsetX - viewport.x) / viewport.width
      const y = (e.offsetY - viewport.y) / viewport.height
      return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null
    }

    const handleMouseDown = (e: MouseEvent) => {
      if (!props.addingMode || !canvasRef.value) return
      const point = pointerPoint(e)
      if (!point) return
      const { x, y } = point

      if (props.addingMode === 'polygon' && currentPoints.value.length >= 3) {
        const first = currentPoints.value[0]!
        const dist = Math.sqrt((x - first.x) ** 2 + (y - first.y) ** 2)
        if (dist < 0.02) {
          finishDrawing()
          return
        }
      }

      currentPoints.value.push({ x, y })

      draw()
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (!props.addingMode || !canvasRef.value) return
      hoverPoint.value = pointerPoint(e)
      draw()
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

    const resizeCanvas = () => {
      const canvas = canvasRef.value
      const wrapper = wrapperRef.value
      if (!canvas || !wrapper) return
      const rect = wrapper.getBoundingClientRect()
      canvas.width = Math.max(1, Math.round(rect.width))
      canvas.height = Math.max(1, Math.round(rect.height))
      draw()
    }

    const draw = () => {
      const canvas = canvasRef.value
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const viewport = getViewport(canvas.width, canvas.height)
      const w = viewport.width
      const h = viewport.height

      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.save()
      ctx.translate(viewport.x, viewport.y)
      ctx.beginPath()
      ctx.rect(0, 0, w, h)
      ctx.clip()
      drawRoadScene(ctx, w, h)

      const activeRegions = props.runner.activeRegions
      const bboxes = props.runner.currentBBoxes.value

      activeRegions.forEach((region) => {
        if (region.kind !== 'line' && region.kind !== 'polygon') return
        if (!region.valid || region.points.length < 2) return
        ctx.lineWidth = Math.max(2.5, w * 0.0025)

        if (region.kind === 'line') {
          ctx.strokeStyle = '#38bdf8'
          ctx.beginPath()
          ctx.moveTo(region.points[0]!.x * w, region.points[0]!.y * h)
          for (let i = 1; i < region.points.length; i++) {
            ctx.lineTo(region.points[i]!.x * w, region.points[i]!.y * h)
          }
          ctx.stroke()
        } else {
          ctx.strokeStyle = '#facc15'
          ctx.fillStyle = 'rgba(250, 204, 21, 0.14)'
          drawPolygonPath(ctx, region.points, w, h)
          ctx.fill()
          drawPolygonHatching(ctx, region.points, w, h)
          drawPolygonPath(ctx, region.points, w, h)
          ctx.stroke()
        }

        ctx.fillStyle = region.kind === 'line' ? '#38bdf8' : '#facc15'
        region.points.forEach((p) => {
          ctx.beginPath()
          ctx.arc(p.x * w, p.y * h, 4.5, 0, 2 * Math.PI)
          ctx.fill()
        })

        ctx.fillStyle = region.kind === 'line' ? '#bae6fd' : '#fef08a'
        ctx.font = 'bold 11px monospace'
        ctx.fillText(region.id, region.points[0]!.x * w + 8, region.points[0]!.y * h - 5)
      })

      if (props.addingMode && currentPoints.value.length > 0) {
        ctx.lineWidth = 2
        ctx.strokeStyle = '#FFd700'
        ctx.fillStyle = 'rgba(255, 215, 0, 0.1)'

        ctx.beginPath()
        ctx.moveTo(currentPoints.value[0]!.x * w, currentPoints.value[0]!.y * h)
        for (let i = 1; i < currentPoints.value.length; i++) {
          ctx.lineTo(currentPoints.value[i]!.x * w, currentPoints.value[i]!.y * h)
        }

        if (hoverPoint.value) {
          ctx.lineTo(hoverPoint.value.x * w, hoverPoint.value.y * h)
        }

        if (props.addingMode === 'polygon' && currentPoints.value.length >= 2) {
          ctx.closePath()
          ctx.fill()
        }
        ctx.stroke()

        currentPoints.value.forEach((p, idx) => {
          const isLast = idx === currentPoints.value.length - 1
          ctx.beginPath()
          if (isLast) {
            const radius = 6 + 3.5 * Math.sin(performance.now() / 150)
            ctx.fillStyle = '#ff9100'
            ctx.arc(p.x * w, p.y * h, radius, 0, 2 * Math.PI)
          } else {
            ctx.fillStyle = '#FFd700'
            ctx.arc(p.x * w, p.y * h, 5, 0, 2 * Math.PI)
          }
          ctx.fill()
        })

        if (hoverPoint.value) {
          ctx.beginPath()
          ctx.strokeStyle = '#ff9100'
          ctx.arc(hoverPoint.value.x * w, hoverPoint.value.y * h, 8, 0, 2 * Math.PI)
          ctx.stroke()
        }
      }

      const tracks = props.runner.scenario.value?.tracks ?? []
      for (const track of tracks) {
        if (!track.laneChange) continue
        const toRight = track.laneChange.direction === 'left-to-right'
        ctx.save()
        ctx.strokeStyle = toRight ? '#fb923c' : '#c084fc'
        ctx.globalAlpha = 0.65
        ctx.setLineDash([4, 5])
        ctx.lineWidth = 1.5
        ctx.beginPath()
        track.keyframes.forEach(({ rect }, index) => {
          const x = (toRight ? rect.x2 : rect.x1) * w
          if (index === 0) ctx.moveTo(x, rect.y2 * h)
          else ctx.lineTo(x, rect.y2 * h)
        })
        ctx.stroke()
        ctx.restore()
      }

      bboxes.forEach((bbox) => {
        const bx1 = bbox.rect.x1 * w
        const by1 = bbox.rect.y1 * h
        const bx2 = bbox.rect.x2 * w
        const by2 = bbox.rect.y2 * h
        const bw = bx2 - bx1
        const bh = by2 - by1

        let color = 'rgba(148, 163, 184, 0.25)'
        let borderStyle = 'rgba(148, 163, 184, 0.7)'
        let borderThickness = 1.5

        if (props.runner.isTriggered(bbox.objId)) {
          if (lastBlinkState.value) {
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
        ctx.fillRect(bx1, by1, bw, bh)
        ctx.strokeRect(bx1, by1, bw, bh)

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(bx1 + bw / 2, by1 + 4)
        ctx.lineTo(bx1 + bw / 2, by2 - 4)
        ctx.stroke()
        ctx.fillStyle = 'rgba(255, 255, 255, 0.35)'
        ctx.fillRect(bx1 + bw * 0.24, by1 + bh * 0.18, bw * 0.52, Math.max(2, bh * 0.08))

        ctx.fillStyle = '#fff'
        ctx.font = 'bold 11px sans-serif'
        ctx.fillText(`ID: ${bbox.objId}`, bx1 + 4, by1 + 14)
        const laneChange = tracks.find(track => track.objId === bbox.objId)?.laneChange
        if (laneChange) {
          const toRight = laneChange.direction === 'left-to-right'
          const x = toRight ? bx2 : bx1
          ctx.fillStyle = toRight ? '#fb923c' : '#c084fc'
          ctx.beginPath()
          ctx.arc(x, by2, 4, 0, Math.PI * 2)
          ctx.fill()
          ctx.font = '11px sans-serif'
          ctx.fillText(toRight ? '右下角 · 左→右' : '左下角 · 右→左', bx1, by2 + 14)
        }
      })
      ctx.restore()
    }

    onMounted(() => {
      resizeCanvas()
      resizeObserver = new ResizeObserver(resizeCanvas)
      if (wrapperRef.value) resizeObserver.observe(wrapperRef.value)
      window.addEventListener('resize', resizeCanvas)
      window.addEventListener('keydown', handleKeyDown)

      blinkInterval = setInterval(() => {
        lastBlinkState.value = !lastBlinkState.value
        draw()
      }, 500)
    })

    onUnmounted(() => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', resizeCanvas)
      window.removeEventListener('keydown', handleKeyDown)
      if (blinkInterval !== null) clearInterval(blinkInterval)
    })

    watch(
      () => [props.runner.currentBBoxes.value, props.runner.clock.virtualNow, props.runner.activeRegions],
      () => {
        draw()
      },
      { deep: true },
    )

    watch(
      () => props.addingMode,
      (next) => {
        if (next === null) {
          currentPoints.value = []
          hoverPoint.value = null
        } else {
          const anim = () => {
            if (props.addingMode) {
              draw()
              requestAnimationFrame(anim)
            }
          }
          requestAnimationFrame(anim)
        }
      },
    )

    return {
      canvasRef,
      wrapperRef,
      currentPoints,
      cancelDrawing,
      finishDrawing,
      handleMouseDown,
      handleMouseMove,
    }
  },
})
</script>

<style scoped>
.sim-canvas-container {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  background-color: #0b0f17;
  overflow: hidden;
  border: none;
  box-sizing: border-box;
}

.canvas-wrapper {
  position: absolute;
  inset: 0;
  min-width: 0;
  min-height: 0;
  background-color: #0b0f17;
}

.canvas-wrapper canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  cursor: crosshair;
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
  box-shadow: 0 0 0 0 rgba(249, 115, 22, 0.7);
  animation: sim-pulse 1.2s infinite;
}

@keyframes sim-pulse {
  0% {
    transform: scale(0.95);
    box-shadow: 0 0 0 0 rgba(249, 115, 22, 0.7);
  }
  70% {
    transform: scale(1);
    box-shadow: 0 0 0 6px rgba(249, 115, 22, 0);
  }
  100% {
    transform: scale(0.95);
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
  transition: background-color 0.2s, transform 0.1s;
}

.drawing-actions .btn:active {
  transform: scale(0.95);
}

.drawing-actions .btn-primary {
  background-color: #10b981;
  color: #fff;
}

.drawing-actions .btn-primary:hover:not(:disabled) {
  background-color: #059669;
}

.drawing-actions .btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.drawing-actions .btn-danger {
  background-color: #ef4444;
  color: #fff;
}

.drawing-actions .btn-danger:hover {
  background-color: #dc2626;
}
</style>
