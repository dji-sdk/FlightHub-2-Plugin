<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="patrol-preview"
       data-plugin-view="patrol-preview">
    <div class="patrol-preview__stage">
      <template v-if="state.photos.length">
        <ImageViewer :key="currentUrl"
                     :url="currentUrl" />
        <div class="photo-pager">
          <div class="pager-arrow pager-arrow-prev"
               :class="{ 'pager-arrow-disabled': state.photos.length <= 1 }"
               @click="prev">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none">
              <path d="M6 3L11 8L6 13" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </div>
          <span class="pager-index">{{ index + 1 }} / {{ state.photos.length }}</span>
          <div class="pager-arrow"
               :class="{ 'pager-arrow-disabled': state.photos.length <= 1 }"
               @click="next">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none">
              <path d="M6 3L11 8L6 13" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </div>
        </div>
      </template>
      <div v-else
           class="preview-empty">
        暂无照片
      </div>

      <div class="preview-overlay">
        <div class="overlay-left">
          <span class="overlay-name"
                :title="state.displayName">{{ state.displayName }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { computed, onMounted, onUnmounted, shallowRef } from 'vue'
import type { Disposable } from 'fh2-plugin-sdk'
import type { PreviewClient, PreviewState } from './contract'
import ImageViewer from './ImageViewer.vue'

/**
 * 违停车辆证据预览（SubLive tab），移植自原生 PatrolPreview +
 * MultiPhotoSwitcher + CapturePreviewLayout。照片加载在 Entry 完成。
 */
const props = defineProps<{ client: PreviewClient }>()
const client = props.client

const state = shallowRef<PreviewState>({ displayName: '', photos: [], initialIndex: 0 })
let subscription: Disposable | undefined
const index = shallowRef(0)

onMounted(() => {
  subscription = client.state.subscribe(value => {
    const targetChanged = value.displayName !== state.value.displayName
    state.value = value
    // 新目标定位到指定照片；同目标照片更新（复检照片到达）保持用户位置
    if (targetChanged) index.value = clamp(value.initialIndex)
    else index.value = clamp(index.value)
  })
})
onUnmounted(() => subscription?.dispose())

function clamp (i: number): number {
  if (!state.value.photos.length) return 0
  return Math.min(Math.max(i, 0), state.value.photos.length - 1)
}

const currentUrl = computed(() => state.value.photos[index.value] ?? '')

function prev (): void {
  if (state.value.photos.length <= 1) return
  index.value = (index.value - 1 + state.value.photos.length) % state.value.photos.length
}
function next (): void {
  if (state.value.photos.length <= 1) return
  index.value = (index.value + 1) % state.value.photos.length
}
</script>

<style scoped>
.patrol-preview {
  height: calc(100% - 20px);
  background: #000;
  color: #fff;
  font-family: "Open Sans", "PingFang SC", "Microsoft YaHei", sans-serif;
}
.patrol-preview__stage {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.preview-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.6) 0%, rgba(0, 0, 0, 0) 100%);
  pointer-events: none;
}
.overlay-left {
  flex: 1;
  min-width: 0;
}
.overlay-name {
  color: #fff;
  font-size: 16px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-empty {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: rgba(255, 255, 255, 0.7);
  font-size: 12px;
}

.photo-pager {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 6px;
}
.pager-arrow {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  cursor: pointer;
  transition: background 0.2s;
}
.pager-arrow-prev {
  transform: scaleX(-1);
}
.pager-arrow:hover {
  background: rgba(255, 255, 255, 0.12);
}
.pager-arrow-disabled {
  cursor: not-allowed;
  opacity: 0.35;
}
.pager-arrow-disabled:hover {
  background: transparent;
}
.pager-index {
  min-width: 40px;
  text-align: center;
  color: #fff;
  font-size: 14px;
  line-height: 22px;
  font-weight: bold;
}
</style>
