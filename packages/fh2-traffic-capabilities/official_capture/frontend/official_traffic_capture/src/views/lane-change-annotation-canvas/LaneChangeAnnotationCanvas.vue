<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div ref="root"
       class="annotation-canvas"
       data-plugin-view="lane-change-annotation-canvas"
       :data-editing="state.editing"
       :data-drawing="state.drawingKind ?? ''"
       :data-shape-count="state.shapes.length"
       tabindex="0"
       @click.stop="onClick"
       @dblclick.stop.prevent="onDoubleClick"
       @mousedown.stop="onMouseDown"
       @mousemove.stop="onMouseMove"
       @mouseup.stop="onMouseUp"
       @mouseleave="onMouseLeave"
       @contextmenu.prevent="onContextMenu">
    <canvas ref="canvas" />
    <div v-if="menu"
         class="context-menu"
         :style="{ left: `${menu.left}px`, top: `${menu.top}px` }"
         role="menu"
         @mousedown.stop.prevent
         @click.stop>
      <button v-if="menu.hit.type === 'vertex'" type="button" @click="deleteVertex">删除顶点</button>
      <button v-if="menu.hit.type === 'segment'" type="button" @click="insertVertex">插入顶点</button>
      <button type="button" @click="deleteShape">删除标注</button>
    </div>
  </div>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { nextTick, onMounted, onUnmounted, shallowRef, watch } from 'vue'
import type { Disposable } from 'fh2-plugin-sdk'
import type { LaneChangeCanvasClient, CanvasShape } from './contract'
import type { VideoPoint } from './contract'

const props = defineProps<{ client: LaneChangeCanvasClient }>()
const root = shallowRef<HTMLElement>()
const canvas = shallowRef<HTMLCanvasElement>()
const state = shallowRef({
  visible: false,
  shapes: [] as readonly CanvasShape[],
  draftPoints: [] as readonly VideoPoint[],
  drawingKind: null as 'solid-line' | 'guide-area' | null,
  editing: false,
  selectedShapeId: null as string | null,
  highlightedShapeId: null as string | null,
})
const menu = shallowRef<{
  readonly left: number;
  readonly top: number;
  readonly point: VideoPoint;
  readonly hit: AnnotationHit;
} | null>(null)
let subscription: Disposable | undefined
let observer: ResizeObserver | undefined
let drag: { readonly hit: AnnotationHit; last: VideoPoint } | null = null
let draftCursor: VideoPoint | null = null
let drawFrame: number | null = null

/** 命中测试（原生交互：顶点 → 线段/面体；阈值按容器尺度归一）。 */
type AnnotationHit =
  | { readonly type: 'vertex'; readonly shapeId: string; readonly vertexIndex: number }
  | { readonly type: 'segment'; readonly shapeId: string; readonly segmentIndex: number }
  | { readonly type: 'shape'; readonly shapeId: string }

const HIT_THRESHOLD = 0.015

function distanceToSegment (point: VideoPoint, start: VideoPoint, end: VideoPoint): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y)
  const ratio = Math.min(1, Math.max(0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (start.x + dx * ratio), point.y - (start.y + dy * ratio))
}

function pointInPolygon (point: VideoPoint, polygon: readonly VideoPoint[]): boolean {
  let inside = false
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    const a = polygon[current]!
    const b = polygon[previous]!
    const crosses = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    if (crosses) inside = !inside
  }
  return inside
}

function hitTestShapes (shapes: readonly CanvasShape[], point: VideoPoint): AnnotationHit | null {
  for (const shape of [...shapes].reverse()) {
    for (let index = 0; index < shape.points.length; index += 1) {
      if (Math.hypot(point.x - shape.points[index]!.x, point.y - shape.points[index]!.y) <= HIT_THRESHOLD) {
        return { type: 'vertex', shapeId: shape.id, vertexIndex: index }
      }
    }
    const segmentCount = shape.kind === 'guide-area' ? shape.points.length : shape.points.length - 1
    for (let index = 0; index < segmentCount; index += 1) {
      const next = (index + 1) % shape.points.length
      if (distanceToSegment(point, shape.points[index]!, shape.points[next]!) <= HIT_THRESHOLD) {
        return { type: 'segment', shapeId: shape.id, segmentIndex: index }
      }
    }
    if (shape.kind === 'guide-area' && pointInPolygon(point, shape.points)) {
      return { type: 'shape', shapeId: shape.id }
    }
  }
  return null
}

onMounted(() => {
  subscription = props.client.state.subscribe(value => {
    const previous = state.value
    state.value = value
    if (value.drawingKind === null || (previous.draftPoints.length > 0 && value.draftPoints.length === 0)) {
      draftCursor = null
    }
    void nextTick(scheduleDraw)
  })
  observer = new ResizeObserver(resize)
  if (root.value) observer.observe(root.value)
  window.addEventListener('keydown', onKeyDown)
  resize()
})

onUnmounted(() => {
  subscription?.dispose()
  observer?.disconnect()
  if (drawFrame !== null) cancelAnimationFrame(drawFrame)
  window.removeEventListener('keydown', onKeyDown)
})

watch(canvas, resize)

function resize (): void {
  const element = canvas.value
  const container = root.value
  if (!element || !container) return
  const ratio = window.devicePixelRatio || 1
  const width = Math.max(1, Math.round(container.clientWidth * ratio))
  const height = Math.max(1, Math.round(container.clientHeight * ratio))
  if (element.width !== width || element.height !== height) {
    element.width = width
    element.height = height
  }
  element.style.width = `${container.clientWidth}px`
  element.style.height = `${container.clientHeight}px`
  draw()
}

function scheduleDraw (): void {
  if (drawFrame !== null) return
  drawFrame = requestAnimationFrame(() => {
    drawFrame = null
    draw()
  })
}

/** 原生配色：实线 #FFD800、导流区填充 rgba(255,216,0,.15)、选中 #00D4FF、面板 hover #FF3183。 */
function draw (): void {
  const element = canvas.value
  if (!element) return
  const context = element.getContext('2d')
  if (!context) return
  const ratio = window.devicePixelRatio || 1
  context.clearRect(0, 0, element.width, element.height)

  for (const shape of state.value.shapes) {
    const selected = state.value.selectedShapeId === shape.id
    const highlighted = state.value.highlightedShapeId === shape.id
    context.beginPath()
    shape.points.forEach((point, index) => {
      const x = point.x * element.width
      const y = point.y * element.height
      if (index === 0) context.moveTo(x, y)
      else context.lineTo(x, y)
    })
    if (shape.kind === 'guide-area') context.closePath()
    context.lineWidth = 2 * ratio
    if (highlighted) {
      context.strokeStyle = '#FF3183'
      if (shape.kind === 'guide-area') {
        context.fillStyle = 'rgba(255, 49, 131, .2)'
        context.fill()
      }
    } else if (selected) {
      context.strokeStyle = '#00D4FF'
      if (shape.kind === 'guide-area') {
        context.fillStyle = 'rgba(0, 212, 255, .2)'
        context.fill()
      }
    } else {
      context.strokeStyle = '#FFD800'
      if (shape.kind === 'guide-area') {
        context.fillStyle = 'rgba(255, 216, 0, .15)'
        context.fill()
      }
    }
    context.stroke()
    drawVertices(context, shape.points, element, selected)
  }

  const draftPoints = state.value.draftPoints
  if (draftPoints.length > 0) {
    const previewPoints = draftCursor ? [...draftPoints, draftCursor] : draftPoints
    context.beginPath()
    previewPoints.forEach((point, index) => {
      const x = point.x * element.width
      const y = point.y * element.height
      if (index === 0) context.moveTo(x, y)
      else context.lineTo(x, y)
    })
    const closeGuideArea = state.value.drawingKind === 'guide-area'
      && (draftCursor ? draftPoints.length >= 2 : draftPoints.length >= 3)
    if (closeGuideArea) {
      context.closePath()
      context.fillStyle = 'rgba(0, 212, 255, .12)'
      context.fill()
    }
    context.setLineDash([6 * ratio, 4 * ratio])
    context.lineWidth = 2 * ratio
    context.strokeStyle = '#00D4FF'
    context.stroke()
    context.setLineDash([])
    drawVertices(context, draftPoints, element, false)
  }
}

function drawVertices (
  context: CanvasRenderingContext2D,
  points: readonly VideoPoint[],
  element: HTMLCanvasElement,
  dragging: boolean,
): void {
  const ratio = window.devicePixelRatio || 1
  for (const point of points) {
    context.beginPath()
    context.arc(point.x * element.width, point.y * element.height, (dragging ? 7 : 5) * ratio, 0, Math.PI * 2)
    context.fillStyle = dragging ? '#FF6B6B' : '#FFFFFF'
    context.fill()
  }
}

function normalizedPoint (event: MouseEvent): VideoPoint {
  const rect = root.value?.getBoundingClientRect()
  if (!rect) return { x: 0, y: 0 }
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  }
}

function onClick (event: MouseEvent): void {
  if (state.value.drawingKind === null || drag) return
  root.value?.focus()
  void props.client.addDraftPoint({ point: normalizedPoint(event) })
}

async function onDoubleClick (): Promise<void> {
  if (state.value.drawingKind === null) return
  // 浏览器会在 dblclick 前额外派发一次 click，原生交互需先移除该重复终点。
  await props.client.removeLastDraftPoint()
  await props.client.finishDraft()
}

function onMouseDown (event: MouseEvent): void {
  menu.value = null
  if (event.button !== 0 || !state.value.editing) return
  root.value?.focus()
  const point = normalizedPoint(event)
  const hit = hitTestShapes(state.value.shapes, point)
  void props.client.selectShape({ id: hit?.shapeId ?? null })
  if (hit) drag = { hit, last: point }
}

function onMouseMove (event: MouseEvent): void {
  if (state.value.drawingKind !== null) {
    draftCursor = normalizedPoint(event)
    scheduleDraw()
    return
  }
  if (!drag || !state.value.editing) return
  const point = normalizedPoint(event)
  if (drag.hit.type === 'vertex') {
    void props.client.moveVertex({
      shapeId: drag.hit.shapeId,
      vertexIndex: drag.hit.vertexIndex,
      point,
    })
  } else {
    void props.client.moveShape({
      shapeId: drag.hit.shapeId,
      delta: { x: point.x - drag.last.x, y: point.y - drag.last.y },
    })
  }
  drag.last = point
}

function onMouseUp (): void {
  drag = null
}

function onMouseLeave (): void {
  onMouseUp()
  if (!draftCursor) return
  draftCursor = null
  scheduleDraw()
}

function onContextMenu (event: MouseEvent): void {
  if (!state.value.editing) return
  const point = normalizedPoint(event)
  const hit = hitTestShapes(state.value.shapes, point)
  if (!hit) {
    menu.value = null
    return
  }
  const rect = root.value?.getBoundingClientRect()
  menu.value = {
    left: event.clientX - (rect?.left ?? 0),
    top: event.clientY - (rect?.top ?? 0),
    point,
    hit,
  }
  void props.client.selectShape({ id: hit.shapeId })
}

function deleteVertex (): void {
  if (menu.value?.hit.type === 'vertex') {
    void props.client.deleteVertex({
      shapeId: menu.value.hit.shapeId,
      vertexIndex: menu.value.hit.vertexIndex,
    })
  }
  menu.value = null
}

function insertVertex (): void {
  if (menu.value?.hit.type === 'segment') {
    void props.client.insertVertex({
      shapeId: menu.value.hit.shapeId,
      segmentIndex: menu.value.hit.segmentIndex,
      point: menu.value.point,
    })
  }
  menu.value = null
}

function deleteShape (): void {
  if (menu.value) void props.client.deleteShape({ shapeId: menu.value.hit.shapeId })
  menu.value = null
}

function onKeyDown (event: KeyboardEvent): void {
  if (!state.value.editing && state.value.drawingKind === null) return
  const rect = root.value?.getBoundingClientRect()
  if (rect && document.activeElement
    && rect.top <= document.activeElement.getBoundingClientRect().top
    && document.activeElement !== root.value
    && root.value?.contains(document.activeElement) === false
    && ['INPUT', 'TEXTAREA'].includes((document.activeElement as HTMLElement).tagName)) {
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    if (menu.value) {
      menu.value = null
      return
    }
    if (state.value.drawingKind !== null) {
      void props.client.cancelDraft()
      return
    }
    void props.client.selectShape({ id: null })
    return
  }
  if ((event.key === 'Delete' || event.key === 'Backspace') && state.value.selectedShapeId) {
    event.preventDefault()
    if (menu.value) menu.value = null
    void props.client.deleteShape({ shapeId: state.value.selectedShapeId })
  }
}
</script>

<style scoped>
* { box-sizing: border-box; }
.annotation-canvas { position: relative; width: 100%; height: 100%; overflow: hidden; outline: none; cursor: crosshair; }
.annotation-canvas[data-drawing=""] { cursor: default; }
.annotation-canvas[data-editing="true"] { cursor: move; }
canvas { display: block; width: 100%; height: 100%; }
.context-menu { position: absolute; z-index: 9999; display: flex; min-width: 100px; flex-direction: column; padding: 4px; border-radius: 6px; background: #1f1f1f; box-shadow: 0 8px 24px rgba(0, 0, 0, .45); }
.context-menu button { padding: 6px 10px; border: 0; border-radius: 3px; background: transparent; color: #e2e8f0; text-align: left; cursor: pointer; }
.context-menu button:hover { background: #1e293b; }
</style>
