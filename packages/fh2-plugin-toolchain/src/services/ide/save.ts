// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 多文件保存（计划 §C2 的服务端一半）：按计划**有序**落盘，逐条回结果。
 *
 * ★★ 顺序不是随意定的，它是 `脚本 → 清单 → 工作流`（见 SAVE_ORDER）：
 * 每一步失败时，**已经写下去的那部分必须仍是一个能装载的工程**。
 *   先写脚本文件：多一份没被登记的 JS 是无害的（谁也不会去调它）；
 *   再写清单：清单登记了一份已经存在的文件，装载期通得过；
 *   最后写流程：流程引用的功能此刻已经在清单里了。
 * 反过来（先写流程）失败在中间，就会留下「流程引用了一个清单里没有的功能」——
 * 装载期直接拒掉**整个插件包**，而用户只是保存了一下。
 *
 * ⚠️⚠️ 本模块**不承诺跨进程多文件 ACID**，也不假装承诺：
 * 没有事务性文件系统，中途断电就是会留下半份。它承诺的是三件可验证的事 ——
 *   ① 有序（上面那条）
 *   ② 每份文件各自带 `expectedDiskHash` 做 CAS，外部改动不会被静默覆盖
 *   ③ 失败即停 + 逐条结果，调用方能精确知道哪些落了、哪些没落（partial）
 */

import type { IdeErrorCode } from '../../contracts/error-codes.js'
import { IdeRequestError } from '../../contracts/ide.js'
import {
  IdeFileConflictError,
  createWorkspaceEntry,
  deleteWorkspaceEntry,
  readWorkspaceFile,
  writeWorkspaceFile,
} from './files.js'

/** 计划里的一项。 */
export type SaveItem =
  | {
    readonly path: string;
    readonly kind: 'write';
    readonly content: string;
    /**
     * 期望的磁盘内容 hash（CAS）。
     * ⚠️ 必须给：缺了它就是无条件覆盖，外部编辑器/git 的改动会被静默吃掉。
     * 新建文件用空串（表示「期望它还不存在」）。
     */
    readonly expectedDiskHash: string;
  }
  | {
    readonly path: string;
    readonly kind: 'create';
    readonly content: string;
  }
  | {
    readonly path: string;
    readonly kind: 'delete';
    /** 期望的磁盘内容 hash；不符说明别人改过它，停手。 */
    readonly expectedDiskHash: string;
  }

export interface SavePlan {
  readonly items: readonly SaveItem[];
}

/** 一项的结果。 */
export interface SaveItemResult {
  readonly path: string;
  readonly kind: SaveItem['kind'];
  readonly ok: boolean;
  /** 成功写入后的新 revision（前端据此推进磁盘基线）。 */
  readonly revision?: string;
  /**
   * 失败时的错误码。用仓里既有的 IdeErrorCode，**不自造**：
   * 前端按码分支（冲突要弹冲突 UI、逃逸要报缺陷），自造码会落到「未知错误」那一档。
   */
  readonly errorCode?: IdeErrorCode | 'FH2_IDE_SAVE_SKIPPED';
  readonly message?: string;
  /** 冲突时的磁盘快照，供冲突 UI 消费。 */
  readonly conflict?: { readonly diskContent: string; readonly diskRevision: string };
}

export interface SaveResult {
  /** 全部落盘才为 true。 */
  readonly ok: boolean;
  /**
   * 有一部分落了、一部分没落。
   * ★ 它必须与 `ok` 分开报：前端的保存基线只能推进到**真的落盘**的那几份，
   * 把 partial 当成失败会让用户以为什么都没保存，从而重复操作。
   */
  readonly partial: boolean;
  readonly items: readonly SaveItemResult[];
}

/**
 * 落盘顺序（见文件头 ★★）。数字小的先写。
 * ⓘ 判据是「路径像什么」而不是「命令说它是什么」：命令可能来自将来的新入口，
 * 而顺序这件事只取决于装载期的依赖方向。
 */
export const SAVE_ORDER = {
  script: 0,
  manifest: 1,
  workflow: 2,
  other: 1,
} as const

/** 脚本源码的扩展名集合（P2-5：全部归脚本优先档，不只 .js）。 */
const SCRIPT_EXTENSIONS: readonly string[] = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']

/** 一条路径属于哪一档。 */
export function saveOrderOf (path: string): number {
  const name = path.split('/').pop() ?? path
  if (name === 'plugin.json' || name === 'fh2-plugin.json') return SAVE_ORDER.manifest
  if (path.includes('/workflows/') || path.startsWith('workflows/')) return SAVE_ORDER.workflow
  if (SCRIPT_EXTENSIONS.some(extension => name.endsWith(extension))) return SAVE_ORDER.script
  return SAVE_ORDER.other
}

/**
 * 把计划按落盘顺序排好。
 * ⚠️ 必须是**稳定**排序：同一档内保持调用方给的顺序，否则两次保存的写入次序不同，
 * 失败时留下的中间态也不同，问题就无法复现。
 */
export function orderSavePlan (items: readonly SaveItem[]): readonly SaveItem[] {
  return items
    .map((item, index) => ({ item, index, order: saveOrderOf(item.path) }))
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .map(entry => entry.item)
}

/** 读一份文件的磁盘快照；不存在时回 undefined。 */
async function diskSnapshot (
  root: string,
  path: string,
): Promise<{ content: string; revision: string } | undefined> {
  try {
    const file = await readWorkspaceFile(root, path)
    return { content: file.content, revision: file.revision }
  } catch (error) {
    if (error instanceof IdeRequestError && error.code === 'FH2_IDE_NOT_FOUND') return undefined
    throw error
  }
}

export interface RunSavePlanOptions {
  readonly root: string;
  readonly plan: SavePlan;
}

/**
 * 执行保存计划。**失败即停**：后面的项一律不写，并在结果里标成未执行。
 *
 * ★ 为什么失败即停而不是「尽力全写」：尽力全写会在一次失败后继续制造更多不一致，
 * 而用户拿到的是一份「有些新有些旧」的工程 —— 那比明确停在第一处失败难排查得多。
 */
export async function runSavePlan (options: RunSavePlanOptions): Promise<SaveResult> {
  const ordered = orderSavePlan(options.plan.items)
  const results: SaveItemResult[] = []
  let stopped = false

  for (const item of ordered) {
    if (stopped) {
      results.push({
        path: item.path,
        kind: item.kind,
        ok: false,
        errorCode: 'FH2_IDE_SAVE_SKIPPED',
        message: '前一项保存失败，本项未执行（避免继续制造不一致）。',
      })
      continue
    }
    try {
      results.push(await runItem(options.root, item))
    } catch (error) {
      results.push(toFailure(item, error))
    }
    if (results[results.length - 1]!.ok) continue
    stopped = true
  }

  const succeeded = results.filter(result => result.ok).length
  return {
    ok: succeeded === results.length && results.length > 0,
    partial: succeeded > 0 && succeeded < results.length,
    items: results,
  }
}

async function runItem (root: string, item: SaveItem): Promise<SaveItemResult> {
  if (item.kind === 'delete') {
    const snapshot = await diskSnapshot(root, item.path)
    if (snapshot === undefined) {
      // 已经没了：目标状态达成，按成功处理（重复保存是常态）。
      return { path: item.path, kind: 'delete', ok: true }
    }
    if (snapshot.revision !== item.expectedDiskHash) {
      return {
        path: item.path,
        kind: 'delete',
        ok: false,
        errorCode: 'FH2_FILE_CONFLICT',
        message: '磁盘上的内容与预期不符，删除已中止（有人改过它）。',
        conflict: { diskContent: snapshot.content, diskRevision: snapshot.revision },
      }
    }
    await deleteWorkspaceEntry(root, item.path, false)
    return { path: item.path, kind: 'delete', ok: true }
  }

  if (item.kind === 'create') {
    const snapshot = await diskSnapshot(root, item.path)
    if (snapshot !== undefined) {
      // 已存在：这是新建，不能覆盖 —— 覆盖会吃掉别人刚建的同名文件。
      return {
        path: item.path,
        kind: 'create',
        ok: false,
        errorCode: 'FH2_IDE_ALREADY_EXISTS',
        message: '目标文件已存在，新建已中止。',
        conflict: { diskContent: snapshot.content, diskRevision: snapshot.revision },
      }
    }
    // ⚠️ writeWorkspaceFile 要求父目录已存在，而新建脚本经常要落进一个还不存在的
    //    adapters/ 子目录。故先逐级建目录 —— 走 createWorkspaceEntry 是为了让
    //    路径安全校验（逃逸、symlink）与写文件走同一套判据，而不是自己 mkdir。
    await ensureParentDirectories(root, item.path)
    const written = await writeWorkspaceFile(root, item.path, item.content)
    return { path: item.path, kind: 'create', ok: true, revision: written.revision }
  }

  const written = await writeWorkspaceFile(root, item.path, item.content, {
    expectedRevision: item.expectedDiskHash,
  })
  return { path: item.path, kind: 'write', ok: true, revision: written.revision }
}

/**
 * 逐级建出目标文件的父目录。
 *
 * ⓘ `createWorkspaceEntry` 的 mkdir **不递归**（它一次只建一层），故这里自己逐段走。
 * 已存在的那几层会报 ALREADY_EXISTS，按预期忽略 —— 其余错误一律抛出去。
 */
async function ensureParentDirectories (root: string, path: string): Promise<void> {
  const segments = path.split('/')
  segments.pop()
  let prefix = ''
  for (const segment of segments) {
    prefix = prefix === '' ? segment : `${prefix}/${segment}`
    try {
      await createWorkspaceEntry(root, prefix, 'dir', undefined)
    } catch (error) {
      if (error instanceof IdeRequestError && error.code === 'FH2_IDE_ALREADY_EXISTS') continue
      throw error
    }
  }
}

function toFailure (item: SaveItem, error: unknown): SaveItemResult {
  // ★ 冲突用仓里既有的 IdeFileConflictError：它带着磁盘快照（disk），
  //   前端的冲突 UI（Diff / 采用磁盘 / 保留本地）全靠那一份。
  if (error instanceof IdeFileConflictError) {
    return {
      path: item.path,
      kind: item.kind,
      ok: false,
      errorCode: error.code,
      message: error.message,
      conflict: { diskContent: error.disk.content, diskRevision: error.disk.revision },
    }
  }
  if (error instanceof IdeRequestError) {
    return {
      path: item.path,
      kind: item.kind,
      ok: false,
      errorCode: error.code,
      message: error.message,
    }
  }
  return {
    path: item.path,
    kind: item.kind,
    ok: false,
    errorCode: 'FH2_IDE_INTERNAL',
    message: error instanceof Error ? error.message : String(error),
  }
}
