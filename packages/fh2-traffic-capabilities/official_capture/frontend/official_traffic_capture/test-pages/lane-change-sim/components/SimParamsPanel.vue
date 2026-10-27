<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="sim-params-panel">
    <div class="panel-header">
      <h3>算法阈值调优 (PARAMS)</h3>
      <button class="reset-btn" @click="resetParams">重置默认</button>
    </div>

    <div class="panel-body">
      <div class="param-item">
        <div class="param-label-row">
          <div class="param-name-block">
            <span class="param-name-zh" title="超过此时间未观测到，该车 tracker 被老化删除并按需落 tombstone">追踪器超时</span>
            <span class="param-name-en">TRACKER_TIMEOUT_MS</span>
          </div>
          <span class="param-value">{{ params.TRACKER_TIMEOUT_MS }}ms</span>
        </div>
        <input
          v-model.number="params.TRACKER_TIMEOUT_MS"
          type="range"
          min="100"
          max="3000"
          step="50"
          @change="applyParams"
        >
      </div>

      <div class="param-item">
        <div class="param-label-row">
          <div class="param-name-block">
            <span class="param-name-zh" title="必须连续观测到此帧数以上才参与规则判断（防抖）">最少观测帧数</span>
            <span class="param-name-en">MIN_TRACKER_AGE_FRAMES</span>
          </div>
          <span class="param-value">{{ params.MIN_TRACKER_AGE_FRAMES }}帧</span>
        </div>
        <input
          v-model.number="params.MIN_TRACKER_AGE_FRAMES"
          type="range"
          min="1"
          max="10"
          step="1"
          @change="applyParams"
        >
      </div>

      <div class="param-item">
        <div class="param-label-row">
          <div class="param-name-block">
            <span class="param-name-zh" title="实线：footprint 持续压线达到此时长触发 line-occupy">静态压线时长</span>
            <span class="param-name-en">LINE_OCCUPY_MS</span>
          </div>
          <span class="param-value">{{ params.LINE_OCCUPY_MS }}ms</span>
        </div>
        <input
          v-model.number="params.LINE_OCCUPY_MS"
          type="range"
          min="200"
          max="5000"
          step="100"
          @change="applyParams"
        >
      </div>

      <div class="param-item">
        <div class="param-label-row">
          <div class="param-name-block">
            <span class="param-name-zh" title="相邻帧 bbox 中心位移上限，过滤缓慢沿线行驶的持续压框">占线帧位移上限</span>
            <span class="param-name-en">LINE_OCCUPY_MAX_FRAME_MOVE</span>
          </div>
          <span class="param-value">{{ params.LINE_OCCUPY_MAX_FRAME_MOVE.toFixed(3) }}</span>
        </div>
        <input
          v-model.number="params.LINE_OCCUPY_MAX_FRAME_MOVE"
          type="range"
          min="0.001"
          max="0.01"
          step="0.001"
          @change="applyParams"
        >
      </div>

      <div class="param-item">
        <div class="param-label-row">
          <div class="param-name-block">
            <span class="param-name-zh" title="占线累计窗口内 bbox 中心总位移上限，超过视为运动车辆">占线总位移上限</span>
            <span class="param-name-en">LINE_OCCUPY_MAX_TOTAL_MOVE</span>
          </div>
          <span class="param-value">{{ params.LINE_OCCUPY_MAX_TOTAL_MOVE.toFixed(3) }}</span>
        </div>
        <input
          v-model.number="params.LINE_OCCUPY_MAX_TOTAL_MOVE"
          type="range"
          min="0.002"
          max="0.02"
          step="0.001"
          @change="applyParams"
        >
      </div>

      <div class="param-item">
        <div class="param-label-row">
          <div class="param-name-block">
            <span class="param-name-zh" title="用于静态压线及同一次接触的清除判定，不影响动态跨线触发时刻">静态压线距离容忍</span>
            <span class="param-name-en">LINE_OCCUPY_DISTANCE_TOLERANCE</span>
          </div>
          <span class="param-value">{{ params.LINE_OCCUPY_DISTANCE_TOLERANCE.toFixed(3) }}</span>
        </div>
        <input
          v-model.number="params.LINE_OCCUPY_DISTANCE_TOLERANCE"
          type="range"
          min="0"
          max="0.02"
          step="0.001"
          @change="applyParams"
        >
      </div>

      <div class="param-item">
        <div class="param-label-row">
          <div class="param-name-block">
            <span class="param-name-zh" title="底边中央带到线的绝对距离上限，避免大车阈值过宽">中央带距离上限</span>
            <span class="param-name-en">LINE_OCCUPY_CENTER_DISTANCE_MAX</span>
          </div>
          <span class="param-value">{{ params.LINE_OCCUPY_CENTER_DISTANCE_MAX.toFixed(3) }}</span>
        </div>
        <input
          v-model.number="params.LINE_OCCUPY_CENTER_DISTANCE_MAX"
          type="range"
          min="0.004"
          max="0.03"
          step="0.001"
          @change="applyParams"
        >
      </div>

      <div class="param-item">
        <div class="param-label-row">
          <div class="param-name-block">
            <span class="param-name-zh" title="bbox 与 polygon 重叠面积 / bbox 面积 ≥ 此值判为 fully-inside">完全侵入面积阈值</span>
            <span class="param-name-en">POLYGON_OVERLAP_T_FULL</span>
          </div>
          <span class="param-value">{{ (params.POLYGON_OVERLAP_T_FULL * 100).toFixed(0) }}%</span>
        </div>
        <input
          v-model.number="params.POLYGON_OVERLAP_T_FULL"
          type="range"
          min="0.3"
          max="1"
          step="0.05"
          @change="applyParams"
        >
      </div>

      <div class="param-item">
        <div class="param-label-row">
          <div class="param-name-block">
            <span class="param-name-zh" title="polygon 从相交回到 disjoint 的离开去抖窗口">离开导流线去抖</span>
            <span class="param-name-en">POLYGON_OVERLAP_DEBOUNCE_MS</span>
          </div>
          <span class="param-value">{{ params.POLYGON_OVERLAP_DEBOUNCE_MS }}ms</span>
        </div>
        <input
          v-model.number="params.POLYGON_OVERLAP_DEBOUNCE_MS"
          type="range"
          min="0"
          max="1000"
          step="50"
          @change="applyParams"
        >
      </div>

      <div class="param-item">
        <div class="param-label-row">
          <div class="param-name-block">
            <span class="param-name-zh" title="已上报 episode 需连续明确清除此时长后才允许重新上报">episode 清除时长</span>
            <span class="param-name-en">EPISODE_CLEAR_MS</span>
          </div>
          <span class="param-value">{{ params.EPISODE_CLEAR_MS }}ms</span>
        </div>
        <input
          v-model.number="params.EPISODE_CLEAR_MS"
          type="range"
          min="200"
          max="5000"
          step="100"
          @change="applyParams"
        >
      </div>

      <div class="param-section-title">
        仿真数据源扰动
      </div>

      <div class="param-item" :class="{ disabled: sourceControls.positionSigma === 0 }">
        <div class="param-label-row">
          <div class="param-name-block">
            <span class="param-name-zh" title="对 bbox 中心点施加高斯噪声，单位为归一化画面坐标">位置噪声 σ</span>
            <span class="param-name-en">positionSigma</span>
          </div>
          <span class="param-value">{{ sourceControls.positionSigma.toFixed(3) }}</span>
        </div>
        <input
          v-model.number="sourceControls.positionSigma"
          type="range"
          min="0"
          max="0.02"
          step="0.001"
          @change="applySourceControls"
        >
      </div>

      <div class="param-item" :class="{ disabled: sourceControls.sizeSigma === 0 }">
        <div class="param-label-row">
          <div class="param-name-block">
            <span class="param-name-zh" title="对 bbox 宽高施加高斯噪声，单位为归一化画面坐标">尺寸噪声 σ</span>
            <span class="param-name-en">sizeSigma</span>
          </div>
          <span class="param-value">{{ sourceControls.sizeSigma.toFixed(3) }}</span>
        </div>
        <input
          v-model.number="sourceControls.sizeSigma"
          type="range"
          min="0"
          max="0.02"
          step="0.001"
          @change="applySourceControls"
        >
      </div>

      <div class="param-item" :class="{ disabled: sourceControls.dropoutRate === 0 }">
        <div class="param-label-row">
          <div class="param-name-block">
            <span class="param-name-zh" title="按帧随机丢弃 bbox，模拟 AI 漏检">漏检概率</span>
            <span class="param-name-en">dropoutRate</span>
          </div>
          <span class="param-value">{{ (sourceControls.dropoutRate * 100).toFixed(0) }}%</span>
        </div>
        <input
          v-model.number="sourceControls.dropoutRate"
          type="range"
          min="0"
          max="0.2"
          step="0.01"
          @change="applySourceControls"
        >
      </div>

      <div class="param-item">
        <div class="param-label-row">
          <div class="param-name-block">
            <span class="param-name-zh" title="覆盖所有合成 bbox 的语义状态，用于验证生产白名单过滤；LOST 会被过滤，NOT_CONFIDENT / REDETECTED 仍参与判定">语义状态覆盖</span>
            <span class="param-name-en">stateOverride</span>
          </div>
          <span class="param-value">{{ sourceControls.stateOverride ?? '按场景' }}</span>
        </div>
        <select
          :value="sourceControls.stateOverride ?? ''"
          class="state-select"
          @change="handleStateOverrideChange"
        >
          <option value="">按场景</option>
          <option value="tracked">tracked</option>
          <option value="not-confident">not-confident</option>
          <option value="lost">lost</option>
          <option value="redetected">redetected</option>
        </select>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { defineComponent, toRaw, type PropType } from 'vue'
import type { SimRunner } from '../sim/runner'

export default defineComponent({
  name: 'SimParamsPanel',
  props: {
    runner: {
      type: Object as PropType<SimRunner>,
      required: true,
    },
  },
  setup (props) {
    const params = props.runner.params
    const sourceControls = props.runner.sourceControls

    const applyParams = () => {
      // 滑块可能产生 NaN（清空输入），重建 core 前先过滤非法值
      for (const key of Object.keys(params) as Array<keyof typeof params>) {
        if (!Number.isFinite(params[key])) params[key] = 0
      }
      props.runner.recreateCore()
      props.runner.reset()
    }

    const applySourceControls = () => {
      props.runner.applySourceControls()
    }

    const resetParams = () => {
      props.runner.resetParams()
    }

    const handleStateOverrideChange = (e: Event) => {
      const value = (e.target as HTMLSelectElement).value
      sourceControls.stateOverride = value === '' ? null : value
      props.runner.applySourceControls()
    }

    return {
      params,
      sourceControls,
      toRaw,
      applyParams,
      applySourceControls,
      resetParams,
      handleStateOverrideChange,
    }
  },
})
</script>

<style scoped>
.sim-params-panel {
  flex: 0 1 auto;
  min-height: 0;
  max-height: min(34vh, 320px);
  background-color: rgba(17, 17, 17, 0.76);
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(8px);
}

.panel-header {
  padding: 7px 9px;
  border-bottom: 1px solid rgba(45, 55, 72, 0.86);
  background-color: rgba(17, 21, 29, 0.78);
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-top-left-radius: 6px;
  border-top-right-radius: 6px;
}

.panel-header h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: #e2e8f0;
}

.reset-btn {
  font-size: 10px;
  background-color: #242f41;
  border: 1px solid #3b4d6b;
  color: #cbd5e1;
  border-radius: 4px;
  padding: 3px 8px;
  cursor: pointer;
}

.reset-btn:hover {
  background-color: #2d3f59;
  color: #fff;
  border-color: #4b6285;
}

.panel-body {
  flex: 0 1 auto;
  min-height: 0;
  padding: 7px 9px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: none;
  overflow-y: auto;
}

.param-item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  transition: opacity 0.2s;
}

.param-item.disabled {
  opacity: 0.5;
}

.param-item input[type="range"] {
  width: 100%;
  margin: 1px 0 4px 0;
  accent-color: #3b82f6;
  height: 14px;
  cursor: pointer;
}

.param-section-title {
  margin-top: 3px;
  padding-top: 6px;
  border-top: 1px solid rgba(45, 55, 72, 0.7);
  color: #94a3b8;
  font-size: 11px;
  font-weight: 600;
}

.param-label-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  font-size: 11px;
}

.param-name-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.param-name-zh {
  color: #e2e8f0;
  font-weight: 500;
  font-size: 11.5px;
  cursor: help;
  border-bottom: 1px dashed #4a5568;
  width: fit-content;
}

.param-name-en {
  color: #718096;
  font-size: 9px;
  font-family: monospace;
}

.param-value {
  color: #3182ce;
  font-weight: 600;
  font-size: 11.5px;
  font-family: monospace;
}

.state-select {
  width: 100%;
  margin-top: 3px;
  background-color: rgba(17, 21, 29, 0.94);
  border: 1px solid #2d3748;
  color: #e2e8f0;
  border-radius: 4px;
  padding: 3px 6px;
  font-size: 11px;
  cursor: pointer;
}

.state-select:hover {
  border-color: #3b82f6;
}

.state-select option {
  background-color: #1a1f29;
  color: #94a3b8;
}
</style>
