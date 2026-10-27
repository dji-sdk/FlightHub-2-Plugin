// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface RecoveryFile {
  readonly root: string;
  readonly path: string;
  readonly content: string;
  readonly deleted: boolean;
  readonly session: string;
}

/** 与 Monaco 生命周期无关的内容副本，工作区重置不能清掉它。 */
export const useRecoveryStore = defineStore('recovery', () => {
  const files = ref<RecoveryFile[]>([])
  function retain (file: RecoveryFile): void {
    if (!files.value.some(current => current.root === file.root && current.session === file.session && current.path === file.path && current.content === file.content && current.deleted === file.deleted)) files.value.push(file)
  }
  function dismiss (file: RecoveryFile): void {
    files.value = files.value.filter(current => current !== file)
  }
  return { files, retain, dismiss }
})
