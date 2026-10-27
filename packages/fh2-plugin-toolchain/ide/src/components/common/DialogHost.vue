<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { NButton, NCheckbox, NInput, NModal, NSelect, NTree } from 'naive-ui'
import type { TreeOption } from 'naive-ui'
import { computed, h, nextTick, reactive, ref, watch } from 'vue'
import type { VNode } from 'vue'
import { closeDialog, dialogState } from '../../services/dialog'
import type { DialogMemberNode, DialogMembersField } from '../../services/dialog'
import PairRowsField from './PairRowsField.vue'

/**
 * 全局唯一的对话框渲染器：读 dialogState() 的当前 spec，
 * 提交/取消都走 closeDialog。外壳交给 NModal 的 card preset（标题/关闭/圆角/阴影）。
 * 每个新 spec 重建表单状态并聚焦首个输入。
 */

const state = dialogState()
const spec = computed(() => state.current?.spec ?? null)

const values = reactive<Record<string, string | boolean | Record<string, string>>>({})
/** members 字段：选中叶子 id 集合（null = 全选态未动过）。 */
const memberChecks = reactive<Record<string, string[] | null>>({})
const error = ref('')
const card = ref<HTMLElement | null>(null)

/**
 * NTree 选项：递归成员树 —— 叶子 key = 成员限定 id（提交值）；
 * 分支 key 加 `node:` 前缀（仅展示，不参与提交，勾选回调里被过滤）。
 */
/**
 * DAG-004-01：label 里的「id —— 描述」拆成两个文本节点渲染 —— id 单独成元素
 * 才能被自动化/无障碍按精确文本寻址；整串拼接在同一个文本节点里，精确匹配永远
 * 落空。视觉不变，仅 DOM 结构拆分。
 */
function renderSelectLabel (option: { label?: string }): VNode {
  const label = option.label ?? ''
  const separator = label.indexOf(' —— ')
  if (separator < 0) return h('span', null, label)
  return h('span', { class: 'dialog-select-option' }, [
    h('span', { class: 'dialog-select-option-id' }, label.slice(0, separator)),
    h('span', { class: 'dialog-select-option-desc' }, label.slice(separator)),
  ])
}

function memberTreeOptions (field: DialogMembersField): TreeOption[] {
  return field.tree.map(node => toTreeOption(node))
}

function toTreeOption (node: DialogMemberNode): TreeOption {
  return node.children.length === 0
    ? { key: node.id, label: node.label }
    : { key: `node:${node.id}`, label: node.label, children: node.children.map(child => toTreeOption(child)) }
}

/** 树内全部叶子 id（默认勾选）与分支 key（默认展开）。 */
function memberLeafIds (field: DialogMembersField): string[] {
  const leaves: string[] = []
  const walk = (nodes: readonly DialogMemberNode[]): void => {
    for (const node of nodes) {
      if (node.children.length === 0) leaves.push(node.id)
      else walk(node.children)
    }
  }
  walk(field.tree)
  return leaves
}

function memberBranchKeys (field: DialogMembersField): string[] {
  const keys: string[] = []
  const walk = (nodes: readonly DialogMemberNode[]): void => {
    for (const node of nodes) {
      if (node.children.length === 0) continue
      keys.push(`node:${node.id}`)
      walk(node.children)
    }
  }
  walk(field.tree)
  return keys
}

/** 受控 checked-keys：叶子 id 集合（含非受控初值归一化，全选默认）。 */
function memberCheckedKeys (field: DialogMembersField): string[] {
  const stored = memberChecks[field.name]
  if (Array.isArray(stored)) return stored
  const initial = field.value === undefined ? null : [...field.value]
  if (initial === null) return memberLeafIds(field)
  return initial
}

/** 新对话框打开时：清掉上一个表单的残留值、回到 spec 默认，再聚焦首个输入。 */
watch(() => state.current?.id ?? null, (id) => {
  error.value = ''
  for (const key of Object.keys(values)) delete values[key]
  for (const key of Object.keys(memberChecks)) delete memberChecks[key]
  for (const field of spec.value?.fields ?? []) {
    if (field.kind === 'checkbox') values[field.name] = field.value === true
    else if (field.kind === 'members') memberChecks[field.name] = field.value === undefined ? null : [...field.value]
    else if (field.kind === 'pairs') values[field.name] = { ...(field.value ?? {}) }
    else values[field.name] = field.value ?? ''
  }
  if (id === null) return
  void nextTick(() => {
    const input = card.value?.querySelector<HTMLInputElement>('input[type="text"]')
    if (input !== null && input !== undefined) {
      input.focus()
      input.select()
      return
    }
    card.value?.querySelector<HTMLElement>('.n-base-selection')?.focus()
  })
}, { immediate: true })

function dismiss (): void {
  closeDialog(null)
}

function cancel (): void {
  closeDialog(state.current?.spec.cancelResult ?? null)
}

function submit (): void {
  const current = state.current
  if (current === null) return
  const result: Record<string, string | boolean | readonly string[] | Record<string, string>> = {}
  for (const field of current.spec.fields ?? []) {
    if (field.kind === 'checkbox') {
      result[field.name] = values[field.name] === true
      continue
    }
    if (field.kind === 'members') {
      result[field.name] = memberCheckedKeys(field)
      continue
    }
    if (field.kind === 'pairs') {
      const pairs = values[field.name]
      const record = typeof pairs === 'object' && pairs !== null && !Array.isArray(pairs) ? pairs : {}
      if (field.required === true && Object.keys(record).length === 0) {
        error.value = `${field.label}要至少一条。`
        return
      }
      result[field.name] = { ...record }
      continue
    }
    const value = String(values[field.name] ?? '').trim()
    if (field.kind === 'text' && field.required === true && value === '') {
      error.value = `${field.label}不能为空。`
      card.value?.querySelector<HTMLInputElement>('input[type="text"]')?.focus()
      return
    }
    result[field.name] = value
  }
  closeDialog(result)
}

/** 文本框里回车即提交；多字段表单同理（这里没有多行输入）。 */
function onKeydown (event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault()
    submit()
  }
}
</script>

<template>
  <NModal
    v-if="spec !== null"
    :show="true"
    preset="card"
    :title="spec.title"
    size="small"
    segmented
    :mask-closable="true"
    :close-on-esc="true"
    :auto-focus="false"
    transform-origin="center"
    style="width: min(520px, calc(100vw - 48px))"
    content-style="max-height: calc(100vh - 180px); overflow: auto"
    @esc="dismiss"
    @update:show="(shown: boolean) => { if (!shown) dismiss() }"
  >
    <div ref="card" class="dialog-card" @keydown="onKeydown">
      <p v-for="(line, index) in spec.body ?? []" :key="index" class="dialog-body">
        {{ line }}
      </p>

      <template v-for="field in spec.fields ?? []" :key="field.name">
        <label v-if="field.kind === 'text'" class="dialog-field dialog-field-text">
          <span class="dialog-label">{{ field.label }}</span>
          <NInput
            v-model:value="values[field.name] as string"
            :placeholder="field.placeholder ?? ''"
            size="small"
          />
          <span v-if="field.hint !== undefined" class="dialog-hint">{{ field.hint }}</span>
        </label>

        <label v-else-if="field.kind === 'select'" class="dialog-field dialog-field-select">
          <span class="dialog-label">{{ field.label }}</span>
          <NSelect
            v-model:value="values[field.name] as string"
            :options="field.options.map(option => ({ value: option.value, label: option.label }))"
            :render-label="renderSelectLabel"
            size="small"
          />
          <span v-if="field.hint !== undefined" class="dialog-hint">{{ field.hint }}</span>
        </label>

        <!-- pairs 不用 label 包裹：多行输入里点 label 聚焦第一个框反而碍事 -->
        <div v-else-if="field.kind === 'pairs'" class="dialog-field dialog-field-pairs">
          <span class="dialog-label">{{ field.label }}<span v-if="field.required === true" class="wf-input-required">*</span></span>
          <PairRowsField
            :value="values[field.name]"
            :key-placeholder="field.keyPlaceholder ?? '键'"
            :value-placeholder="field.valuePlaceholder ?? '值'"
            add-label="＋ 条件"
            @commit="value => { values[field.name] = value }"
          />
          <span v-if="field.hint !== undefined" class="dialog-hint">{{ field.hint }}</span>
        </div>

        <div v-else-if="field.kind === 'members'" class="dialog-field dialog-field-members">
          <span class="dialog-label">{{ field.label }}</span>
          <NTree
            :data="memberTreeOptions(field)"
            checkable
            cascade
            block-line
            expand-on-click
            :default-expanded-keys="memberBranchKeys(field)"
            :checked-keys="memberCheckedKeys(field)"
            :on-update:checked-keys="(keys: Array<string | number>) => {
              memberChecks[field.name] = keys.filter((key): key is string => typeof key === 'string' && !key.startsWith('node:'))
            }"
            selectable
          />
          <span v-if="field.hint !== undefined" class="dialog-hint">{{ field.hint }}</span>
        </div>

        <label v-else class="dialog-field dialog-field-checkbox">
          <NCheckbox v-model:checked="values[field.name] as boolean" size="small" />
          <span class="dialog-label">{{ field.label }}</span>
          <span
            v-if="field.hint !== undefined"
            class="dialog-hint" :class="[{ danger: field.danger === true }]"
          >{{ field.hint }}</span>
        </label>
      </template>

      <p v-if="error !== ''" class="dialog-error">
        {{ error }}
      </p>
    </div>

    <template #footer>
      <div class="dialog-actions">
        <NButton size="small" quaternary @click="cancel">
          {{ spec.cancelLabel ?? '取消' }}
        </NButton>
        <NButton size="small" :type="spec.danger === true ? 'error' : 'primary'" @click="submit">
          {{ spec.confirmLabel ?? '确定' }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>
