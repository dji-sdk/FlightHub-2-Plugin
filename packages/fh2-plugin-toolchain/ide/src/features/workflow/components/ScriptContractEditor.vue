<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { computed, ref, watch } from 'vue'
import { useWorkflowStore } from '../store.js'
import { sameDraft, toDraft, toIoFields } from '../script-contract.js'
import type { DraftField } from '../script-contract.js'
import ScriptContractFields from './ScriptContractFields.vue'

/**
 * 业务功能的参数与返回结果编辑器（命令 13 ChangeScriptIO 的界面入口；P1-6 去 Worker 化）。
 *
 * ★★ 这里有一个平台语义上的**悬崖**，界面必须把它说出来：
 * `outputs` 为空**不是**「什么都不产出」，而是**透传** —— 脚本 return 什么都进黑板。
 * 一旦声明了哪怕一个出参，就翻成「只有声明过的进黑板，其余一律丢掉」。
 * 用户在这个表单里加的第一个出参，改的是整条脚本的语义，不是加一行声明。
 *
 * ⓘ 草稿 + 显式保存，不是每敲一个字符发一条命令：见 script-contract.ts 的 ★。
 */
const props = defineProps<{ scriptId: string }>()

const workflow = useWorkflowStore()

/** 清单里当前那一份（内存清单，不是磁盘）。 */
const current = computed(() => {
  void workflow.revision
  // scriptContractOf 读的是 catalog，而 catalog 已经依赖 documentsRevision ——
  // 清单一改这里就重算，不必（也没法）在这儿再读一次那个内部 ref。
  return workflow.scriptContractOf(props.scriptId)
})

const inputs = ref<DraftField[]>([])
const outputs = ref<DraftField[]>([])
const saving = ref(false)

/** 进来时（以及切换功能时）用清单填草稿。 */
function resetDraft (): void {
  const declaration = current.value
  inputs.value = toDraft(declaration?.inputs ?? [])
  outputs.value = toDraft(declaration?.outputs ?? [])
}

watch(() => props.scriptId, resetDraft, { immediate: true })

const dirty = computed(() => {
  const declaration = current.value
  return !sameDraft(inputs.value, toDraft(declaration?.inputs ?? []))
    || !sameDraft(outputs.value, toDraft(declaration?.outputs ?? []))
})

/**
 * 清单在别处被改了（比如用户直接编辑了 fh2-plugin.json）时跟着刷新。
 *
 * ⚠️ 只在草稿**没脏**时刷新：正在编辑的草稿被外部改动冲掉，用户会看着自己刚敲的
 * 字消失而不知道为什么。脏的时候宁可让两边不一致 —— 保存那一刻命令的前置核验
 * 会拿 generation 拦住，回一个「文档已变化，请重试」，那是看得懂的。
 */
watch(current, () => {
  if (!dirty.value) resetDraft()
})

const types = computed(() => workflow.catalog.ioFieldTypes)

/** 保存后会不会把这份脚本从「透传」翻成「投影」。 */
const entersProjection = computed(() =>
  (current.value?.outputs.length ?? 0) === 0 && outputs.value.length > 0)

/** 保存后会不会从「投影」翻回「透传」。 */
const entersPassthrough = computed(() =>
  (current.value?.outputs.length ?? 0) > 0 && outputs.value.length === 0)

/** 入参侧同款悬崖：原先没声明 = 整块递进去，声明之后只递声明过的那几个。 */
const inputsEnterProjection = computed(() =>
  (current.value?.inputs.length ?? 0) === 0 && inputs.value.length > 0)

async function save (): Promise<void> {
  saving.value = true
  try {
    const ok = await workflow.saveScriptContract(props.scriptId, {
      inputs: toIoFields(inputs.value),
      outputs: toIoFields(outputs.value),
    })
    // 成功后让 current 重新流进草稿（出参上的 required 会被平台剥掉，
    // 草稿要跟着变成写进清单的那一份，否则界面一直显示一个没生效的勾）。
    if (ok) resetDraft()
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="wf-section wf-contract">
    <div class="wf-section-title">
      参数与返回结果
      <span v-if="dirty" class="wf-contract-dirty" title="修改尚未应用" aria-label="修改尚未应用" />
    </div>

    <div v-if="current === null" class="wf-section-hint">
      清单里找不到 {{ scriptId }}（可能正在被编辑）。这一刻不显示声明，
      避免把「读不出来」显示成「没有声明」。
    </div>

    <template v-else>
      <div class="wf-section-hint">
        声明这份功能「接收什么参数、返回什么结果」。平台据此在发布时检查参数取值、
        在运行时按声明映射并校验。它只关心数据结构，不关心业务含义。（技术路径：<code>fh2-plugin.json</code> 的 <code>scripts[].io</code>）
      </div>

      <!-- 入参 -->
      <div class="wf-io-block">
        <div class="wf-io-title">
          脚本接收的参数
        </div>
        <div v-if="inputs.length === 0" class="wf-section-hint">
          未声明 = <strong>整块传入</strong>：这一步从上游取到的所有键都会进入 <code>input</code>
          （平台保留键除外）。不是「不传任何东西」。
        </div>
        <div v-else-if="inputsEnterProjection" class="wf-input-issue warning">
          原先没有入参声明（整块传入）。声明之后脚本只能拿到这里列出的键；
          若 JS 里读了别的键，它会变成 <code>undefined</code>，而运行时不会报错。
        </div>
        <ScriptContractFields :fields="inputs" :is-output="false" :types="types" :depth="0" @update:fields="inputs = $event" />
      </div>

      <!-- 出参 -->
      <div class="wf-io-block">
        <div class="wf-io-title">
          提供给后续步骤的结果
        </div>
        <div v-if="outputs.length === 0" class="wf-section-hint">
          未声明 = <strong>原样输出</strong>：脚本 <code>return</code> 的所有键都会交给后续步骤。
          不是「不产出任何东西」。
        </div>
        <div v-else-if="entersProjection" class="wf-input-issue warning">
          这份脚本原先<strong>没有</strong>出参声明（return 的内容都会交给下游）。保存之后只有这里列出的键会交给下游，
          其余一律丢掉；下游如果有参数引用了别的键，保存前会先列给你看。
        </div>
        <div v-else class="wf-section-hint">
          声明了就一定会产出：少产一个声明过的出参属于运行时错误。
          因此出参没有「必填」选项。
        </div>
        <div v-if="entersPassthrough" class="wf-input-issue warning">
          清空出参声明 = 回到原样输出：脚本 return 的所有键都会交给下游，包括你没打算公开的那些。
        </div>
        <ScriptContractFields :fields="outputs" :is-output="true" :types="types" :depth="0" @update:fields="outputs = $event" />
      </div>

      <div v-if="types.length === 0" class="wf-section-hint">
        类型列表未加载，类型一栏已改为自由输入。
        平台不会拦截未知类型名；写错不会报错，只会让那个字段不再做类型检查。
      </div>

      <div class="wf-contract-actions">
        <button type="button" class="small" :disabled="!dirty || saving" @click="void save()">
          应用参数与返回值
        </button>
        <button type="button" class="small ghost" :disabled="!dirty || saving" @click="resetDraft()">
          放弃修改
        </button>
        <span v-if="dirty" class="wf-section-hint">应用只改编辑器内容；顶部「保存工作流」才会写入文件。</span>
      </div>
    </template>
  </div>
</template>
