// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import { collectPackMemberLeafIds, derivePackMembers, loadPackMemberNames } from './pack-members'

describe('derivePackMembers', () => {
  it('capability 根：前端插件/后端插件两组，成员 id 取 fh2-plugin.json 目录名', () => {
    const tree = derivePackMembers([
      'plugin.json',
      'capabilities.json',
      'packages.json',
      'frontend/exp_fe_a/fh2-plugin.json',
      'frontend/exp_fe_b/fh2-plugin.json',
      'frontend/exp_fe_a/src/main.ts',
      'backend/exp_be_a/fh2-plugin.json',
      'backend/exp_be_a/handlers/x.js',
      'src/unrelated.ts',
    ], 'capability-project')
    expect(tree).toEqual([
      {
        id: 'frontend',
        label: '前端插件（2）',
        children: [
          { id: 'exp_fe_a', label: 'exp_fe_a', children: [] },
          { id: 'exp_fe_b', label: 'exp_fe_b', children: [] },
        ],
      },
      {
        id: 'backend',
        label: '后端插件（1）',
        children: [
          { id: 'exp_be_a', label: 'exp_be_a', children: [] },
        ],
      },
    ])
  })

  it('capability 根：只有单侧成员时不出空分组', () => {
    const tree = derivePackMembers([
      'frontend/exp_fe_a/fh2-plugin.json',
    ], 'capability-project')
    expect(tree).toEqual([
      {
        id: 'frontend',
        label: '前端插件（1）',
        children: [{ id: 'exp_fe_a', label: 'exp_fe_a', children: [] }],
      },
    ])
  })

  it('行业工作区：capability → 前端插件/后端插件分组 → `<capId>/<memberId>` 叶子 id', () => {
    const tree = derivePackMembers([
      'packages.json',
      'cap_a/frontend/cap_a_fe/fh2-plugin.json',
      'cap_a/backend/cap_a_be/fh2-plugin.json',
      'cap_b/frontend/cap_b_fe/fh2-plugin.json',
      'cap_b/dist/fh2-plugin.json',
    ], 'industry-capability-workspace')
    expect(tree).toEqual([
      {
        id: 'cap_a',
        label: 'cap_a',
        children: [
          {
            id: 'cap_a/frontend',
            label: '前端插件（1）',
            children: [{ id: 'cap_a/cap_a_fe', label: 'cap_a_fe', children: [] }],
          },
          {
            id: 'cap_a/backend',
            label: '后端插件（1）',
            children: [{ id: 'cap_a/cap_a_be', label: 'cap_a_be', children: [] }],
          },
        ],
      },
      {
        id: 'cap_b',
        label: 'cap_b',
        children: [
          {
            id: 'cap_b/frontend',
            label: '前端插件（1）',
            children: [{ id: 'cap_b/cap_b_fe', label: 'cap_b_fe', children: [] }],
          },
        ],
      },
    ])
  })

  it('dist 里的 fh2-plugin.json 副本不会出现（树数据已过滤），根级/深嵌套的 manifest 不算成员', () => {
    const tree = derivePackMembers([
      'dist/fh2-plugin.json',
      'x/y/z/fh2-plugin.json',
      'not_a_member/fh2-plugin.json',
    ], 'capability-project')
    // 根级或深度异常的 fh2-plugin.json 不在 frontend/ 或 backend/ 下，不算成员；
    // 全部成员为空 → null（回落全量）
    expect(tree).toBeNull()
  })

  it('没有任何成员时返回 null（调用方回落全量）', () => {
    expect(derivePackMembers(['a.ts'], 'capability-project')).toBeNull()
    expect(derivePackMembers([], 'industry-capability-workspace')).toBeNull()
  })

  it('非成员级 kind 返回 null', () => {
    expect(derivePackMembers(['fh2-plugin.json'], 'frontend-plugin')).toBeNull()
    expect(derivePackMembers(['plugin.json'], 'backend-plugin')).toBeNull()
    expect(derivePackMembers([], 'unknown')).toBeNull()
  })
})

describe('collectPackMemberLeafIds', () => {
  it('递归收集叶子 id（跳过分支展示 key）', () => {
    const tree = derivePackMembers([
      'packages.json',
      'cap_a/frontend/cap_a_fe/fh2-plugin.json',
      'cap_a/backend/cap_a_be/fh2-plugin.json',
      'cap_b/frontend/cap_b_fe/fh2-plugin.json',
    ], 'industry-capability-workspace')
    expect(collectPackMemberLeafIds(tree!)).toEqual([
      'cap_a/cap_a_fe',
      'cap_a/cap_a_be',
      'cap_b/cap_b_fe',
    ])
  })

  it('capability 根两层的叶子 id 无前缀', () => {
    const tree = derivePackMembers([
      'frontend/exp_fe_a/fh2-plugin.json',
      'backend/exp_be_a/fh2-plugin.json',
    ], 'capability-project')
    expect(collectPackMemberLeafIds(tree!)).toEqual(['exp_fe_a', 'exp_be_a'])
  })
})

describe('loadPackMemberNames', () => {
  it('能力与两侧插件展示中文名称和英文标识；同名成员按各自清单读取且提交id不变', async () => {
    const tree = derivePackMembers([
      'cap_a/frontend/exp_ui/fh2-plugin.json',
      'cap_a/backend/exp_service/fh2-plugin.json',
      'cap_b/frontend/exp_ui/fh2-plugin.json',
    ], 'industry-capability-workspace')!
    const names: Record<string, string> = {
      'cap_a/capabilities.json': '事故快处',
      'cap_a/frontend/exp_ui/fh2-plugin.json': '事故面板',
      'cap_a/backend/exp_service/fh2-plugin.json': '事故处理',
      'cap_b/capabilities.json': '违停抓拍',
      'cap_b/frontend/exp_ui/fh2-plugin.json': '违停面板',
    }
    const read = vi.fn(async (path: string) => JSON.stringify({ name: names[path] }))
    const named = await loadPackMemberNames(tree, read)
    expect(named[0]?.label).toBe('事故快处（cap_a）')
    expect(named[0]?.children[0]?.children[0]?.label).toBe('事故面板（exp_ui）')
    expect(named[0]?.children[1]?.children[0]?.label).toBe('事故处理（exp_service）')
    expect(named[1]?.children[0]?.children[0]?.label).toBe('违停面板（exp_ui）')
    expect(collectPackMemberLeafIds(named)).toEqual(collectPackMemberLeafIds(tree))
    expect(read).toHaveBeenCalledTimes(5)
  })

  it('capability根读成员清单；缺失/非法name、损坏或读取失败保留原英文标识', async () => {
    const tree = derivePackMembers(['named', 'empty', 'invalid', 'broken', 'failed', 'same'].map(id => `frontend/${id}/fh2-plugin.json`), 'capability-project')!
    const sources: Record<string, string> = {
      named: '{"name":"  中文名称  "}',
      empty: '{"name":" "}',
      invalid: '{"name":123}',
      broken: '{',
      same: '{"name":"same"}',
    }
    const named = await loadPackMemberNames(tree, async (path) => {
      const id = path.split('/')[1]!
      if (id === 'failed') throw new Error('not found')
      return sources[id]!
    })
    expect(named[0]?.label).toBe('前端插件（6）')
    expect(named[0]?.children.map(node => node.label)).toEqual(['broken', 'empty', 'failed', 'invalid', '中文名称（named）', 'same'])
  })
})
