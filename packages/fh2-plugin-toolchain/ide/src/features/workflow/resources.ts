// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { ideApi } from '../../api/client.js'
import type { SchemaEntry } from '../../api/types.js'
import { useStatusStore } from '../../stores/status.js'
import { EMPTY_CATALOG, toCatalog } from './catalog.js'
import type { ActionCatalog } from './catalog.js'
import { readWorkflowSchema } from './schema.js'

export const useWorkflowResources = defineStore('workflow-resources', () => {
  const status = useStatusStore()
  let currentGeneration = 0
  const schemas = ref<readonly SchemaEntry[]>([])
  const catalog = ref<ActionCatalog>(EMPTY_CATALOG)
  /** 词表取不到时为 true —— UI 据此降级（不校验入参），而不是标红。 */
  const catalogDegraded = ref(false)
  const workflowSchema = computed(() => readWorkflowSchema(schemas.value))
  /**
   * 最近一次带工作流路径的刷新所用路径。无参刷新（IDE 启动/工程配置刷新）沿用它：
   * 多后端成员的工作区里 `resolveWorkflowManifest` 无法唯一确定成员，无参请求会拿到
   * 空 scripts —— 把画布已加载的词表覆盖成空后，每个 `run_script` 步都会误报
   * SCRIPT_MISSING + 声明外入参。切换工作区时由 reset() 清空。
   */
  let lastWorkflowPath: string | undefined
  function configure (value: readonly SchemaEntry[]): void {
    schemas.value = value
  }
  function reset (): void {
    ++currentGeneration
    lastWorkflowPath = undefined
    catalog.value = EMPTY_CATALOG
    schemas.value = []
    catalogDegraded.value = false
  }
  /**
   * 拉受审词表（契约 §9 的节点菜单数据源）。
   * 取不到不是致命错误：画布降级为「不校验入参、action 自由输入」，
   * 让整个 IDE 因为画布的数据源挂掉是不成比例的。
   */
  async function refreshCatalog (workflowPath?: string): Promise<void> {
    const generation = ++currentGeneration
    const scopedPath = workflowPath ?? lastWorkflowPath
    if (workflowPath !== undefined) lastWorkflowPath = workflowPath
    try {
      const result = await ideApi.actions(scopedPath)
      if (generation !== currentGeneration) return
      catalog.value = toCatalog(result)
      catalogDegraded.value = false
    } catch {
      if (generation !== currentGeneration) return
      catalog.value = EMPTY_CATALOG
      catalogDegraded.value = true
      status.set('平台动作目录未加载，工作流画布已降级为不检查入参模式。')
    }
  }

  return { catalog, catalogDegraded, workflowSchema, refreshCatalog, configure, reset }
})
