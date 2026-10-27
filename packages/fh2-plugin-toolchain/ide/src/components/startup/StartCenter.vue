<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { NAlert, NButton, NCheckbox, NForm, NFormItem, NInput, NProgress, NRadioButton, NRadioGroup, NSelect } from 'naive-ui'
import { computed, nextTick, ref, watch } from 'vue'
import { describeApiError, ideApi } from '../../api/client'
import { useIdeContext } from '../../composables/use-ide'
import { useStartupStore } from '../../stores/startup'
import { useTasksStore } from '../../stores/tasks'

/**
 * N3：Start Center —— 无有效工作根时的入口页，只保留「创建新工程」。
 *
 * - 新建工程（Create Wizard：ID/目录/模板 + 可选依赖安装）；
 * - 工程类型固定为全栈 Capability：单前端/后端插件的产物不能上传到平台；
 * - 勾选安装时进入「安装中」阶段（不切换工作根，避免 open 的 stopAll 取消任务），
 *   进度条 + 实时日志；成功后自动打开，失败可「仍然打开」（dev/打包会自动补装）；
 * - 创建失败可恢复（保留在 Start Center 并展示原因）。
 */
const ide = useIdeContext()
const startup = useStartupStore()
const tasks = useTasksStore()

const wizard = ref({
  pluginId: 'exp_my_plugin',
  directory: '',
  template: 'capability-fullstack',
  install: false,
  packageManager: 'npm',
})

/** 安装等待阶段：null = 未在安装；否则 taskId。 */
const installingTaskId = ref<string | null>(null)
/** 安装对应的工程根（失败「仍然打开」用）。 */
const installingProjectRoot = ref<string | null>(null)
const installFailed = ref<string | null>(null)
/** 安装日志全文（任务通道上限 300 行）；过滤 npm/pnpm 的 \r 进度噪音行。 */
const installLogs = computed(() => {
  const taskId = installingTaskId.value
  if (taskId === null) return []
  return tasks.logsOf(taskId)
    .map(line => line.replace(/^\[(stdout|stderr)\] /, ''))
    .filter(line => !isProgressNoise(line))
})

const logContainer = ref<HTMLElement | null>(null)
/** 新日志到达时自动滚动到底部（跟随最新输出）。 */
watch(installLogs, async () => {
  await nextTick()
  const container = logContainer.value
  if (container !== null) container.scrollTop = container.scrollHeight
})

/**
 * npm/pnpm 的 spinner/进度行（⠋/⸩/|/…）与百分比刷屏：原样显示是一坨乱码。
 * 保留有信息量的行（added/-error/warn/⠧ 之外的正文）。
 */
function isProgressNoise (line: string): boolean {
  if (line.includes('\r') || /\r/.test(line)) return true
  if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⸩]/u.test(line)) return true
  if (/^\s*(added|removed|changed) \d+/.test(line) === false && /(^|\s)\d+%\s/.test(line)) return true
  if (line.trim() === '' || line.trim() === '⠏') return true
  return false
}

const pluginIdError = computed(() => {
  const id = wizard.value.pluginId
  if (id === '') return 'Plugin ID 不能为空'
  if (!/^(official_|exp_)[a-z][a-z0-9_]*$/.test(id)) return '必须以 official_ 或 exp_ 开头的小写短名（字母/数字/下划线）'
  return null
})

const canCreate = computed(() => pluginIdError.value === null)

const packageManagerOptions = [
  { label: 'npm', value: 'npm' },
  { label: 'pnpm', value: 'pnpm' },
]

async function createAndOpen (): Promise<void> {
  if (!canCreate.value || startup.busy) return
  startup.setPhase('creating')
  try {
    const result = await ideApi.workspaceCreate({
      pluginId: wizard.value.pluginId,
      ...(wizard.value.directory.trim() === '' ? {} : { directory: wizard.value.directory.trim() }),
      template: wizard.value.template,
      ...(wizard.value.install ? { install: true, packageManager: wizard.value.packageManager } : {}),
    })
    if (result.installTaskId === undefined) {
      await ide.openWorkspacePath(result.projectRoot)
      return
    }
    // 安装期间不切根（stopAll 会取消任务）：进入等待视图，跟到终态再开
    installingTaskId.value = result.installTaskId
    installingProjectRoot.value = result.projectRoot
    const outcome = await ide.trackInstallTask(result.installTaskId, result.projectRoot)
    if (outcome === 'succeeded') {
      await ide.openWorkspacePath(result.projectRoot)
      return
    }
    installFailed.value = `依赖安装未完成（${outcome === 'failed' ? '失败' : '已取消'}）；工程文件已保留。`
  } catch (error) {
    startup.fail(`创建失败：${describeApiError(error)}`)
  }
}

/** 安装失败仍打开：dev/打包前置会自动补装依赖。 */
async function openAnyway (): Promise<void> {
  const root = installingProjectRoot.value
  if (root === null) return
  installFailed.value = null
  installingTaskId.value = null
  installingProjectRoot.value = null
  await ide.openWorkspacePath(root)
}
</script>

<template>
  <div class="start-center">
    <NForm class="start-card" label-placement="top" size="small">
      <h1 class="start-title">
        FH2 插件 Web IDE
      </h1>

      <!-- 安装等待 / 失败阶段 -->
      <template v-if="installingTaskId !== null">
        <template v-if="installFailed === null">
          <p class="start-subtitle">
            正在安装依赖…
          </p>
          <NProgress type="line" status="info" indeterminate :show-indicator="false" class="start-progress" />
          <div ref="logContainer" class="install-log">
            <div v-for="(line, index) in installLogs" :key="index" class="install-log-line">
              {{ line }}
            </div>
          </div>
        </template>

        <template v-else>
          <NAlert type="warning" :show-icon="false" class="start-alert">
            {{ installFailed }}
          </NAlert>
          <p class="start-subtitle">
            可以仍然打开工程继续 —— 运行 dev / 打包时会自动重新安装依赖。
          </p>
          <NButton type="primary" block @click="void openAnyway()">
            仍然打开
          </NButton>
        </template>
      </template>

      <!-- 创建向导 -->
      <template v-else>
        <p class="start-subtitle">
          当前服务未绑定可识别的插件工程。从这里创建一个新的。
        </p>

        <NAlert v-if="startup.startupError !== null" type="error" :show-icon="false" class="start-alert">
          {{ startup.startupError }}
        </NAlert>

        <NFormItem
          label="Plugin ID"
          v-bind="pluginIdError === null ? {} : { feedback: pluginIdError, validationStatus: 'error' as const }"
        >
          <NInput v-model:value="wizard.pluginId" placeholder="exp_my_plugin" :disabled="startup.busy" />
        </NFormItem>

        <NFormItem label="目录名">
          <NInput v-model:value="wizard.directory" placeholder="默认 = Plugin ID，创建在当前工作根下" :disabled="startup.busy" />
        </NFormItem>

        <NFormItem label="工程类型">
          <NRadioGroup v-model:value="wizard.template">
            <NRadioButton value="capability-fullstack">
              全栈（前后端 Capability）
            </NRadioButton>
          </NRadioGroup>
        </NFormItem>

        <NFormItem label="依赖">
          <NCheckbox v-model:checked="wizard.install" :disabled="startup.busy">
            创建后立即安装依赖（失败可重试；不影响已生成的工程文件）
          </NCheckbox>
        </NFormItem>

        <NFormItem v-if="wizard.install" label="包管理器">
          <NSelect v-model:value="wizard.packageManager" :options="packageManagerOptions" :disabled="startup.busy" style="width: 160px" />
        </NFormItem>

        <NButton type="primary" block :loading="startup.phase === 'creating'" :disabled="!canCreate || startup.busy" @click="void createAndOpen()">
          创建并打开
        </NButton>
      </template>
    </NForm>
  </div>
</template>

<style scoped>
.start-center {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  overflow: auto;
  background: var(--bg);
  z-index: 20;
  padding: 48px 16px;
}

.start-card {
  width: min(560px, 94vw);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 28px 32px;
}

.start-title {
  margin: 0 0 4px;
  font-size: 22px;
  color: var(--fg-strong);
}

.start-subtitle {
  margin: 0 0 20px;
  font-size: 13px;
  color: var(--fg-muted);
}

.start-alert {
  margin-bottom: 16px;
}

.start-progress {
  margin: 12px 0;
}

/* 安装实时日志：全量滚动查看（npm 安装输出上百行），自动跟随底部 */
.install-log {
  height: 280px;
  overflow: auto;
  background: var(--bg);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  padding: 8px 10px;
}

.install-log-line {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.6;
  color: var(--fg);
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
