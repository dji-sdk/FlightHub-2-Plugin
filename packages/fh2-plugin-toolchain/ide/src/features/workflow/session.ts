// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * Workflow 编辑会话（计划 §E1）：意图 → 命令 → 原子应用 的**唯一通道**。
 *
 * ★★ 它存在的理由是把三件事从 Pinia store 里拿出来：
 *   ① 构造命令上下文（一次固定的字节集 + 版本身份）
 *   ② 分发命令（prepare 可异步 → applyPrepared 同步）
 *   ③ 把「被拒」与「有待办」区分开交给 UI
 * 留在 store 里的话，每加一个操作都要在 store 里重复一遍取快照、取代号、报错这套，
 * 而漏掉其中任一步的表现都是静默的（最常见的是漏了代号 → 覆盖用户刚敲的内容）。
 *
 * ⚠️ 本模块**不碰 Vue/Pinia**，也不直接调文件 API：它只操作 DocumentStore 与 core 命令。
 * store 是它的薄门面（计划 §E1：Store 不再持有 Canvas 实例、不直接改 raw、不调文件 API）。
 */

import type { ActionCatalog } from '../../../../src/workflow/core/catalog.js'
import type { ApplyResult, CommandImpact, PreparedCommand } from '../../../../src/workflow/core/commands.js'
import type { NodeBindingStatus } from '../../../../src/workflow/core/binding-status.js'
import { summarizeBindings } from '../../../../src/workflow/core/binding-status.js'
import { validateSemantics } from '../../../../src/workflow/core/semantics.js'
import { canEditJson, parseJsonValue } from '../../../../src/workflow/core/json-edits.js'
import type { ScriptCommandContext } from '../../../../src/workflow/core/script-commands.js'
import type { WorkflowCommandContext } from '../../../../src/workflow/core/step-commands.js'
import type { DocumentSnapshot } from '../../editor/document-store.js'

/**
 * 会话对文档层的**最小依赖面**。
 *
 * ★★ 刻意不写成 `DocumentStore`：真正传进来的是 `DocumentService`（它包着同一个
 * DocumentStore 并加了保存队列）。把参数类型写成 DocumentStore 就得在调用点 cast，
 * 而那个 cast 会掩盖一件要紧的事 —— 传错实例（另 new 一个 store）时**编译期发现不了**，
 * 运行期表现是「命令前置核验核的是另一份文档的版本」，形同没有核验。
 * 收窄成结构类型之后，任何满足这四项的实现都能传，且传错实例仍然是语义问题、
 * 但至少不再被一个 `as unknown as` 藏起来。
 */
export interface SessionDocuments {
  readonly snapshot: (paths: readonly string[]) => readonly DocumentSnapshot[];
  readonly applyPrepared: (command: PreparedCommand) => ApplyResult;
  readonly generationOf: (path: string) => number | undefined;
  readonly workspaceEpoch: () => number;
}

/** 一次意图分发的结果 —— UI 只需要看这三种。 */
export type DispatchOutcome =
  | {
    readonly status: 'applied';
    /** 命令建议的焦点（新建节点后选中它、新建功能后打开 JS）。 */
    readonly focus?: PreparedCommand['focus'];
    /** 「已应用，但有几处要你自己处理」。 */
    readonly advisories?: readonly CommandImpact[];
  }
  | {
    readonly status: 'rejected';
    readonly reason: string;
    /**
     * 会破坏既有配置时的影响清单 —— UI 应当把它摊开给用户看，
     * 让用户决定要不要带 force 再来一次，而不是自动改。
     */
    readonly impacts?: readonly CommandImpact[];
  }
  | {
    readonly status: 'stale';
    /** 前置失效（文档被改过/工作区切了/冲突）。UI 应重算后重试，而不是硬写。 */
    readonly reason: string;
  }

/** 会话要的外部能力。 */
export interface WorkflowSessionPorts {
  readonly documents: SessionDocuments;
  /** 当前平台 Catalog（来自固定的知识包，或内建快照）。 */
  readonly catalog: () => ActionCatalog;
  /** 当前固定的知识身份；未固定时 undefined。 */
  readonly knowledgeId: () => string | undefined;
}

export class WorkflowSession {
  private currentPath: string | null = null
  private selection: string | null = null

  constructor (private readonly ports: WorkflowSessionPorts) {}

  get path (): string | null {
    return this.currentPath
  }

  setPath (path: string | null): void {
    this.currentPath = path
    this.selection = null
  }

  get selectedNodeId (): string | null {
    return this.selection
  }

  select (nodeId: string | null): void {
    this.selection = nodeId
  }

  /** 当前后端清单路径（画布新建功能要写回它）。 */
  private manifestPath (): string | null {
    const path = this.ports.catalog().pluginManifestPath
    return path === '' ? null : path
  }

  /**
   * 构造工作流命令上下文。
   *
   * ⚠️ `text` 与 `generation` 必须来自**同一次** snapshot：分两次取的话，
   * 中间的一次编辑会让「按旧文本算出的编辑」配上「新代号的前置」——
   * 前置会通过，而编辑是错的。
   */
  workflowContext (): WorkflowCommandContext | null {
    const path = this.currentPath
    if (path === null) return null
    const [snapshot] = this.ports.documents.snapshot([path])
    if (snapshot === undefined || snapshot.content === null) return null
    const knowledgeId = this.ports.knowledgeId()
    return {
      workspaceEpoch: this.ports.documents.workspaceEpoch(),
      ...(knowledgeId === undefined ? {} : { knowledgeId }),
      workflow: { path, text: snapshot.content, generation: snapshot.generation },
      catalog: this.ports.catalog(),
    }
  }

  /** 构造业务功能命令上下文（要清单；同时改流程时把流程也带上）。 */
  scriptContext (): ScriptCommandContext | null {
    const manifest = this.manifestPath()
    if (manifest === null) return null
    const paths = this.currentPath === null ? [manifest] : [manifest, this.currentPath]
    const snapshots = this.ports.documents.snapshot(paths)
    const manifestSnapshot = snapshots.find(snapshot => snapshot.path === manifest)
    if (manifestSnapshot === undefined || manifestSnapshot.content === null) return null

    const knowledgeId = this.ports.knowledgeId()
    const catalog = this.ports.catalog()
    const workflowSnapshot = this.currentPath === null
      ? undefined
      : snapshots.find(snapshot => snapshot.path === this.currentPath)

    return {
      workspaceEpoch: this.ports.documents.workspaceEpoch(),
      ...(knowledgeId === undefined ? {} : { knowledgeId }),
      manifest: {
        path: manifest,
        text: manifestSnapshot.content,
        generation: manifestSnapshot.generation,
      },
      ...(workflowSnapshot?.content == null
        ? {}
        : {
            workflow: {
              path: workflowSnapshot.path,
              text: workflowSnapshot.content,
              generation: workflowSnapshot.generation,
            },
          }),
      catalog,
      // P0-1：新建脚本的扩展名/模板形态按工程语言档案（Runtime Profile）。
      scriptLanguage: catalog.scriptLanguage,
    }
  }

  /** 不依赖任何已打开文档的命令上下文（如新建工作流文件）。 */
  workspaceCommandContext (): { workspaceEpoch: number; knowledgeId?: string } {
    const knowledgeId = this.ports.knowledgeId()
    return {
      workspaceEpoch: this.ports.documents.workspaceEpoch(),
      ...(knowledgeId === undefined ? {} : { knowledgeId }),
    }
  }

  /**
   * 分发一条命令：prepare 的结果直接交给 applyPrepared。
   *
   * ★ prepare 允许异步（签名收 Promise），apply 必须同步 —— 两者之间不引入 await
   *   之外的任何逻辑：中间插一句「再读一次文档」就等于让前置核验失去意义。
   */
  async dispatch (
    prepare: () => Promise<import('../../../../src/workflow/core/commands.js').PrepareResult>
      | import('../../../../src/workflow/core/commands.js').PrepareResult,
  ): Promise<DispatchOutcome> {
    const prepared = await prepare()
    if (!prepared.ok) {
      return {
        status: 'rejected',
        reason: prepared.reason,
        ...(prepared.impacts === undefined ? {} : { impacts: prepared.impacts }),
      }
    }
    const applied = this.ports.documents.applyPrepared(prepared.command)
    if (!applied.ok) {
      // invalid 是程序缺陷（命令自己算错了），与 stale/conflict 分开报：
      // 前者不该让用户「重试」，重试一万次还是同一个缺陷。
      if (applied.code === 'invalid') return { status: 'rejected', reason: applied.reason }
      return { status: 'stale', reason: applied.reason }
    }
    if (prepared.command.focus?.stepId !== undefined) this.selection = prepared.command.focus.stepId
    return {
      status: 'applied',
      ...(prepared.command.focus === undefined ? {} : { focus: prepared.command.focus }),
      ...(prepared.advisories === undefined ? {} : { advisories: prepared.advisories }),
    }
  }

  /**
   * 算当前流程的节点绑定状态（计划 §E5）。
   *
   * ⚠️⚠️ 文档不是合法 JSON 时回**空数组**，而不是「按容错解析的结果算一遍」。
   * jsonc-parser 对 `{ "steps": [` 这类半截文本会宽容地解析成一棵不完整的树 ——
   * 拿它算出来的状态是**假的**：用户正打字的过程中画布会闪出一批红点，
   * 而那些红点指的问题在他打完之后并不存在。「解析不出来」这件事由通知栏承载。
   */
  bindingStatuses (): readonly NodeBindingStatus[] {
    const path = this.currentPath
    if (path === null) return []
    const [snapshot] = this.ports.documents.snapshot([path])
    if (snapshot?.content == null) return []
    if (!canEditJson(snapshot.content)) return []
    const raw = parseJsonValue(snapshot.content)
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return []

    const record = raw as Record<string, unknown>
    const nodeIds = Array.isArray(record.steps)
      ? record.steps
          .filter((step): step is Record<string, unknown> =>
            typeof step === 'object' && step !== null && !Array.isArray(step))
          .map(step => (typeof step.id === 'string' ? step.id : ''))
          .filter(id => id !== '')
      : []
    const issues = validateSemantics(this.ports.catalog(), { raw: record })
    return summarizeBindings(nodeIds, issues)
  }
}
