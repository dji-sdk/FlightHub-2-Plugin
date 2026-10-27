// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { blankField, isNestable, sameDraft, toDraft, toIoFields } from './script-contract.js'
import { readManifestScripts } from './store.js'

/**
 * 草稿模型的用例。核心只有一条：**嵌套那一层，读进来能出去**。
 *
 * ★★ 它不是洁癖。清单里的 `fields`（object 的成员 / array 的元素形状）是画布最容易
 * 顺手抹掉的东西 —— 用一个 `{name,type,required}` 的平铺模型读进来再写回去，
 * 那一层就没了。而没了之后 worker 的 `projectValue` 把整块原样放行：
 * 声明还在、约束消失，发布期不红、运行期不报，只有某天下游拿到一个形状不对的值。
 */

describe('toDraft / toIoFields', () => {
  it('嵌套声明往返不丢', () => {
    const original = [{
      name: 'plan',
      type: 'object',
      required: true,
      fields: [
        { name: 'waylineUuid', type: 'string', required: true },
        { name: 'legs', type: 'array', fields: [{ name: 'lat', type: 'number' }] },
      ],
    }]
    expect(toIoFields(toDraft(original))).toEqual(original)
  })

  it('required 只在为真时出现（不写一堆 required:false 进清单）', () => {
    expect(toIoFields(toDraft([{ name: 'hint', type: 'string' }])))
      .toEqual([{ name: 'hint', type: 'string' }])
  })

  it('空的 fields 不写成 fields: []', () => {
    const [field] = toIoFields(toDraft([{ name: 'x', type: 'object' }]))
    expect(field).toEqual({ name: 'x', type: 'object' })
    expect('fields' in field!).toBe(false)
  })

  it('字段名去空白，但不做任何剔除或纠正', () => {
    // 空名、词表外的类型、标量上的 fields 一律原样交给命令去拒 ——
    // 在这里先悄悄修一遍，界面显示的就和写进清单的不是同一份东西了。
    const draft = toDraft([{ name: '  spaced  ', type: 'bolean' }])
    expect(toIoFields(draft)).toEqual([{ name: 'spaced', type: 'bolean' }])
    expect(toIoFields(toDraft([{ name: '', type: 'string' }]))).toEqual([{ name: '', type: 'string' }])
  })

  it('标量上的 fields 原样带着（由命令去拒，不在这里清空）', () => {
    const draft = toDraft([{ name: 'hint', type: 'string', fields: [{ name: 'x', type: 'string' }] }])
    expect(toIoFields(draft)[0]!.fields).toHaveLength(1)
  })
})

describe('sameDraft', () => {
  it('逐字段比，深到嵌套层', () => {
    const left = toDraft([{ name: 'a', type: 'object', fields: [{ name: 'b', type: 'string' }] }])
    const right = toDraft([{ name: 'a', type: 'object', fields: [{ name: 'b', type: 'string' }] }])
    expect(sameDraft(left, right)).toBe(true)

    const changed = toDraft([{ name: 'a', type: 'object', fields: [{ name: 'b', type: 'number' }] }])
    expect(sameDraft(left, changed), '嵌套层改了类型也必须算脏').toBe(false)
  })

  it('长度不同直接不等', () => {
    expect(sameDraft(toDraft([{ name: 'a', type: 'string' }]), [])).toBe(false)
  })

  it('required 变了算脏', () => {
    expect(sameDraft(
      toDraft([{ name: 'a', type: 'string' }]),
      toDraft([{ name: 'a', type: 'string', required: true }]),
    )).toBe(false)
  })
})

describe('blankField', () => {
  it('类型取词表第一项', () => {
    expect(blankField(['string', 'number']).type).toBe('string')
  })

  it('没有词表时留空，不替用户猜一个', () => {
    expect(blankField([]).type).toBe('')
  })
})

describe('isNestable', () => {
  it('只有 object / array 能带成员', () => {
    expect(isNestable('object')).toBe(true)
    expect(isNestable('array')).toBe(true)
    for (const type of ['string', 'number', 'bool', '']) expect(isNestable(type)).toBe(false)
  })
})

describe('readManifestScripts（内存清单 → 词表）', () => {
  const MANIFEST = {
    pluginId: 'demo',
    scripts: [{
      name: 'evaluate',
      path: 'adapters/evaluate.js',
      allowlist: ['data:read'],
      io: {
        inputs: [{
          name: 'plan',
          type: 'object',
          required: true,
          fields: [{ name: 'legs', type: 'array', fields: [{ name: 'lat', type: 'number' }] }],
        }],
        outputs: [{ name: 'decision', type: 'string' }],
      },
    }],
  }

  /**
   * ⚠️ 这条守的是画布侧那一半的抹平。清单读进来若是平的，编辑器里就看不见嵌套，
   * 看不见的东西一保存就没了 —— 服务端的 readWorkspaceScripts 一直是递归的，
   * 内存这一份曾经不是，两份实现的口径差就是缺陷本身。
   */
  it('嵌套 fields 读得出来，不被摊平', () => {
    const scripts = readManifestScripts(MANIFEST, 'fh2-plugin.json')
    expect(scripts).not.toBeNull()
    const plan = scripts![0]!.inputs[0]!
    expect(plan.fields?.[0]?.fields).toEqual([{ name: 'lat', type: 'number' }])
  })

  it('解析不出来时回 null，而不是空数组', () => {
    // 空数组会让面板显示「本工程还没有业务功能」，而事实是「这一刻读不出来」。
    expect(readManifestScripts({ pluginId: 'demo' }, 'fh2-plugin.json')).toBeNull()
    expect(readManifestScripts('不是对象', 'fh2-plugin.json')).toBeNull()
  })
})
