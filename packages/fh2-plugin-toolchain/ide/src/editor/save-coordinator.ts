// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 保存协调（计划 §C2 的浏览器一半）：把「编辑器里的内存状态」变成一份保存计划，
 * 交给服务端有序落盘，再把逐条结果**精确**回填到文档基线上。
 *
 * ★★ 三件必须由它来做、别处做不对的事：
 *
 * ① **先 flush 草稿**。检查器里的输入框在失焦前内容只在组件里。不 flush 就保存，
 *    用户会看到「保存成功」而刚敲的那个值没进文件 —— 这是最容易被当成「偶发丢配置」的一类。
 *
 * ② **基线只推进到真的落盘的那几份**。partial 时如果一把清掉所有 dirty 标记，
 *    没落盘的那些文件会显示成「已保存」，用户关掉就真丢了。
 *
 * ③ **虚拟文件与待删文件也要进计划**。只收集 dirty 会漏掉：新建的脚本（虚拟）
 *    与被 MoveScriptFile 标成待删的旧文件。漏掉前者 = 清单登记了一个不存在的文件。
 *
 * ⚠️ 它**不承诺**跨进程多文件 ACID（服务端也不承诺，见 services/ide/save.ts）。
 * 它承诺的是有序、CAS、失败即停、结果逐条可查。
 */

import type { DocumentConflict, DocumentSnapshot } from './document-store.js'

/**
 * 协调器对文档层的**最小依赖面**。
 *
 * ★★ 与 SessionDocuments 同一条理由：真正传进来的是 `DocumentService`（包着
 * DocumentStore 并加了保存队列）。把参数写成 DocumentStore 就得在调用点 cast，
 * 而那个 cast 会把「传错实例」藏成运行期问题。
 */
export interface SaveCoordinatorDocuments {
  readonly openPaths: readonly string[];
  /** 保存计划范围：tab 内 ∪ 无 tab 但 dirty（Inspector 脚本编辑器的 model，DAG-016-01）。 */
  readonly saveablePaths: readonly string[];
  readonly snapshot: (paths: readonly string[]) => readonly DocumentSnapshot[];
  readonly markSaved: (path: string, content: string, revision: string) => void;
  readonly enterConflict: (path: string, conflict: DocumentConflict) => void;
  readonly close: (path: string, force?: boolean) => void;
}

/** 服务端回包的形状（与 services/ide/save.ts 的 SaveResult 同构）。 */
export interface SaveItemResult {
  readonly path: string;
  readonly kind: 'write' | 'create' | 'delete';
  readonly ok: boolean;
  readonly revision?: string;
  readonly errorCode?: string;
  readonly message?: string;
  readonly conflict?: { readonly diskContent: string; readonly diskRevision: string };
}

export interface SaveResponse {
  readonly ok: boolean;
  readonly partial: boolean;
  readonly items: readonly SaveItemResult[];
}

export interface SaveRequestItem {
  readonly path: string;
  readonly kind: 'write' | 'create' | 'delete';
  readonly content?: string;
  readonly expectedDiskHash?: string;
}

/** 保存完成后的汇总（给状态栏与「保存收据」用）。 */
export interface SaveOutcome {
  readonly ok: boolean;
  readonly partial: boolean;
  /** 真的落盘了的路径。 */
  readonly saved: readonly string[];
  /** 没落盘的路径 → 原因。 */
  readonly failed: readonly { readonly path: string; readonly message: string }[];
  /** 进入冲突态的路径（需要用户在冲突 UI 里选）。 */
  readonly conflicted: readonly string[];
  /**
   * 计划里但既没成功也没失败（服务端失败即停时排在后面的那些）。
   * 它们的内容仍在编辑器里 —— 单独报出来，别并进 failed 冒充「保存被拒」。
   */
  readonly pending: readonly string[];
  /** 没有任何待保存内容时为 true（不是失败）。 */
  readonly nothingToSave: boolean;
}

export interface SaveCoordinatorPorts {
  readonly documents: SaveCoordinatorDocuments;
  /** 当前文档/工作区世代；异步等待期间切换后，不继续旧保存。 */
  readonly epoch?: () => number;
  /** 调服务端保存接口。 */
  readonly save: (items: readonly SaveRequestItem[]) => Promise<SaveResponse>;
  /**
   * 保存请求**丢失**（网络断/进程重启）后按路径重读磁盘内容（P2-5）。
   * 给了它，协调器能在响应丢失时核对「目标内容是否其实已落盘」——
   * 写入可能已成功，只是回包没回来；不核对就重试会拿旧 hash 撞 409。
   */
  readonly readFile?: (path: string) => Promise<{ readonly content: string; readonly revision: string }>;
}

export class SaveCoordinator {
  private readonly flushers = new Set<() => void | Promise<void>>()
  private inFlight: Promise<SaveOutcome> | null = null

  constructor (private readonly ports: SaveCoordinatorPorts) {}

  /**
   * 登记一个草稿 flush 回调（检查器的每个编辑面板各登记一个）。
   *
   * ⓘ 回 dispose 函数：面板销毁时要注销，否则保存时会去 flush 一个已经卸载的组件。
   */
  registerDraftFlush (flush: () => void | Promise<void>): () => void {
    this.flushers.add(flush)
    return () => this.flushers.delete(flush)
  }

  /** 等草稿写进文档后，再计算保存计划。 */
  async flushDrafts (): Promise<void> {
    // 逐个 try：一个面板的 flush 抛错不该让整次保存不做。
    for (const flush of this.flushers) {
      try {
        await flush()
      } catch {
        // 面板自己会把错显示出来；这里只保证其余面板照旧 flush。
      }
    }
  }

  /**
   * 算出保存计划。
   * ★ 基于 `snapshot()` 的**一次固定字节集**，不是边写边读 —— 否则「算计划时看到的内容」
   *   与「真正发出去的内容」可能不是一份。
   * @param only 计划里只保留这些路径（P0-7「保存当前流程（含脚本与清单）」的范围闸）。
   */
  buildPlan (only?: readonly string[]): { readonly items: readonly SaveRequestItem[]; readonly snapshots: readonly DocumentSnapshot[] } {
    const scope = only === undefined ? null : new Set(only)
    // DAG-016-01：范围取 saveablePaths——只按 tabPaths 收会漏掉 Inspector 脚本
    // 编辑器（acquireModel、无 tab）里 dirty 的 model，保存时静默丢改。
    const paths = this.ports.documents.saveablePaths
      .filter(path => scope === null || scope.has(path))
    const snapshots = this.ports.documents.snapshot(paths)
    const items: SaveRequestItem[] = []
    for (const snapshot of snapshots) {
      if (snapshot.content === null) continue
      if (snapshot.conflicted) continue // 冲突未解决的不进计划：它需要用户先选。
      if (snapshot.pendingDelete) {
        items.push({
          path: snapshot.path,
          kind: 'delete',
          // 待删的虚拟文件（建了又删）磁盘上压根没有，给空串让服务端按「已达成」处理。
          expectedDiskHash: snapshot.expectedRevision ?? '',
        })
        continue
      }
      if (!snapshot.existsOnDisk) {
        items.push({ path: snapshot.path, kind: 'create', content: snapshot.content })
        continue
      }
      if (!snapshot.dirty) continue
      items.push({
        path: snapshot.path,
        kind: 'write',
        content: snapshot.content,
        expectedDiskHash: snapshot.expectedRevision ?? '',
      })
    }
    return { items, snapshots }
  }

  /**
   * 执行一次保存。
   *
   * ⚠️ 同一时刻只跑一次：并发两次保存会让两份计划各自带着自己的 expectedDiskHash，
   * 后到的那次必然冲突，而用户看到的是「莫名其妙的冲突弹窗」。
   *
   * @param only 只保存这些路径（缺省 = 全部待保存内容）。
   */
  async save (only?: readonly string[]): Promise<SaveOutcome> {
    if (this.inFlight !== null) return await this.inFlight
    const run = this.run(only)
    this.inFlight = run
    try {
      return await run
    } finally {
      this.inFlight = null
    }
  }

  private async run (only?: readonly string[]): Promise<SaveOutcome> {
    const epoch = this.ports.epoch?.()
    const assertCurrent = (): void => {
      if (this.ports.epoch?.() !== epoch) throw new Error('工作区或流程已切换，已停止旧保存。')
    }
    await this.flushDrafts()
    assertCurrent()
    const { items, snapshots } = this.buildPlan(only)
    const conflictedNow = snapshots.filter(snapshot => snapshot.conflicted).map(snapshot => snapshot.path)

    if (items.length === 0) {
      return {
        ok: conflictedNow.length === 0,
        partial: false,
        saved: [],
        failed: conflictedNow.map(path => ({ path, message: '该文件处于冲突态，请先解决冲突。' })),
        conflicted: conflictedNow,
        pending: [],
        nothingToSave: conflictedNow.length === 0,
      }
    }

    const byPath = new Map(items.map(item => [item.path, item]))
    let response: SaveResponse
    try {
      response = await this.ports.save(items)
    } catch (error) {
      assertCurrent()
      // P2-5：请求本身丢了（不是服务端拒绝）。逐条核对磁盘 —— 写入可能已成功，
      // 只是回包没回来。已达到目标内容的按已保存收账，其余原样留在编辑器里。
      return await this.reconcileLostResponse(items, error, assertCurrent)
    }
    assertCurrent()

    const saved: string[] = []
    const failed: { path: string; message: string }[] = []
    /** FH2_IDE_SAVE_SKIPPED 项：被前序失败挡住、根本没执行。 */
    const skipped: string[] = []
    const conflicted: string[] = [...conflictedNow]

    for (const result of response.items) {
      if (result.ok) {
        const request = byPath.get(result.path)
        // 删除成功没有新内容/新 revision：把文档关掉，别留一个指向已删文件的 tab。
        if (request?.kind === 'delete') {
          this.ports.documents.close(result.path, true)
          saved.push(result.path)
          continue
        }
        if (request?.content !== undefined && result.revision !== undefined) {
          // ★ 用**提交出去的那份内容**推进基线，不是当前内容：保存期间用户继续输入时
          //   当前内容更新，推到它会把还没落盘的编辑标记成已保存。
          this.ports.documents.markSaved(result.path, request.content, result.revision)
        }
        saved.push(result.path)
        continue
      }
      // K（FH2_IDE_SAVE_SKIPPED）= 服务端失败即停后没轮到执行的项：归「未执行」，
      // 不是普通失败——它没有失败原因，只有「被前一项挡住」。
      if (result.errorCode === 'FH2_IDE_SAVE_SKIPPED') {
        skipped.push(result.path)
        continue
      }
      failed.push({ path: result.path, message: result.message ?? result.errorCode ?? '保存失败' })
      if (result.conflict !== undefined) {
        this.ports.documents.enterConflict(result.path, {
          diskContent: result.conflict.diskContent,
          diskRevision: result.conflict.diskRevision,
        })
        conflicted.push(result.path)
      }
    }
    // 失败即停：计划里剩下的既没成功也没失败（含服务端显式回 SKIPPED 的 K 项）
    // —— 原样待在编辑器里，如实上报。
    const accounted = new Set([...saved, ...failed.map(item => item.path)])
    const pending = [...skipped, ...items.map(item => item.path).filter(path => !accounted.has(path) && !skipped.includes(path))]

    return {
      ok: response.ok && conflicted.length === 0,
      partial: response.partial,
      saved,
      failed,
      conflicted: [...new Set(conflicted)],
      pending,
      nothingToSave: false,
    }
  }

  /** 响应丢失后的对账：磁盘内容 == 提交内容 → 视为已保存（P2-5）。 */
  private async reconcileLostResponse (
    items: readonly SaveRequestItem[],
    error: unknown,
    assertCurrent: () => void,
  ): Promise<SaveOutcome> {
    const message = error instanceof Error ? error.message : String(error)
    const saved: string[] = []
    const failed: { path: string; message: string }[] = []
    for (const item of items) {
      if (this.ports.readFile === undefined) {
        failed.push({ path: item.path, message: `保存请求丢失（${message}），结果未知；内容仍在编辑器里。` })
        continue
      }
      try {
        const disk = await this.ports.readFile(item.path)
        assertCurrent()
        if (disk.content === item.content) {
          if (item.kind !== 'delete') {
            this.ports.documents.markSaved(item.path, item.content, disk.revision)
          }
          saved.push(item.path)
          continue
        }
        // 磁盘 ≠ 提交：写可能成功后被别的会话覆盖，或请求从未到达。这里**立即**
        // 进冲突态（DAG-017-11）：此前只记 failed、把冲突寄望于 fs watcher 的
        // 迟到事件，UI 在两件事之间留出一个窗口——用户（与自动化）在此窗口里
        // 看到的是「保存失败」而非冲突对话框，随后的 fs 事件又会让对话框在
        // 操作中途弹出、遮挡界面。直接 enterConflict 是确定性的，watcher 后续
        // 的 reloadDocument 幂等覆盖同一份快照。
        if (item.kind !== 'delete') {
          this.ports.documents.enterConflict(item.path, {
            diskContent: disk.content,
            diskRevision: disk.revision,
          })
        }
        failed.push({ path: item.path, message: `保存请求丢失（${message}），磁盘内容与提交内容不一致。` })
      } catch {
        assertCurrent()
        failed.push({ path: item.path, message: `保存请求丢失（${message}），且无法重读磁盘核对；内容仍在编辑器里。` })
      }
    }
    return {
      ok: failed.length === 0,
      partial: saved.length > 0 && failed.length > 0,
      saved,
      failed,
      conflicted: [],
      pending: [],
      nothingToSave: false,
    }
  }
}
