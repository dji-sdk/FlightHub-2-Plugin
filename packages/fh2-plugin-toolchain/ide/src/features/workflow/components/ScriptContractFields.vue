<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { blankField, isNestable } from '../script-contract.js'
import type { DraftField } from '../script-contract.js'

/**
 * 一组 I/O 字段的编辑行，**递归**渲染嵌套成员。
 *
 * ⓘ 单元格的改动直接写在草稿对象上（草稿本来就是给改的，父组件靠数组引用持有它）；
 *   增删行走 `update:fields` 换一个新数组 —— 数组本身是 prop，不在子组件里 push/splice。
 */
const props = defineProps<{
  fields: DraftField[]
  /** 出参侧不给 required 勾（worker 不读它：出参「声明即必产」）。 */
  isOutput: boolean
  /** 可选类型；空表 = 这一刻没有可依的词表，退化成自由文本。 */
  types: readonly string[]
  depth: number
}>()

const emit = defineEmits<{
  'update:fields': [value: DraftField[]]
}>()

function addField (): void {
  emit('update:fields', [...props.fields, blankField(props.types)])
}

function removeField (index: number): void {
  emit('update:fields', props.fields.filter((_unused, position) => position !== index))
}

/** 给某一行的嵌套成员换一个新数组（子层的增删由递归的那一层 emit 上来）。 */
function setNested (field: DraftField, nested: DraftField[]): void {
  field.fields = nested
}

/**
 * 改类型时，若新类型不能带嵌套成员，**不静默丢掉**已有的子字段。
 * 留着它们，由 `prepareChangeScriptIo` 在保存时明确拒绝并说清原因 ——
 * 悄悄清空等于替用户做了一个他没看见的决定。
 */
function setType (field: DraftField, type: string): void {
  field.type = type
}
</script>

<template>
  <div class="wf-io-group" :style="{ marginInlineStart: `${depth * 12}px` }">
    <div v-for="(field, index) of fields" :key="index" class="wf-io-row">
      <div class="wf-io-head">
        <input
          class="wf-io-name" type="text" :value="field.name"
          placeholder="字段名"
          @input="field.name = ($event.target as HTMLInputElement).value"
        >
        <select
          v-if="types.length > 0"
          class="wf-io-type" :value="field.type"
          @change="setType(field, ($event.target as HTMLSelectElement).value)"
        >
          <!-- 当前值不在词表里时显式列出，不静默改掉（同 action 选择器的做法） -->
          <option v-if="field.type !== '' && !types.includes(field.type)" :value="field.type">
            {{ field.type }}（不在词表内）
          </option>
          <option v-for="type of types" :key="type" :value="type">
            {{ type }}
          </option>
        </select>
        <input
          v-else
          class="wf-io-type" type="text" :value="field.type"
          placeholder="类型" title="没取到类型词表，已退化为自由文本"
          @input="field.type = ($event.target as HTMLInputElement).value"
        >
        <label v-if="!isOutput" class="wf-io-required" title="必填参数：流程那一步没有设置取值，发布时会报错">
          <input type="checkbox" :checked="field.required" @change="field.required = ($event.target as HTMLInputElement).checked">
          <span>必填</span>
        </label>
        <button
          v-if="isNestable(field.type)"
          type="button" class="small ghost"
          title="object 表示对象成员；array 表示每个元素的形状。不填 = 不限制"
          @click="setNested(field, [...field.fields, blankField(types)])"
        >
          添加成员
        </button>
        <button type="button" class="small danger" @click="removeField(index)">
          删除
        </button>
      </div>

      <!-- 嵌套成员：递归自身 -->
      <ScriptContractFields
        v-if="field.fields.length > 0"
        :fields="field.fields"
        :is-output="isOutput"
        :types="types"
        :depth="depth + 1"
        @update:fields="setNested(field, $event)"
      />
      <div v-if="field.fields.length > 0 && !isNestable(field.type)" class="wf-input-issue error">
        {{ field.name || '（未命名）' }} 是 {{ field.type }}，不能包含成员；平台会忽略标量类型上的成员配置。
        保存前请改成 object / array，或删除这些成员。
      </div>
    </div>

    <button type="button" class="small ghost" @click="addField()">
      添加字段
    </button>
  </div>
</template>
