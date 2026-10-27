<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="sim-annotation-panel">
    <div class="panel-header">
      <h3>标注区域管理 (Regions)</h3>
    </div>

    <div class="panel-body">
      <div class="add-buttons">
        <button
          class="btn-draw"
          :class="{ active: addingMode === 'line' }"
          @click="startDraw('line')"
        >
          + 绘制实线 (LINE)
        </button>

        <button
          class="btn-draw"
          :class="{ active: addingMode === 'polygon' }"
          @click="startDraw('polygon')"
        >
          + 绘制导流线 (POLY)
        </button>
      </div>

      <div class="regions-list">
        <div v-if="allRegions.length === 0" class="empty-text">
          暂无绘制或预设的标注区域。
        </div>

        <div
          v-for="reg in allRegions"
          :key="reg.id"
          class="region-card"
          :class="{ hidden: isHidden(reg.id) }"
        >
          <div class="region-info">
            <span class="region-kind" :class="reg.kind">{{ reg.kind.toUpperCase() }}</span>
            <span class="region-id" :title="reg.id">{{ reg.id }}</span>
            <span class="points-count">({{ reg.points.length }}点)</span>
            <span>{{ reg.points }}</span>
          </div>

          <div class="region-actions">
            <button
              class="action-btn"
              :title="isHidden(reg.id) ? '显示标注' : '隐藏标注'"
              @click="toggleVisibility(reg.id)"
            >
              {{ isHidden(reg.id) ? '显示' : '隐' }}
            </button>

            <button
              v-if="isManual(reg.id)"
              class="action-btn danger"
              title="删除标注"
              @click="removeRegion(reg.id)"
            >
              删
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { defineComponent, computed, type PropType } from 'vue'
import type { SimRunner } from '../sim/runner'

export default defineComponent({
  name: 'SimAnnotationPanel',
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
  emits: ['start-draw'],
  setup (props, { emit }) {
    const allRegions = computed(() => props.runner.allRegions)
    const hiddenIds = computed(() => props.runner.hiddenRegionIds.value)
    const manualRegions = computed(() => props.runner.manualRegionList)

    const isHidden = (id: string) => {
      return hiddenIds.value.has(id)
    }

    const isManual = (id: string) => {
      return manualRegions.value.some(region => region.id === id)
    }

    const toggleVisibility = (id: string) => {
      props.runner.toggleRegionVisibility(id)
    }

    const removeRegion = (id: string) => {
      props.runner.removeManualRegion(id)
    }

    const startDraw = (kind: 'line' | 'polygon') => {
      if (props.addingMode === kind) {
        emit('start-draw', null)
      } else {
        emit('start-draw', kind)
      }
    }

    return {
      allRegions,
      isHidden,
      isManual,
      toggleVisibility,
      removeRegion,
      startDraw,
    }
  },
})
</script>

<style scoped>
.sim-annotation-panel {
  background-color: rgba(17, 17, 17, 0.76);
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(8px);
}

.panel-header {
  padding: 10px 12px;
  border-bottom: 1px solid rgba(45, 55, 72, 0.86);
  background-color: rgba(17, 21, 29, 0.78);
  border-top-left-radius: 4px;
  border-top-right-radius: 4px;
}

.panel-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: #e0e0e0;
}

.panel-body {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.add-buttons {
  display: flex;
  gap: 10px;
}

.btn-draw {
  flex: 1;
  font-size: 12px;
  height: 32px;
  border-radius: 4px;
  border: 1px solid #3b82f6;
  background: transparent;
  color: #93c5fd;
  cursor: pointer;
  transition: background-color 0.2s, color 0.2s;
}

.btn-draw:hover {
  background-color: rgba(59, 130, 246, 0.18);
  color: #fff;
}

.btn-draw.active {
  background-color: rgba(59, 130, 246, 0.35);
  color: #fff;
  border-color: #60a5fa;
}

.regions-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 160px;
  overflow-y: auto;
}

.empty-text {
  font-size: 11.5px;
  color: #64748b;
  text-align: center;
  padding: 12px 0;
}

.region-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 8px;
  background-color: rgba(30, 41, 59, 0.5);
  border: 1px solid rgba(51, 65, 85, 0.6);
  border-radius: 4px;
  transition: opacity 0.2s;
}

.region-card.hidden {
  opacity: 0.45;
}

.region-info {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 11px;
}

.region-kind {
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 700;
  font-family: monospace;
  flex-shrink: 0;
}

.region-kind.line {
  background-color: rgba(56, 189, 248, 0.18);
  color: #7dd3fc;
  border: 1px solid rgba(56, 189, 248, 0.4);
}

.region-kind.polygon {
  background-color: rgba(250, 204, 21, 0.15);
  color: #fde047;
  border: 1px solid rgba(250, 204, 21, 0.4);
}

.region-id {
  color: #cbd5e1;
  font-family: monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.points-count {
  color: #64748b;
  font-size: 10px;
  flex-shrink: 0;
}

.region-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.action-btn {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 1px solid #475569;
  background-color: #242f41;
  color: #cbd5e1;
  font-size: 10px;
  cursor: pointer;
  line-height: 1;
  padding: 0;
}

.action-btn:hover {
  background-color: #2d3f59;
  color: #fff;
}

.action-btn.danger {
  border-color: rgba(239, 68, 68, 0.5);
  color: #fca5a5;
}

.action-btn.danger:hover {
  background-color: rgba(239, 68, 68, 0.2);
  color: #fff;
}
</style>
