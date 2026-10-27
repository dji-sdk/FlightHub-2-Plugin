// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { expect, it } from 'vitest'
import { localCopyPath } from './copy-path'

it('副本名按规格追加 .local-<时间>（DAG-017-08：路径末尾直接追加，不插扩展名前）', () => {
  expect(localCopyPath('src/App.vue', 1)).toBe('src/App.vue.local-1')
  expect(localCopyPath('dir/a.json', 1)).toBe('dir/a.json.local-1')
  expect(localCopyPath('LICENSE', 1)).toBe('LICENSE.local-1')
  expect(localCopyPath('.env', 1)).toBe('.env.local-1')
})
