// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0

export interface ConstInputDraft {
  readonly epoch: number;
  readonly stepId: string;
  readonly field: string;
  readonly type: string;
  readonly raw: string;
}

/**
 * 输入框里的值先记成一份草稿，保存前统一提交。
 *
 * 输入框只在 change/blur 时写文档；光标还在框里直接按保存（Ctrl+S）不会触发 change，
 * 这时框里显示新值、文档还是旧值。把这个未提交的输入交给保存前 flush 就能对上。
 */
export function createConstInputDrafts (
  commit: (draft: ConstInputDraft) => void | Promise<void>,
  currentEpoch: () => number,
) {
  let pending: ConstInputDraft | null = null
  return {
    track (draft: ConstInputDraft): void {
      pending = draft
    },
    /** change/blur 已经提交过这份输入：草稿作废，避免保存时重复写一次。 */
    released (stepId: string, field: string): void {
      if (pending !== null && pending.stepId === stepId && pending.field === field) pending = null
    },
    discard (): void {
      pending = null
    },
    /** 保存前调用：只提交当前文档的草稿，并等它落入文档。 */
    async flush (): Promise<void> {
      const draft = pending
      pending = null
      if (draft !== null && draft.epoch === currentEpoch()) await commit(draft)
    },
    peek (): ConstInputDraft | null {
      return pending
    },
  }
}
