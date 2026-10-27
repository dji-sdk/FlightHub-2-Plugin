<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="image-viewer-root">
    <div class="image-viewer"
         @wheel.prevent="onWheel"
         @dblclick="onDblClick"
         @pointerdown="onPointerDown"
         @pointermove="onPointerMove"
         @pointerup="onPointerUp"
         @pointercancel="onPointerUp">
      <img class="image-viewer__img"
           :src="url"
           :style="imageStyle"
           :draggable="false"
           alt="">
      <div v-if="url"
           class="image-viewer__toolbar">
        <button type="button" title="放大" aria-label="放大" @click="zoomBy(0.5)">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none">
            <circle cx="7" cy="7" r="4.5" stroke="#fff" stroke-width="1.3" />
            <path d="M10.5 10.5L14 14" stroke="#fff" stroke-width="1.3" stroke-linecap="round" />
            <path d="M5 7h4M7 5v4" stroke="#fff" stroke-width="1.3" stroke-linecap="round" />
          </svg>
        </button>
        <button type="button" title="缩小" aria-label="缩小" @click="zoomBy(-0.5)">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none">
            <circle cx="7" cy="7" r="4.5" stroke="#fff" stroke-width="1.3" />
            <path d="M10.5 10.5L14 14" stroke="#fff" stroke-width="1.3" stroke-linecap="round" />
            <path d="M5 7h4" stroke="#fff" stroke-width="1.3" stroke-linecap="round" />
          </svg>
        </button>
        <button type="button" title="放大预览" aria-label="放大预览" @click="openPreview">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none"
               stroke="#fff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4" />
          </svg>
        </button>
        <button type="button" title="旋转" aria-label="旋转" @click="rotate">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none"
               stroke="#fff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3.2 5.5A5.5 5.5 0 1 1 2.5 8.8" />
            <path d="M3 1.8v3.9h3.9" />
          </svg>
        </button>
      </div>
    </div>

    <dialog ref="dialogRef"
            class="image-viewer-dialog"
            aria-label="图片大图预览"
            @cancel.prevent
            @click="onDialogClick">
      <div class="image-viewer image-viewer--large"
           @wheel.prevent="onWheel"
           @dblclick="onDblClick"
           @pointerdown="onPointerDown"
           @pointermove="onPointerMove"
           @pointerup="onPointerUp"
           @pointercancel="onPointerUp">
        <img class="image-viewer__img"
             :src="url"
             :style="imageStyle"
             :draggable="false"
             alt="">
        <div class="image-viewer__toolbar image-viewer__toolbar--large">
          <button type="button" title="放大" aria-label="放大" @click="zoomBy(0.5)">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none">
              <circle cx="7" cy="7" r="4.5" stroke="#fff" stroke-width="1.3" />
              <path d="M10.5 10.5L14 14" stroke="#fff" stroke-width="1.3" stroke-linecap="round" />
              <path d="M5 7h4M7 5v4" stroke="#fff" stroke-width="1.3" stroke-linecap="round" />
            </svg>
          </button>
          <button type="button" title="缩小" aria-label="缩小" @click="zoomBy(-0.5)">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none">
              <circle cx="7" cy="7" r="4.5" stroke="#fff" stroke-width="1.3" />
              <path d="M10.5 10.5L14 14" stroke="#fff" stroke-width="1.3" stroke-linecap="round" />
              <path d="M5 7h4" stroke="#fff" stroke-width="1.3" stroke-linecap="round" />
            </svg>
          </button>
          <button type="button" title="退出大图" aria-label="退出大图" @click="closePreview">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none"
                 stroke="#fff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2 6h4V2M14 6h-4V2M2 10h4v4M14 10h-4v4" />
            </svg>
          </button>
          <button type="button" title="旋转" aria-label="旋转" @click="rotate">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none"
                 stroke="#fff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3.2 5.5A5.5 5.5 0 1 1 2.5 8.8" />
              <path d="M3 1.8v3.9h3.9" />
            </svg>
          </button>
        </div>
      </div>
    </dialog>
  </div>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { computed, ref } from 'vue'

/**
 * 自绘图片查看器：缩放（滚轮/按钮）、旋转、拖拽平移、大图弹窗、双击复位。
 * 工具栏：右下角组合式 4 操作（放大/缩小/大图/旋转）。
 */
const props = defineProps<{ url: string }>()

const dialogRef = ref<HTMLDialogElement | null>(null)
const scale = ref(1)
const rotation = ref(0)
const offset = ref({ x: 0, y: 0 })
const dragging = ref(false)
const dragStart = ref({ x: 0, y: 0 })

const imageStyle = computed(() => ({
  transform: `translate(${offset.value.x}px, ${offset.value.y}px) rotate(${rotation.value}deg) scale(${scale.value})`,
  cursor: dragging.value ? 'grabbing' : scale.value > 1 ? 'grab' : 'default',
}))

function zoomBy (delta: number): void {
  scale.value = Math.min(6, Math.max(0.5, Math.round((scale.value + delta) * 2) / 2))
}

function onWheel (event: WheelEvent): void {
  zoomBy(event.deltaY < 0 ? 0.25 : -0.25)
}

function onDblClick (event: MouseEvent): void {
  // 只在图片/舞台空白处双击复位，工具栏按钮上的双击不触发
  const target = event.target as HTMLElement
  if (target === event.currentTarget || target.classList.contains('image-viewer__img')) reset()
}

function reset (): void {
  scale.value = 1
  rotation.value = 0
  offset.value = { x: 0, y: 0 }
}

function rotate (): void {
  rotation.value = (rotation.value + 90) % 360
}

function onPointerDown (event: PointerEvent): void {
  if (scale.value <= 1) return
  dragging.value = true
  dragStart.value = { x: event.clientX - offset.value.x, y: event.clientY - offset.value.y }
  ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
}

function onPointerMove (event: PointerEvent): void {
  if (!dragging.value) return
  offset.value = { x: event.clientX - dragStart.value.x, y: event.clientY - dragStart.value.y }
}

function onPointerUp (): void {
  dragging.value = false
}

function openPreview (): void {
  if (dialogRef.value && !dialogRef.value.open) dialogRef.value.showModal()
}

function closePreview (): void {
  if (dialogRef.value?.open) dialogRef.value.close()
}

function onDialogClick (event: MouseEvent): void {
  if (event.target === dialogRef.value) closePreview()
}
</script>

<style scoped>
.image-viewer-root {
  width: 100%;
  height: 100%;
}
.image-viewer {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
  touch-action: none;
}
.image-viewer-dialog {
  width: calc(100vw - 48px);
  height: calc(100vh - 48px);
  max-width: 1440px;
  max-height: 960px;
  padding: 0;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 8px;
  background: #000;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
}
.image-viewer-dialog::backdrop {
  background: rgba(0, 0, 0, 0.72);
}
.image-viewer--large {
  width: 100%;
  height: 100%;
}
.image-viewer__img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  transition: transform 0.15s ease;
  user-select: none;
}

/* 组合式工具栏：对齐原生 CaptureImageViewer（右下角，避开底部分页器） */
.image-viewer__toolbar {
  position: absolute;
  right: 8px;
  bottom: 60px;
  padding: 2px;
  z-index: 3;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  background: #2a2a2a;
}
.image-viewer__toolbar--large {
  bottom: 12px;
}
.image-viewer__toolbar button {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  padding: 0;
  cursor: pointer;
}
</style>
