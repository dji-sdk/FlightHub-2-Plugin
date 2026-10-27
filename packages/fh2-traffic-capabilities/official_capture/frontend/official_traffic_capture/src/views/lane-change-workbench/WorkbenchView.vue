<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="workbench" data-plugin-view="lane-change-workbench" :data-collapsed="state.panelCollapsed">
    <button class="header" type="button" @click="toggleCollapsed">
      <span class="arrow" :class="{ collapsed: state.panelCollapsed }">▾</span>
      <span class="title">违章变道抓拍</span>
    </button>

    <div v-show="!state.panelCollapsed" class="body">
      <div class="row type-row">
        <label class="field-label">指定违章类型</label>
        <select class="type-select"
                :value="state.violationType"
                :disabled="globalLocked || editModeActive"
                data-testid="violation-type-select"
                @change="onViolationTypeChange">
          <option value="both">实线+导流区</option>
          <option value="solidLine">实线</option>
          <option value="guideArea">导流区</option>
        </select>
      </div>

      <div v-if="visibleAnnotations.length > 0" class="annotation-list" data-testid="annotation-list">
        <div v-for="annotation in visibleAnnotations"
             :key="annotation.id"
             class="annotation-row"
             :data-annotation-id="annotation.id"
             @mouseenter="setHighlight(annotation.id)"
             @mouseleave="setHighlight(null)">
          <label class="check">
            <input type="checkbox"
                   :checked="annotation.loaded"
                   :disabled="globalLocked || editModeActive"
                   @change="toggleLoaded(annotation, ($event.target as HTMLInputElement).checked)">
          </label>
          <span class="name" :title="`${annotation.name}（${annotation.coordinateMode === 'geo' ? '地理锚定' : '画面坐标'}）`">
            {{ annotation.name }}
          </span>
          <span class="actions">
            <button class="row-icon"
                    type="button"
                    aria-label="重命名"
                    data-testid="annotation-rename"
                    :disabled="globalLocked || editModeActive"
                    @click.stop="requestRename(annotation)"
                    @mouseenter="showActionTooltip('重命名', $event)"
                    @mouseleave="hideActionTooltip">
              <!-- 图形迁移自宿主图标库 ai-alert-edit.svg（16px 白色） -->
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                <path d="M10.907695195312499,1.6279274109375C10.907695195312499,1.6279274109375,11.7809851953125,2.1133822109375,11.7809851953125,2.1133822109375C12.021995195312499,2.2473682109375,12.1051951953125,2.5444672109375,11.9655251953125,2.7765162109375C11.9655251953125,2.7765162109375,11.209215195312499,4.0377262109375,11.209215195312499,4.0377262109375C11.209215195312499,4.0377262109375,9.462635195312501,3.0668162109374997,9.462635195312501,3.0668162109375C9.462635195312501,3.0668162109375,10.2189451953125,1.8056042109375001,10.2189451953125,1.8056042109375001C10.3581151953125,1.5735564109375,10.6666851953125,1.4939417109375,10.907695195312499,1.6279274109375ZM4.1684531953125,11.8952662109375C4.1684531953125,11.8952662109375,8.7063251953125,4.3280262109375,8.7063251953125,4.3280262109375C8.7063251953125,4.3280262109375,10.4529051953125,5.2989362109375,10.4529051953125,5.2989362109375C10.4529051953125,5.2989362109375,5.9150251953125,12.8662662109375,5.9150251953125,12.8662662109375C5.9150251953125,12.8662662109375,4.0333251953125,14.0628662109375,4.0333251953125,14.0628662109375C4.0333251953125,14.0628662109375,4.1684531953125,11.8952662109375,4.1684531953125,11.8952662109375Z"
                      fill-rule="evenodd"
                      fill="currentColor" />
              </svg>
            </button>
            <DoubleClickDeleteIcon
              :disabled="globalLocked || editModeActive"
              @delete="remove(annotation)"
              @mouseenter="showActionTooltip('删除', $event)"
              @mouseleave="hideActionTooltip" />
          </span>
        </div>
      </div>
      <div v-else class="empty" data-testid="annotation-empty">暂无标注数据</div>

      <div class="btn-row">
        <button v-if="showAddSolid" class="op-btn" type="button"
                :class="{ primary: state.drawingKind === 'solid-line' }"
                :disabled="globalLocked || (editModeActive && state.drawingKind !== 'solid-line')"
                data-testid="add-solid-line"
                @click="beginDraw('solid-line')">
          {{ state.drawingKind === 'solid-line' ? '完成编辑' : '新增实线' }}
        </button>
        <button v-if="showAddGuide" class="op-btn" type="button"
                :class="{ primary: state.drawingKind === 'guide-area' }"
                :disabled="globalLocked || (editModeActive && state.drawingKind !== 'guide-area')"
                data-testid="add-guide-area"
                @click="beginDraw('guide-area')">
          {{ state.drawingKind === 'guide-area' ? '完成编辑' : '新增导流区' }}
        </button>
      </div>
      <div class="btn-row">
        <button class="op-btn" type="button"
                :class="{ primary: state.editing }"
                :disabled="globalLocked || (state.drawingKind !== null && !state.editing)"
                data-testid="edit-annotations"
                @click="toggleEdit">
          {{ state.editing ? '完成编辑' : '编辑识别线' }}
        </button>
      </div>

      <button class="capture-btn" type="button"
              :class="{ capturing: state.captureStatus === 'capturing' }"
              :disabled="captureDisabled"
              data-testid="capture-toggle"
              @click="toggleCapture">
        {{ captureButtonText }}
      </button>

      <p v-if="state.message" class="message" data-testid="workbench-message">{{ state.message }}</p>
    </div>

    <!-- 行内操作 Tooltip：挂 Engine overlay 根，越过标注列表 overflow 裁剪与宿主 transform -->
    <Teleport :to="overlayElement">
      <div v-if="actionTooltip"
           class="action-tooltip"
           role="tooltip"
           :style="{ left: `${actionTooltip.left}px`, top: `${actionTooltip.top}px` }">{{ actionTooltip.text }}</div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { computed, onMounted, onUnmounted, shallowRef, watch } from 'vue'
import type { Disposable } from 'fh2-plugin-sdk'
import type { LaneChangeWorkbenchClient, WorkbenchAnnotation } from './contract'
import { resolveTooltipPosition } from '../capture-settings/tooltip-position'
import DoubleClickDeleteIcon from './DoubleClickDeleteIcon.vue'

const props = defineProps<{ client: LaneChangeWorkbenchClient; overlayElement: HTMLElement }>()
const state = shallowRef({
  panelVisible: false,
  panelCollapsed: false,
  enabled: false,
  captureStatus: 'idle' as 'idle' | 'capturing' | 'paused',
  violationType: 'both' as 'solidLine' | 'guideArea' | 'both',
  annotations: [] as readonly WorkbenchAnnotation[],
  highlightedAnnotationId: null as string | null,
  drawingKind: null as 'solid-line' | 'guide-area' | null,
  editing: false,
  captureBusy: false,
  message: null as string | null,
})
let subscription: Disposable | undefined
const actionTooltip = shallowRef<{ text: string; left: number; top: number } | null>(null)

onMounted(() => {
  subscription = props.client.state.subscribe(value => {
    state.value = value
  })
})
onUnmounted(() => {
  subscription?.dispose()
  actionTooltip.value = null
})

const globalLocked = computed(() => state.value.captureStatus === 'capturing')
const editModeActive = computed(() => state.value.drawingKind !== null || state.value.editing)
const showAddSolid = computed(() => state.value.violationType === 'both' || state.value.violationType === 'solidLine')
const showAddGuide = computed(() => state.value.violationType === 'both' || state.value.violationType === 'guideArea')

watch([globalLocked, editModeActive], ([locked, editing]) => {
  if (locked || editing) hideActionTooltip()
})

const visibleAnnotations = computed(() => {
  const type = state.value.violationType
  return [...state.value.annotations]
    .filter(annotation => type === 'both'
      || (type === 'solidLine' && annotation.kind === 'solid-line')
      || (type === 'guideArea' && annotation.kind === 'guide-area'))
    .sort((left, right) => right.createdAt - left.createdAt)
})

const captureDisabled = computed(() => {
  if (state.value.captureBusy || !state.value.enabled) return true
  if (state.value.drawingKind !== null || state.value.editing) return true
  const loaded = state.value.annotations.some(annotation => annotation.loaded)
  return !loaded && state.value.captureStatus !== 'capturing'
})

const captureButtonText = computed(() => {
  if (state.value.captureBusy) return '处理中…'
  if (state.value.captureStatus === 'capturing') return '暂停抓拍'
  return '开始抓拍'
})

function toggleCollapsed (): void {
  void props.client.setCollapsed({ collapsed: !state.value.panelCollapsed })
}

function onViolationTypeChange (event: Event): void {
  hideActionTooltip()
  void props.client.setViolationType({ type: (event.target as HTMLSelectElement).value as 'solidLine' | 'guideArea' | 'both' })
}

function toggleLoaded (annotation: WorkbenchAnnotation, loaded: boolean): void {
  void props.client.toggleAnnotationLoaded({ id: annotation.id, loaded })
}

function setHighlight (id: string | null): void {
  void props.client.setHighlight({ id })
}

function requestRename (annotation: WorkbenchAnnotation): void {
  void props.client.requestRename({ id: annotation.id })
}

function remove (annotation: WorkbenchAnnotation): void {
  hideActionTooltip()
  void props.client.deleteAnnotation({ id: annotation.id })
}

/** 行内操作 Tooltip（原生 OberonTooltip 语义）：hover 显示；坐标换算到 View overlay 本地坐标。 */
function showActionTooltip (text: string, event: Event): void {
  if (globalLocked.value || editModeActive.value) {
    hideActionTooltip()
    return
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const position = resolveTooltipPosition(rect, props.overlayElement.getBoundingClientRect(), window.innerWidth)
  actionTooltip.value = { text, left: position.left, top: position.top }
}

function hideActionTooltip (): void {
  actionTooltip.value = null
}

function beginDraw (kind: 'solid-line' | 'guide-area'): void {
  void props.client.beginDraw({ kind })
}

function toggleEdit (): void {
  if (state.value.editing) void props.client.finishEdit()
  else void props.client.beginEdit()
}

function toggleCapture (): void {
  void props.client.toggleCapture()
}
</script>

<style scoped>
* { box-sizing: border-box; }
.workbench { position: relative; display: flex; width: 100%; flex-direction: column; border: 1px solid rgba(255, 255, 255, .08); border-radius: 6px; background: #1f1f1f; color: #fff; font: 12px/1.4 system-ui, sans-serif; box-shadow: 0 2px 12px rgba(0, 0, 0, .5); }
.header { display: flex; height: 32px; align-items: center; gap: 6px; padding: 0 12px; border: 0; background: transparent; color: inherit; cursor: pointer; text-align: left; }
.header .arrow { color: #fff; transition: transform .18s; font-size: 10px; }
.header .arrow.collapsed { transform: rotate(-90deg); }
.header .title { font-weight: 600; }
.body { display: flex; flex-direction: column; gap: 10px; overflow-y: auto; padding: 8px 12px; }
.row { display: flex; align-items: center; gap: 8px; }
.type-row { flex-direction: column; align-items: stretch; gap: 6px; }
.field-label { color: rgba(255, 255, 255, .7); font-size: 14px; line-height: 24px; }
.type-select { width: 100%; padding: 4px 8px; border: 1px solid rgba(255, 255, 255, .15); border-radius: 4px; background: #2b2b2b; color: #fff; font-size: 12px; }
.type-select:disabled { opacity: .4; }
/* 固定三行标注高度（3×32 行高 + 2×4 间隔 + 2×4 内边距 + 2 边框），超出滚动，面板高度不随标注增多变化 */
.annotation-list { display: flex; max-height: 114px; flex-direction: column; gap: 4px; overflow-y: auto; padding: 4px 0; border: 1px solid rgba(255, 255, 255, .15); border-radius: 6px; }
.annotation-row { display: flex; height: 32px; align-items: center; gap: 8px; padding: 4px 12px; font-size: 14px; }
.annotation-row:hover { background: rgba(255, 255, 255, .06); }
.annotation-row .check input { accent-color: #0075ff; }
.annotation-row .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.annotation-row .actions { display: flex; gap: 4px; }
/* 对齐原生 .lc-line-icon：白色图标、24px 热区、禁用 opacity .3 且不可点 */
.row-icon { display: inline-flex; align-items: center; justify-content: center; padding: 4px; border: 0; background: transparent; color: #fff; cursor: pointer; }
.row-icon:hover:not(:disabled) { opacity: .8; }
.row-icon:disabled { opacity: .3; pointer-events: none; cursor: default; }
.empty { padding: 10px; border: 1px dashed #3a4256; border-radius: 5px; color: #64748b; text-align: center; }
.btn-row { display: flex; gap: 8px; }
.op-btn { flex: 1; padding: 6px 8px; border: 1px solid rgba(255, 255, 255, .15); border-radius: 4px; background: #2b2b2b; color: #fff; font-size: 12px; cursor: pointer; }
.op-btn:hover:not(:disabled) { border-color: #5b7fd4; }
.op-btn.primary { border-color: #0075ff; background: rgba(0, 117, 255, .18); color: #7ab4ff; }
.op-btn:disabled { opacity: .35; cursor: default; }
/* 高度对齐 .op-btn（同 padding/字号），paused 与 idle 同为蓝色主按钮；capturing 对齐原生透明底 #0075ff 描边 */
.capture-btn { padding: 6px 8px; border: 1px solid #0075ff; border-radius: 4px; background: #0075ff; color: #ffffff; font-size: 12px; cursor: pointer; }
.capture-btn.capturing { border-color: #0075ff; background: transparent; color: #0075ff; }
.capture-btn:disabled { opacity: .35; cursor: default; }
.message { margin: 0; color: #ffc800; font-size: 11px; }
/* 行内操作 Tooltip：挂 Engine overlay 根（零尺寸 fixed），显式 visibility 越过默认隐藏 */
.action-tooltip { position: absolute; visibility: visible; z-index: 1; transform: translate(-50%, -100%); padding: 5px 10px; border-radius: 4px; background: #3a3a3a; box-shadow: 0 2px 8px rgba(0, 0, 0, .35); color: #fff; font-size: 12px; line-height: 18px; white-space: nowrap; pointer-events: none; }
</style>
