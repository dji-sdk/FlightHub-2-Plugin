<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <section
    :class="['teach-dialog', `teach-dialog-${state.kind}`]"
    data-plugin-view="wayline-teach-dialog"
  >
    <template v-if="state.kind === 'conflict'">
      <div class="dialog-body conflict-body">
        <span class="warning-mark">!</span>
        <h2>发现未完成的示教路线</h2>
        <p>“{{ state.routeName || '未命名路线' }}”已有 {{ state.waypointCount }} 个航点。</p>
        <p v-if="state.createdAt" class="muted">开始时间：{{ state.createdAt }}</p>
        <p class="muted">加载后继续本次录点，或删除旧路线后重新开始。</p>
        <p
          v-if="state.confirmingRecreate"
          class="danger-hint"
        >
          已录的 {{ state.waypointCount }} 个航点和截图将被删除，且无法恢复。
        </p>
        <p v-if="state.error" class="error">{{ state.error }}</p>
      </div>
      <footer class="dialog-actions conflict-actions">
        <button
          :disabled="state.pending"
          @click="run(client.cancel)"
        >
          取消
        </button>
        <button
          class="danger"
          :disabled="state.pending"
          @click="run(state.confirmingRecreate ? client.recreate : client.requestRecreate)"
        >
          {{ state.confirmingRecreate ? '确认删除重建' : '删除重建' }}
        </button>
        <button
          v-if="!state.confirmingRecreate"
          class="primary"
          :disabled="state.pending"
          @click="run(client.loadExisting)"
        >
          加载已有
        </button>
      </footer>
    </template>

    <template v-else>
      <main class="confirm-body">
        <div v-if="state.waypoints.length === 0" class="empty-state">暂无航点</div>
        <div v-else class="waypoint-grid">
          <article
            v-for="waypoint in state.waypoints"
            :key="waypoint.id"
            class="waypoint-card"
            :class="{ 'waypoint-card-error': waypoint.screenshotError, 'waypoint-card-unselected': !waypoint.selected }"
            :style="waypoint.screenshotUrl ? { backgroundImage: `url(${waypoint.screenshotUrl})` } : undefined"
          >
            <div class="waypoint-card-top">
              <strong>航点{{ waypoint.seq + 1 }}</strong>
              <span v-if="waypoint.aiRecognitionOn" class="ai-badge">
                AI
                <span class="ai-popover">
                  <span
                    v-for="target in aiTargets"
                    :key="target.value"
                    :class="{ active: waypoint.aiTargetTypes.includes(target.value) }"
                  >{{ target.label }}</span>
                </span>
              </span>
            </div>

            <div v-if="!waypoint.screenshotUrl && !waypoint.screenshotError" class="waypoint-placeholder">
              {{ waypoint.seq + 1 }}
            </div>
            <div v-if="waypoint.screenshotError" class="screenshot-error">
              <span>截图失败</span>
              <button
                :disabled="state.pending"
                @click.stop="run(() => client.retryScreenshot({ waypointId: waypoint.id }))"
              >
                重新截图
              </button>
            </div>

            <div class="waypoint-card-bottom">
              <button
                class="card-checkbox"
                :class="{ unchecked: !waypoint.selected }"
                :disabled="state.pending"
                :aria-label="waypoint.selected ? '取消选择航点' : '选择航点'"
                @click.stop="toggleWaypoint(waypoint.id, !waypoint.selected)"
              >
                <svg v-if="waypoint.selected" viewBox="0 0 8 6" aria-hidden="true">
                  <path d="M1.28 3.048A.75.75 0 0 0 .22 4.109l1.166 1.166c.396.397.594.595.823.669.201.065.417.065.618 0 .228-.074.426-.272.822-.669L7.644 1.28A.75.75 0 0 0 6.584.22L2.518 4.286 1.28 3.048Z" />
                </svg>
              </button>
              <div class="card-actions">
                <button
                  v-if="waypoint.screenshotUrl"
                  class="card-action fullscreen"
                  aria-label="全屏查看航点截图"
                  @click.stop="previewUrl = waypoint.screenshotUrl"
                >
                  <svg viewBox="0 0 14 14" aria-hidden="true">
                    <path d="M13.3 4.7H12V1.3H8.7V0h4.6v4.7ZM4.7 0v1.3H1.3v3.4H0V0h4.7Zm8.6 13.3H8.7V12H12V8.7h1.3v4.6ZM0 13.3V8.7h1.3V12h3.4v1.3H0Z" />
                  </svg>
                </button>
              </div>
            </div>
          </article>
        </div>
      </main>

      <footer class="confirm-footer">
        <div class="settings">
          <label class="settings-row">
            <span>航线名称</span>
            <input
              v-model="name"
              maxlength="100"
              placeholder="请输入航线名称"
            >
          </label>
          <div class="settings-row speed-row">
            <label>
              <span>全局速度 (m/s)</span>
              <input
                v-model.number="globalSpeed"
                type="number"
                min="0.1"
                max="15"
                step="0.5"
              >
            </label>
            <i />
            <label>
              <span>航点速度 (m/s)</span>
              <input
                v-model.number="waypointSpeed"
                type="number"
                min="0.1"
                max="15"
                step="0.5"
              >
            </label>
          </div>
          <div class="footer-hint">
            <span>已选 {{ state.selectedCount }}/{{ state.waypoints.length }} 个航点</span>
            <span>截图 {{ quotaText }}</span>
          </div>
          <p class="irreversible">生成后航点将被清除，不能再修改速度、焦距或选中状态。</p>
          <p v-if="validationMessage || state.error" class="error">{{ state.error || validationMessage }}</p>
        </div>
        <button
          class="generate-button"
          :disabled="!canGenerate"
          @click="submitGenerate"
        >
          <span v-if="state.pending" class="spinner" />
          {{ state.pending ? '生成中...' : '生成航线' }}
        </button>
      </footer>
    </template>

    <div v-if="previewUrl" class="image-preview" @click="previewUrl = null">
      <button aria-label="关闭图片预览" @click="previewUrl = null">×</button>
      <img :src="previewUrl" alt="航点截图预览">
    </div>
  </section>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import type { Disposable } from 'fh2-plugin-sdk'
import type { TeachDialogClient, TeachDialogState } from './contract'

const props = defineProps<{ client: TeachDialogClient }>()
const client = props.client
const state = shallowRef<TeachDialogState>({
  kind: 'generate',
  defaultName: '',
  defaultGlobalSpeed: 15,
  defaultWaypointSpeed: 5,
  selectedCount: 0,
  screenshotBytes: 0,
  screenshotQuotaBytes: 80 * 1024 * 1024,
  waypoints: [],
  pending: false,
  error: null,
})
const name = ref('')
// 默认名称/速度只在进入 generate 态时填充一次。
// 不能用「名称为空」判断首次填充：弹窗打开期间状态流会持续推送
// （航点勾选、截图上传进度、pending/error 等），若按空名称回填，
// 用户用 BACKSPACE 清空默认航线名称后会被立刻填回，无法输入自定义名称。
let defaultsApplied = false
const globalSpeed = ref(15)
const waypointSpeed = ref(5)
const previewUrl = ref<string | null>(null)
const aiTargets = [
  { value: 'person', label: '人' },
  { value: 'car', label: '车' },
  { value: 'boat', label: '船' },
] as const
let subscription: Disposable | undefined

const quotaText = computed(() => state.value.kind === 'generate'
  ? `${(state.value.screenshotBytes / 1024 / 1024).toFixed(1)} / ${(state.value.screenshotQuotaBytes / 1024 / 1024).toFixed(0)}MB`
  : '')
const validationMessage = computed(() => {
  if (state.value.kind !== 'generate') return ''
  const trimmedName = name.value.trim()
  if (!trimmedName || trimmedName.length > 100) return '航线名称必须为 1 至 100 个字符'
  if (!validSpeed(globalSpeed.value) || !validSpeed(waypointSpeed.value)) return '速度必须在 0.1 至 15m/s 之间'
  if (state.value.selectedCount < 2) return '至少选择两个航点才能生成航线'
  return ''
})
const canGenerate = computed(() => state.value.kind === 'generate'
  && !state.value.pending && validationMessage.value === '')

onMounted(() => {
  subscription = client.state.subscribe((value) => {
    const enteringGenerate = value.kind === 'generate' && state.value.kind !== 'generate'
    state.value = value
    if (value.kind === 'generate' && (enteringGenerate || !defaultsApplied)) {
      // 首次进入 generate 态（含同一实例从冲突态切入）时应用一次默认值，
      // 之后的任意状态推送都不再回填，保证用户清空或自定义的输入不被覆盖。
      defaultsApplied = true
      name.value = value.defaultName
      globalSpeed.value = value.defaultGlobalSpeed
      waypointSpeed.value = value.defaultWaypointSpeed
    }
  })
})
onUnmounted(() => subscription?.dispose())

function validSpeed (value: number): boolean {
  return Number.isFinite(value) && value >= 0.1 && value <= 15
}

function toggleWaypoint (waypointId: string, selected: boolean): void {
  run(() => client.setWaypointSelected({ waypointId, selected }))
}

function submitGenerate (): void {
  if (!canGenerate.value) return
  run(() => client.generate({
    name: name.value,
    globalSpeed: globalSpeed.value,
    waypointSpeed: waypointSpeed.value,
  }))
}

function run (action: () => unknown): void {
  const result = action()
  if (result instanceof Promise) result.catch(() => {})
}
</script>

<style scoped>
.teach-dialog { position: relative; display: flex; flex-direction: column; width: 100%; height: 552px; overflow: hidden; color: #fff; background: #161616; font: 14px/1.5 "Open Sans", "PingFang SC", sans-serif; }
.teach-dialog * { box-sizing: border-box; }
.teach-dialog-conflict { height: 330px; }
.confirm-body { display: flex; flex: 1; min-height: 0; flex-direction: column; background: #161616; }
.empty-state { display: flex; flex: 1; align-items: center; justify-content: center; color: rgba(255,255,255,.45); }
.waypoint-grid { display: grid; flex: 1; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 12px; min-height: 0; padding: 20px 32px; overflow-y: auto; }
.waypoint-grid::-webkit-scrollbar { width: 6px; }.waypoint-grid::-webkit-scrollbar-thumb { background: rgba(255,255,255,.2); border-radius: 3px; }
.waypoint-card { position: relative; height: 130px; overflow: hidden; background: linear-gradient(135deg,#2a2a2a,#1a1a1a); background-position: center; background-size: cover; border-radius: 4px; box-shadow: inset 0 0 0 1px rgba(255,255,255,.15); transition: opacity .15s,box-shadow .15s; }
.waypoint-card-unselected { opacity: .55; }.waypoint-card-error { box-shadow: inset 0 0 0 1px rgba(239,98,107,.9); }
.waypoint-card-top { position: absolute; top: 0; right: 0; left: 0; z-index: 3; display: flex; align-items: center; justify-content: space-between; padding: 4px 8px; background: linear-gradient(180deg,rgba(0,0,0,.65),transparent); }
.waypoint-card-top strong { font-size: 12px; line-height: 20px; text-shadow: 0 1px 2px rgba(0,0,0,.6); }
.ai-badge { position: relative; padding: 2px 5px; color: #fff; cursor: default; background: #bc90f2; border-radius: 2px; font-size: 10px; font-weight: 700; line-height: 1; }
.ai-popover { position: absolute; top: 22px; right: 0; display: none; gap: 5px; padding: 6px; background: #292929; border: 1px solid rgba(255,255,255,.12); border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,.35); }
.ai-badge:hover .ai-popover { display: flex; }.ai-popover span { display: grid; place-items: center; width: 22px; height: 22px; color: rgba(255,255,255,.3); background: #1d1d1d; border-radius: 3px; }.ai-popover span.active { color: #00ee8b; }
.waypoint-placeholder { position: absolute; inset: 0; display: grid; place-items: center; color: rgba(255,255,255,.3); font-size: 28px; font-weight: 600; }
.screenshot-error { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 6px; align-items: center; justify-content: center; color: #ff9da3; background: rgba(22,10,12,.72); font-size: 12px; }
.screenshot-error button { padding: 3px 9px; color: #ffb86a; cursor: pointer; background: rgba(255,184,106,.1); border: 1px solid rgba(255,184,106,.45); border-radius: 3px; }
.waypoint-card-bottom { position: absolute; right: 0; bottom: 0; left: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; padding: 12px 8px 6px; background: linear-gradient(0deg,rgba(0,0,0,.78),transparent); }
.card-checkbox { display: flex; align-items: center; justify-content: center; width: 14px; height: 14px; padding: 0; cursor: pointer; background: #0075ff; border: 0; border-radius: 2px; }.card-checkbox.unchecked { background: transparent; border: 1px solid rgba(255,255,255,.4); }.card-checkbox svg { width: 8px; height: 6px; fill: #fff; }
.card-actions { display: flex; gap: 8px; align-items: center; }.card-action { padding: 0; color: #fff; cursor: pointer; background: transparent; border: 0; font-size: 11px; }.fullscreen { display: flex; }.fullscreen svg { width: 14px; height: 14px; fill: #fff; }
.confirm-footer { display: flex; flex-shrink: 0; gap: 24px; align-items: flex-end; justify-content: space-between; padding: 14px 32px 16px; background: #1b1b1b; border-top: 1px solid rgba(255,255,255,.08); }
.settings { display: flex; flex-direction: column; gap: 9px; width: 67%; min-width: 0; }.settings-row { display: flex; gap: 10px; align-items: center; min-height: 32px; }.settings-row > span,.speed-row label > span { color: rgba(255,255,255,.82); white-space: nowrap; }.settings-row > input { flex: 1; min-width: 0; }.settings input { box-sizing: border-box; height: 32px; padding: 0 9px; color: #fff; background: #252525; border: 1px solid rgba(255,255,255,.15); border-radius: 4px; outline: none; }.settings input:focus { border-color: #0075ff; }
.speed-row label { display: flex; flex: 1; gap: 8px; align-items: center; min-width: 0; }.speed-row label input { flex: 1; min-width: 0; }.speed-row i { width: 1px; height: 16px; background: rgba(255,255,255,.15); }
.footer-hint { display: flex; justify-content: space-between; color: rgba(255,255,255,.45); font-size: 11px; }.irreversible,.error { margin: 0; font-size: 11px; }.irreversible { color: #ffbd71; }.error { color: #ff6d75; }
.generate-button { width: 160px; height: 34px; color: #fff; cursor: pointer; background: #0075ff; border: 0; border-radius: 4px; }.generate-button:disabled { cursor: not-allowed; opacity: .45; }
.spinner { display: inline-block; width: 12px; height: 12px; margin-right: 5px; vertical-align: -2px; border: 1px solid rgba(255,255,255,.35); border-top-color: #fff; border-radius: 50%; animation: spin .8s linear infinite; }
.dialog-body { flex: 1; padding: 28px 32px; }.conflict-body { text-align: center; }.warning-mark { display: inline-grid; place-items: center; width: 42px; height: 42px; margin-top: 62px; color: #18130b; background: #ffb43c; border-radius: 50%; font-size: 26px; font-weight: 700; }.conflict-body h2 { margin: 14px 0 18px; font-size: 20px; }.conflict-body p { margin: 6px 0; }.muted { color: rgba(255,255,255,.55); }.danger-hint { color: #ff9da3; }
.dialog-actions { display: flex; flex-shrink: 0; gap: 10px; justify-content: flex-end; padding: 14px 20px; background: #1b1b1b; border-top: 1px solid rgba(255,255,255,.08); }.dialog-actions button { min-width: 108px; height: 34px; color: #fff; cursor: pointer; background: #293441; border: 0; border-radius: 4px; }.dialog-actions button:disabled { cursor: not-allowed; opacity: .45; }.dialog-actions .primary { background: #0075ff; }.dialog-actions .danger { color: #ff7b82; background: rgba(222,49,58,.14); }.conflict-actions { justify-content: center; }
.image-preview { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.88); }.image-preview img { max-width: 90vw; max-height: 90vh; object-fit: contain; }.image-preview > button { position: absolute; top: 20px; right: 24px; color: #fff; cursor: pointer; background: transparent; border: 0; font-size: 32px; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
