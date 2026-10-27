<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { computed, ref, watch } from 'vue'

/**
 * 键列表的行式编辑器（无标签，调用方自己排版标题）。
 *
 * 统一「一行一个键、可增删」的填写形态（用户 2026-09-21 确认）：
 * 等待与回调的 provides / optional / interruptedBy、启动数据的 seed。
 * 之前这些字段是「xxx,xxx,xxx」逗号分隔文本框 —— 隐藏约定靠猜，
 * 与功能契约（一行一字段）的形态也不一致。
 *
 * ★ provides/optional 的两种 worker 写法（schema `provided` 的 anyOf）：
 *   裸字符串数组 `["k"]`（不约束类型）与对象数组 `[{key,type}]`。
 *   序列化规则跟着 schema 的「整体形态统一」走：
 *   - 所有行都没选类型 → 写裸字符串数组（原形态保持，不无端升形态）；
 *   - 任一行选了类型 → 统一写对象形态，没选类型的行只写 `{key}`
 *     （schema 里 type 是可选属性 —— 不替用户编一个类型出来）。
 *
 * ★ 空行保留在本地草稿里继续编辑，序列化时丢弃：一次「添加键」点击
 *   不该把半配置写进文档（上层是整字段替换命令）。
 */

interface KeyRow {
  key: string
  type: string
}

const props = defineProps<{
  /** 当前值：裸字符串 / `{key,type}` 对象两种形态的数组。 */
  value: readonly unknown[]
  /** 非空 = 每行带类型下拉；词表与功能契约同源（language.providedTypes）。 */
  types?: readonly string[]
  keyPlaceholder?: string
  addLabel?: string
}>()

const emit = defineEmits<{
  commit: [value: readonly unknown[]]
}>()

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toRows (value: readonly unknown[]): KeyRow[] {
  const rows: KeyRow[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      rows.push({ key: item, type: '' })
    } else if (isRecord(item) && typeof item.key === 'string') {
      rows.push({ key: item.key, type: typeof item.type === 'string' ? item.type : '' })
    }
  }
  return rows
}

const rows = ref<KeyRow[]>(toRows(props.value))

const typed = computed(() => (props.types?.length ?? 0) > 0)

/** 草稿 → 提交值。空键行丢弃；类型规则见组件注释 ★。 */
function serialize (next: readonly KeyRow[]): readonly unknown[] {
  const clean = next
    .map(row => ({ key: row.key.trim(), type: row.type }))
    .filter(row => row.key !== '')
  if (!typed.value || clean.every(row => row.type === '')) {
    return clean.map(row => row.key)
  }
  return clean.map(row => row.type === '' ? { key: row.key } : { key: row.key, type: row.type })
}

function commit (): void {
  emit('commit', serialize(rows.value))
}

watch(() => props.value, (value) => {
  // 外部变更（重载 / 撤销）才重建行；自己刚提交回来的等价值不动本地草稿
  // （本地可能还有没填键名的新行，等价值比较保不住它们，必须跳过）。
  if (JSON.stringify(serialize(toRows(value))) === JSON.stringify(serialize(rows.value))) return
  rows.value = toRows(value)
})

function setKey (index: number, key: string): void {
  rows.value[index]!.key = key
  commit()
}

function setType (index: number, type: string): void {
  rows.value[index]!.type = type
  commit()
}

function removeRow (index: number): void {
  rows.value.splice(index, 1)
  commit()
}

function addRow (): void {
  // 新行类型默认词表第一项（同功能契约 blankField）；不想约束可选「（不限制类型）」。
  // 只进本地草稿不提交：空键行在序列化里会被丢弃，提交了也只是空响。
  rows.value.push({ key: '', type: props.types?.[0] ?? '' })
}
</script>

<template>
  <div class="wf-key-list">
    <div v-for="(row, index) of rows" :key="index" class="wf-io-row">
      <div class="wf-io-head">
        <input
          class="wf-io-name" type="text" :value="row.key"
          :placeholder="keyPlaceholder ?? '键名'"
          @change="setKey(index, ($event.target as HTMLInputElement).value)"
          @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
        >
        <select
          v-if="typed" class="wf-io-type" :value="row.type"
          @change="setType(index, ($event.target as HTMLSelectElement).value)"
        >
          <option value="">
            （不限制类型）
          </option>
          <!-- 当前值不在词表里时显式列出，不静默改掉（同功能契约类型列的做法） -->
          <option v-if="row.type !== '' && !types!.includes(row.type)" :value="row.type">
            {{ row.type }}（不在类型列表内）
          </option>
          <option v-for="type of types" :key="type" :value="type">
            {{ type }}
          </option>
        </select>
        <button type="button" class="small danger" @click="removeRow(index)">
          删除
        </button>
      </div>
    </div>
    <button type="button" class="small ghost" @click="addRow()">
      {{ addLabel ?? '添加键' }}
    </button>
  </div>
</template>
