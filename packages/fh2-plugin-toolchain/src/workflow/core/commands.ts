// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * `PreparedCommand` —— C（统一文档层）、D（Workflow Core）、E（画布/检查器）的**唯一交汇点**。
 *
 * ★★ 这个类型为什么要单独一个文件、并且要先于三包实现定下来：
 * 它同时决定三件事 ——
 *   ① D 的每个命令要**产出**什么（prepare 的返回值）
 *   ② C 的 `DocumentStore.applyPrepared` 要**消费**什么
 *   ③ E 的意图分发拿到什么来做「影响预览」与「失败提示」
 * 三边各自实现前不把它钉死，会合的时候必然对不上，而且是在三边都写完之后才发现。
 *
 * ── 三条不可协商的性质（计划 §D2）───────────────────────────────────
 *
 * **prepare 可以异步，apply 必须同步。** prepare 阶段允许读文件、查知识包、算影响；
 * apply 阶段只做「核验前置 → 写内存 → 发一个事件」，中间**一个 await 都不许有**。
 * 理由：apply 里只要有一次 await，就存在「核验通过之后、写入完成之前」的窗口，
 * 用户在那个窗口里的任何输入都会被后写入的内容悄悄盖掉。
 *
 * **前置失效时零修改。** 核验失败不是「跳过失效的那部分」，而是整条命令一个字节都不写。
 * 跨文件命令尤其要紧：写了脚本没写清单，工程会处在一个两边都解析不出来的中间态。
 *
 * **跨文件只发一个 batch 事件。** 逐文件发事件会让 UI 在中间态上重算一次投影 ——
 * 那一次重算看到的是「脚本已建、清单还没登记」，于是画布闪一下红字再变绿。
 *
 * ⚠️ 本文件只定形状，不含任何实现：apply 在 IDE 的 DocumentStore（要碰 Monaco），
 * prepare 在各 command 模块。放一起会让 core 依赖 Monaco。
 */

import type { JsonEditOp } from './json-edits.js'

/** 一次命令对某一个文件的修改。 */
export type PreparedFileEdit =
  | {
    /** 工作区相对路径（POSIX）。 */
    readonly path: string;
    readonly kind: 'modify';
    /**
     * JSON 最小文本编辑序列（见 json-edits.ts）。
     * ⚠️ 顺序有意义：后一条基于前一条的结果算 offset。
     */
    readonly ops: readonly JsonEditOp[];
  }
  | {
    readonly path: string;
    readonly kind: 'replace';
    /**
     * 整份内容替换。**只用于非 JSON 文件**（JS 源码模板）或新建文件的首次落内容。
     *
     * ⚠️ 不要拿它改 JSON：那等于回到「整份重新序列化」，会清空 Monaco 的 undo 栈
     * 并丢掉手写排版（见 json-edits.ts 头部）。改 JSON 一律走 `modify`。
     */
    readonly content: string;
  }
  | {
    readonly path: string;
    readonly kind: 'create';
    readonly content: string;
  }
  | {
    readonly path: string;
    readonly kind: 'delete';
  }

/**
 * apply 之前要核验的前置。任一不符 → 整条命令不执行。
 *
 * ★ 三个维度都要有，缺一个就有一类静默覆盖：
 *   workspaceEpoch  换工作区后拿旧命令去写新工程的同名文件
 *   documents       文档在 prepare 与 apply 之间被别处改过（Monaco 里手敲、外部编辑器保存）
 *   knowledgeId     知识包被切换，而命令的参数候选是按旧知识算出来的
 */
export interface PreparedPreconditions {
  readonly workspaceEpoch: number;
  /**
   * 每个被改文件在 prepare 那一刻的 generation。
   * ⚠️ 必须**逐文件**记，不能只记一个全局版本号：一个无关文件的改动
   * 不该让本命令失效（那会让协作编辑时命令频繁无故失败）。
   */
  readonly documents: readonly { readonly path: string; readonly generation: number }[];
  /** 命令依赖知识包时给；纯结构操作（连线、改 id）不依赖，可缺省。 */
  readonly knowledgeId?: string;
}

/** apply 成功后建议把焦点落在哪 —— 画布据此选中新建的节点。 */
export interface PreparedFocus {
  readonly stepId?: string;
  /** 建议在源码页签打开的文件（新建业务功能后跳到 JS）。 */
  readonly openPath?: string;
}

/** 一条已算好、可原子应用的命令。 */
export interface PreparedCommand {
  /**
   * 命令类型标识（如 `AddStep`）。进工作区命令历史，也进失败提示。
   * ⚠️ 不要拿它做分支逻辑：apply 对所有命令一视同仁，按类型分叉就等于把语义又搬回 C 层。
   */
  readonly kind: string;
  /** 给人看的一句话（撤销菜单、诊断）。 */
  readonly label: string;
  readonly edits: readonly PreparedFileEdit[];
  readonly expected: PreparedPreconditions;
  readonly focus?: PreparedFocus;
}

/** prepare 的结果：要么拿到一条可应用的命令，要么拿到一个说得清的拒绝理由。 */
export type PrepareResult =
  | {
    readonly ok: true;
    readonly command: PreparedCommand;
    /**
     * 「命令能应用，但有几处要你自己处理」的清单。
     *
     * ★★ 与拒绝时的 `impacts` 是**两件不同的事**：
     *   impacts（ok:false）  命令会破坏既有配置，**先让用户决定**再执行
     *   advisories（ok:true）命令范围之外还有活儿，本次**管不到**（比如没打开的其他流程文件）
     * 把后者也做成拒绝会让用户卡住；而把它丢掉更坏 —— 用户以为改完了，
     * 另一条流程在运行期报「脚本未注册」。
     */
    readonly advisories?: readonly CommandImpact[];
  }
  | {
    readonly ok: false;
    /**
     * 拒绝原因（给人读）。
     * ⚠️ 不要用「操作失败」一类的空话：这里是用户唯一能看到的解释。
     */
    readonly reason: string;
    /**
     * 可选的影响清单：命令会破坏既有接线时，先把「谁会受影响」摊开给用户看，
     * 而不是自动改或者直接拒（计划 §D3：删除和断边先展示影响）。
     */
    readonly impacts?: readonly CommandImpact[];
  }

/** 一处会被命令波及的既有配置。 */
export interface CommandImpact {
  /** 受影响的步骤 id；触发器用合成 id。 */
  readonly stepId: string;
  /** 受影响的位置（`inputs.decision.from` / `needs` / `when.field` …）。 */
  readonly at: string;
  /** 当前值。 */
  readonly current: string;
  /** 为什么会受影响。 */
  readonly why: string;
}

/** apply 的结果。 */
export type ApplyResult =
  | { readonly ok: true }
  | {
    readonly ok: false;
    /**
     * `stale` = 前置已失效（文档/工作区/知识变了），调用方应重新 prepare；
     * `conflict` = 目标文档处于冲突态，必须先解决冲突；
     * `invalid` = 命令本身不可应用（路径解析不出来等），是程序缺陷，不该重试。
     */
    readonly code: 'stale' | 'conflict' | 'invalid';
    readonly reason: string;
  }

/** 判断两条命令是否触及同一批文件（UI 用来合并/丢弃排队中的命令）。 */
export function touchesSameFiles (left: PreparedCommand, right: PreparedCommand): boolean {
  const paths = new Set(left.edits.map(edit => edit.path))
  return right.edits.some(edit => paths.has(edit.path))
}

/** 命令涉及的全部文件路径（排序去重，便于日志与快照）。 */
export function affectedPaths (command: PreparedCommand): readonly string[] {
  return [...new Set(command.edits.map(edit => edit.path))].sort()
}
