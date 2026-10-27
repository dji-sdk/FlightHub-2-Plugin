// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { SchemaEntry, WorkspaceInfo } from '../api/types.js'
import {
  applyBrowserTypeScriptDefaults,
  applyGojaTypeScriptDefaults,
  applyJsonSchemas,
} from '../editor/monaco-setup.js'

/**
 * 判断一个脚本是否跑在 Goja（ES5.1）里。
 *
 * Monaco 的 TS 语言服务 compilerOptions 是全局单例，无法按 model 分档，
 * 因此只能在「当前活动文件」切换时整体切档。判定用路径而不是工作区类型，
 * 这样全栈插件（前端 src/ + 后端 backend/）在两边都能得到正确的诊断基线。
 */
export function isGojaScript (path: string, kind: WorkspaceInfo['kind']): boolean {
  if (!/\.[cm]?[jt]sx?$/.test(path)) return false
  if (kind === 'backend-plugin') return true
  return path.split('/').includes('backend')
}

/**
 * 工作区信息、schema、受审词表，以及与工作区绑定的 Monaco 全局配置。
 * SSE workspace 事件的回声抑制标记（selfInitiatedRoot）也在这里。
 */
export const useWorkspaceStore = defineStore('workspace', () => {
  const info = ref<WorkspaceInfo | null>(null)
  const schemas = ref<readonly SchemaEntry[]>([])
  const gojaMode = ref<boolean | null>(null)
  /** 本地刚发起的工作区切换目标，用来识别并忽略服务端回声的 SSE workspace 事件。 */
  const selfInitiatedRoot = ref<string | null>(null)

  function apply (workspace: WorkspaceInfo, nextSchemas: readonly SchemaEntry[]): void {
    info.value = workspace
    schemas.value = nextSchemas
    // [fh2-diag] 低频诊断（DAG-013-01 根因定位）：workspace apply 与 schema 配置的时序锚点。
    // eslint-disable-next-line no-console -- 诊断日志（info 级、每次 apply 一条），随 harness console 事件输出
    console.info('[fh2-diag] workspace-apply', `root=${workspace.root} sessionId=${workspace.sessionId.slice(0, 8)} schemas=${nextSchemas.length}`)
    applyJsonSchemas(nextSchemas)
    // 切工作区后档位可能要变，强制重新写一遍；与旧行为一致，先回浏览器档
    gojaMode.value = null
    applyTypeScriptDefaults(false)
  }

  /** compilerOptions 是全局单例，切档会触发全量重校验，因此只在档位真的变了时才写。 */
  function applyTypeScriptDefaults (goja: boolean): boolean {
    if (gojaMode.value === goja) return false
    gojaMode.value = goja
    if (goja) applyGojaTypeScriptDefaults()
    else applyBrowserTypeScriptDefaults()
    return true
  }

  return {
    info,
    schemas,
    selfInitiatedRoot,
    apply,
    applyTypeScriptDefaults,
  }
})
