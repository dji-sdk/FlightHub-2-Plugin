<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
/**
 * 启动数据（trigger.seed）多选。
 *
 * stream / bizNotify 两轴有平台固定的可携带键表 → 给复选框；
 * api / job 两轴带什么数据由作者自定 → 给逐行增删的键列表
 * （与功能契约的「一行一字段」形态一致，不再用逗号分隔文本）。
 * 这个分岔不是 UI 偏好，是 worker 语义的直接反映。
 *
 * ★ 文案不写 seed/黑板这类平台术语：开发者要回答的问题是
 * 「流程启动时能拿到哪些数据」，标签直接说这件事。
 */
import { WarningOutline } from '@vicons/ionicons5'
import { NIcon } from 'naive-ui'
import KeyListField from './KeyListField.vue'

const props = defineProps<{
  axis: string
  available: readonly string[]
  notGuaranteed: readonly string[]
  current: readonly string[]
  /** 平台已知键的值类型（stream/bizNotify 的固定键）；api/job 自定键没有。 */
  types?: Readonly<Record<string, string>> | undefined
}>()

const emit = defineEmits<{
  commit: [value: readonly string[]]
}>()

function toggle (key: string, checked: boolean): void {
  const next = checked
    ? [...props.current, key]
    : props.current.filter(existing => existing !== key)
  emit('commit', next)
}

function commitRows (rows: readonly unknown[]): void {
  // 纯键模式序列化恒为字符串数组（KeyListField 不带 types 时只产字符串）。
  emit('commit', rows as readonly string[])
}
</script>

<template>
  <div class="wf-axis-field">
    <span class="wf-axis-field-label">启动时带入工作流的数据</span>
    <template v-if="available.length === 0">
      <KeyListField
        :value="current"
        key-placeholder="eventKey"
        @commit="commitRows"
      />
      <div class="wf-section-hint">
        工作流启动时带什么数据进来由你的代码决定：键名自己起，平台没有固定清单。
      </div>
    </template>
    <div v-else class="wf-seed-list">
      <label v-for="key of available" :key="key" class="wf-seed-item">
        <input type="checkbox" :checked="current.includes(key)" @change="toggle(key, ($event.target as HTMLInputElement).checked)">
        <span>{{ key }}</span>
        <span v-if="types?.[key] !== undefined" class="wf-seed-type" title="平台保证的值类型">{{ types?.[key] }}</span>
        <NIcon
          v-if="notGuaranteed.includes(key)"
          class="wf-seed-warn"
          :component="WarningOutline"
          title="这个数据不保证每次启动都有；引用它的必填参数需要配置执行条件"
          aria-label="可能没有值"
        />
      </label>
    </div>
  </div>
</template>
