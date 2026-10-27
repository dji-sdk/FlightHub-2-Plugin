<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { ref, watch } from 'vue'

/**
 * 「键 = 值」对的行式编辑器（无标签，调用方自己排版标题）。
 *
 * 用在两处：工作流触发器的事件筛选条件（stream.match）、对话框的 pairs 字段。
 * 值是普通对象（键→字符串），提交时机是**离散动作**（增删行 / 改完一格失焦），
 * 不逐键提交 —— 上层是「整字段替换」命令，逐键会打碎撤销栈。
 *
 * ★ 空行保留在本地草稿里继续编辑，序列化时丢弃：新增一行还没起键名，
 *   不该让一次「＋」点击就把半配置写进文档。
 */

interface PairRow {
  key: string
  value: string
}

const props = defineProps<{
  /** 当前值：键→字符串的对象（unknown 实参由调用方传入，这里只认对象形态）。 */
  value: unknown
  keyPlaceholder?: string
  valuePlaceholder?: string
  addLabel?: string
}>()

const emit = defineEmits<{
  commit: [value: Record<string, string>]
}>()

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toRows (value: unknown): PairRow[] {
  if (!isRecord(value)) return []
  return Object.entries(value).map(([key, item]) => ({ key, value: typeof item === 'string' ? item : String(item) }))
}

/** 草稿 → 提交值：空键行丢弃；重复键后行胜出（对象语义，先到的被顶掉）。 */
function serialize (rows: readonly PairRow[]): Record<string, string> {
  const next: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key === '') continue
    next[key] = row.value.trim()
  }
  return next
}

const rows = ref<PairRow[]>(toRows(props.value))

watch(() => props.value, (value) => {
  // 外部变更（重载 / 撤销）才重建行；自己刚提交回来的等价值不动本地草稿。
  if (JSON.stringify(serialize(toRows(value))) === JSON.stringify(serialize(rows.value))) return
  rows.value = toRows(value)
})

function commit (): void {
  emit('commit', serialize(rows.value))
}

function setKey (index: number, key: string): void {
  rows.value[index]!.key = key
  commit()
}

function setValue (index: number, value: string): void {
  rows.value[index]!.value = value
  commit()
}

function removeRow (index: number): void {
  rows.value.splice(index, 1)
  commit()
}

function addRow (): void {
  rows.value.push({ key: '', value: '' })
}
</script>

<template>
  <div class="wf-key-list">
    <div v-for="(row, index) of rows" :key="index" class="wf-io-row">
      <div class="wf-io-head">
        <input
          class="wf-io-name" type="text" :value="row.key"
          :placeholder="keyPlaceholder ?? '键'"
          @change="setKey(index, ($event.target as HTMLInputElement).value)"
          @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
        >
        <input
          class="wf-io-name" type="text" :value="row.value"
          :placeholder="valuePlaceholder ?? '值'"
          @change="setValue(index, ($event.target as HTMLInputElement).value)"
          @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
        >
        <button type="button" class="small danger" @click="removeRow(index)">
          删除
        </button>
      </div>
    </div>
    <button type="button" class="small ghost" @click="addRow()">
      {{ addLabel ?? '＋ 条目' }}
    </button>
  </div>
</template>
