<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { AddOutline } from '@vicons/ionicons5'
import { NIcon } from 'naive-ui'
import { computed } from 'vue'
import { PALETTE_MIME, SCRIPT_MIME, useWorkflowStore } from '../store.js'
import type { ActionCatalog, FixedStepSpec, ScriptSpec } from '../../workflow/catalog'

/**
 * 左侧节点面板（P1-1 目录重构）：项目业务功能 / 平台动作 / 流程控制 三组。
 *
 * 契约 §9「画布不自创节点类型」：面板里有什么完全由受审词表与本工程清单决定，
 * 词表取不到时显式降级，而不是假装有一批节点可用。
 *
 * ★ 调用业务功能有三条入口：顶部「JS 脚本步骤」通用入口（拖入后选功能）、
 *   下方每个功能的直达条目（点击/拖拽即绑定该功能）、以及「新建业务功能」
 *   —— 不存在「先拖一个空白脚本节点再手填 action」的自由文本入口（P0-2）。
 */
const workflow = useWorkflowStore()

const catalog = computed<ActionCatalog>(() => workflow.catalog)
const enabled = computed(() => workflow.loaded)

/** 本工程已声明的业务功能（清单 scripts[]）。 */
const scripts = computed(() => catalog.value.scripts)

const activities = computed(() => catalog.value.fixedSteps.filter(step => step.kind === 'activity'))
const suspends = computed(() => catalog.value.fixedSteps.filter(step => step.kind === 'await_signal'))

interface PaletteItem {
  readonly key: string
  readonly title: string
  readonly subtitle: string
  readonly badges: readonly { text: string, tone?: 'danger' | 'warn' }[]
  readonly tooltip?: string
}

/**
 * 平台动作条目：主标题用中文名（词表携带 displayName），机器 action 是副标题。
 * 徽标只放**编排决策输入**（飞行风险 / 非幂等 / 必填数）；action 需要的
 * host capability 是平台内部实现事实，开发者不可授予也不可拒绝 ——
 * 选中节点后在检查器里可查（配置期的可追溯性），不进选择面。
 */
function fixedItem (step: FixedStepSpec): PaletteItem {
  const badges: { text: string, tone?: 'danger' | 'warn' }[] = []
  if (step.isFlight === true) badges.push({ text: '飞行', tone: 'danger' })
  if (step.nonIdempotent === true) badges.push({ text: '非幂等', tone: 'warn' })
  const required = step.inputs.filter(field => field.required === true).length
  if (required > 0) badges.push({ text: `${required} 项必填` })
  return {
    key: step.action,
    title: step.displayName ?? step.action,
    subtitle: step.action,
    badges,
    ...(step.description === undefined ? {} : { tooltip: step.description }),
  }
}

/**
 * 业务功能条目：主标题用业务说明，稳定 ID 是副标题（P1-1 展示层级）。
 * 不展示 allowlist：能力申报在清单里逐份维护、审核按插件整体足迹走，
 * 都不是「拖哪个节点进画布」的决策输入 —— 选中后检查器里可见。
 */
function scriptItem (script: ScriptSpec): PaletteItem {
  const required = script.inputs.filter(field => field.required === true).length
  const badges: { text: string, tone?: 'danger' | 'warn' }[] = []
  if (required > 0) badges.push({ text: `${required} 项必填` })
  return {
    key: script.id,
    title: script.description ?? script.id,
    subtitle: script.id,
    badges,
    ...(script.description !== undefined && script.path !== undefined
      ? { tooltip: `${script.id}（${script.path}）` }
      : {}),
  }
}

function onDragStart (event: DragEvent, action: string, scriptId?: string): void {
  // 两种 MIME 都写：自定义的那个用于识别来源，text/plain 让拖拽在
  // 部分浏览器里才会真正启动（Firefox 要求至少有一种标准类型）。
  event.dataTransfer?.setData(PALETTE_MIME, action)
  event.dataTransfer?.setData('text/plain', action)
  // 业务功能把 scriptId 一并带上：拖哪个就调哪个，落点不再弹选择框。
  if (scriptId !== undefined) event.dataTransfer?.setData(SCRIPT_MIME, scriptId)
  if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'copy'
}
</script>

<template>
  <div id="wf-palette" class="wf-palette">
    <div class="wf-palette-title">
      步骤库
    </div>

    <div v-if="!catalog.available" class="wf-palette-empty">
      平台动作目录未加载（/api/actions 不可用），暂时无法列出平台动作。可以在源码里手动添加步骤。
    </div>
    <template v-else>
      <div v-if="!enabled" class="wf-palette-empty">
        先在上方选择一个工作流文件，然后从这里把步骤拖到画布。
      </div>

      <!-- 项目业务功能：本工程自己的 JS/TS 功能。排在平台动作之前 ——
           画布主要编排插件自己的业务功能，平台动作是补充（方案 §1.1）。 -->
      <div class="wf-palette-group">
        <div class="wf-palette-group-title">
          本工程的业务功能
        </div>
        <div class="wf-palette-group-hint">
          本工程声明过的业务脚本；点击或拖入画布即可调用。复用只新增步骤，不复制脚本。
        </div>
      </div>
      <!-- 通用 JS 脚本步骤入口：不预选功能 —— 点击/拖入后由选择框决定调用哪份
           脚本（没有功能时直接引导新建）。仍无自由文本 action（P0-2 不变）。 -->
      <div
        class="wf-palette-item" :class="[{ disabled: !enabled }]"
        :draggable="enabled"
        data-kind="script-step"
        :title="`新建一个调用业务功能的步骤（${catalog.scriptAction}）`"
        @dragstart="onDragStart($event, catalog.scriptAction)"
        @click="enabled && void workflow.createStep(catalog.scriptAction)"
      >
        <div class="wf-palette-item-title">
          业务脚本步骤
        </div>
        <div class="wf-palette-item-sub">
          {{ catalog.scriptAction }}
        </div>
        <div class="wf-badges">
          <span class="wf-badge">调用业务功能</span>
        </div>
      </div>
      <div
        v-for="script of scripts"
        :key="script.id"
        class="wf-palette-item" :class="[{ disabled: !enabled }]"
        :draggable="enabled"
        data-kind="script"
        :data-script-id="script.id"
        :title="scriptItem(script).tooltip"
        @dragstart="onDragStart($event, catalog.scriptAction, script.id)"
        @click="enabled && void workflow.createScriptStep(script.id)"
      >
        <div class="wf-palette-item-title">
          {{ scriptItem(script).title }}
        </div>
        <div class="wf-palette-item-sub">
          {{ scriptItem(script).subtitle }}
        </div>
        <div v-if="scriptItem(script).badges.length > 0" class="wf-badges">
          <span
            v-for="badge of scriptItem(script).badges"
            :key="badge.text"
            class="wf-badge" :class="[badge.tone]"
          >{{ badge.text }}</span>
        </div>
      </div>
      <div v-if="scripts.length === 0" class="wf-palette-empty">
        本工程还没有业务功能，用下面的入口新建一个。
      </div>
      <button
        id="wf-new-script"
        type="button"
        class="wf-palette-item wf-palette-new"
        :disabled="!enabled"
        @click="void workflow.promptCreateScriptFunction()"
      >
        <NIcon :component="AddOutline" />
        新建业务功能
      </button>

      <!-- 平台动作：平台承诺的能力，入参/出参由受审词表约束。 -->
      <template v-if="activities.length > 0">
        <div class="wf-palette-group">
          <div class="wf-palette-group-title">
            平台动作
          </div>
          <div class="wf-palette-group-hint">
            平台提供的动作；中文名为主，机器标识见副标题。
          </div>
        </div>
        <div
          v-for="item of activities.map(fixedItem)"
          :key="item.key"
          class="wf-palette-item" :class="[{ disabled: !enabled }]"
          :draggable="enabled"
          :title="item.tooltip"
          @dragstart="onDragStart($event, item.key)"
          @click="enabled && void workflow.createStep(item.key)"
        >
          <div class="wf-palette-item-title">
            {{ item.title }}
          </div>
          <div class="wf-palette-item-sub">
            {{ item.subtitle }}
          </div>
          <div v-if="item.badges.length > 0" class="wf-badges">
            <span
              v-for="badge of item.badges"
              :key="badge.text"
              class="wf-badge" :class="[badge.tone]"
            >{{ badge.text }}</span>
          </div>
        </div>
      </template>

      <!-- 流程控制：挂起与等待。 -->
      <template v-if="suspends.length > 0">
        <div class="wf-palette-group">
          <div class="wf-palette-group-title">
            等待与回调
          </div>
          <div class="wf-palette-group-hint">
            等待人工确认或外部回调；建议设置超时，避免一直等待。
          </div>
        </div>
        <div
          v-for="item of suspends.map(fixedItem)"
          :key="item.key"
          class="wf-palette-item" :class="[{ disabled: !enabled }]"
          :draggable="enabled"
          :title="item.tooltip"
          @dragstart="onDragStart($event, item.key)"
          @click="enabled && void workflow.createStep(item.key)"
        >
          <div class="wf-palette-item-title">
            {{ item.title }}
          </div>
          <div class="wf-palette-item-sub">
            {{ item.subtitle }}
          </div>
          <div v-if="item.badges.length > 0" class="wf-badges">
            <span
              v-for="badge of item.badges"
              :key="badge.text"
              class="wf-badge" :class="[badge.tone]"
            >{{ badge.text }}</span>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>
