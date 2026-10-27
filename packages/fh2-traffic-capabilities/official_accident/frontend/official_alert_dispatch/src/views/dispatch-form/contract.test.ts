// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'
import { dispatchWorkspaceView } from '../dispatch-workspace/contract'
import {
  dispatchFormView,
  parseDecimalInput,
  validateAddress,
  validateAltitude,
  validateLatitude,
  validateLongitude,
} from './contract'

function readTemplate (path: string): string {
  const { descriptor, errors } = parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
  expect(errors).toEqual([])
  expect(descriptor.template).not.toBeNull()
  return descriptor.template!.content
}

function attributeValues (template: string, attribute: string): string[] {
  return Array.from(template.matchAll(new RegExp(`\\b${attribute}="([^"]*)"`, 'g')), match => match[1]!)
}

describe('警情派遣 View 命名契约', () => {
  it('保留两个 View ID，并与 Manifest 构建入口匹配', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../fh2-plugin.json', import.meta.url), 'utf8'))
    expect([dispatchFormView.viewId, dispatchWorkspaceView.viewId]).toEqual(['dispatch-form', 'dispatch-workspace'])
    expect(manifest.views).toEqual({
      [dispatchFormView.viewId]: { entry: './views/dispatch-form.js' },
      [dispatchWorkspaceView.viewId]: { entry: './views/dispatch-workspace.js' },
    })
  })

  it('表单 label for 与输入 ID 成对使用新名称', () => {
    const template = readTemplate('./DispatchForm.vue')
    const inputIds = Array.from(template.matchAll(/<n-input\b[^>]*\bid="([^"]+)"/g), match => match[1]!)
    const labelTargets = Array.from(template.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g), match => match[1]!)

    expect(inputIds).toEqual([
      'alert-dispatch-address',
      'alert-dispatch-lat',
      'alert-dispatch-lng',
      'alert-dispatch-fly-alt',
      'alert-dispatch-go-back-alt',
    ])
    expect(labelTargets).toEqual(inputIds)
    expect(attributeValues(template, 'id')).toEqual(inputIds)
    expect(attributeValues(template, 'data-plugin-view')).toEqual(['alert-dispatch-form'])
    expect(attributeValues(template, 'data-testid')).toEqual([])
    expect(template).toContain('class="dispatch-panel"')
  })

  it('工作区 View 标记与测试属性统一使用新名称', () => {
    const template = readTemplate('../dispatch-workspace/DispatchWorkspace.vue')
    expect(attributeValues(template, 'data-plugin-view')).toEqual(['alert-dispatch-workspace'])
    expect(attributeValues(template, 'data-testid')).toEqual([
      'alert-workspace-root',
      'alert-workspace-submitting',
      'alert-workspace-event-id',
      'alert-workspace-error',
    ])
    expect(template).toContain('class="dispatch-workspace"')
  })
})

describe('parseDecimalInput', () => {
  it.each([
    ['22.5431', 22.5431],
    ['114.0579', 114.0579],
    ['-30.5', -30.5],
    ['0', 0],
    ['  30.5728  ', 30.5728],
  ])('%s 解析为 %s', (input, expected) => {
    expect(parseDecimalInput(input)).toBe(expected)
  })

  it.each([
    [''],
    ['  '],
    ['1e3'],
    ['22,5431'],
    ['22.54.31'],
    ['abc'],
  ])('%s 解析为 null', (input) => {
    expect(parseDecimalInput(input)).toBeNull()
  })
})

describe('validateAddress', () => {
  it('空地址报错，100 字以内通过', () => {
    expect(validateAddress('')).toBe('请输入地址')
    expect(validateAddress('   ')).toBe('请输入地址')
    expect(validateAddress('测试道路路口')).toBeNull()
    expect(validateAddress('成'.repeat(100))).toBeNull()
  })

  it('超过 100 字报错', () => {
    expect(validateAddress('成'.repeat(101))).toBe('地址不能超过 100 字')
    expect(validateAddress(`  ${'成'.repeat(101)}  `)).toBe('地址不能超过 100 字')
  })
})

describe('validateLatitude', () => {
  it('范围 -90~90 通过，越界或非数字报错', () => {
    expect(validateLatitude('30.5728')).toBeNull()
    expect(validateLatitude('-90')).toBeNull()
    expect(validateLatitude('90')).toBeNull()
    expect(validateLatitude('90.1')).toBe('纬度范围 -90 ~ 90')
    expect(validateLatitude('abc')).toBe('纬度必须是十进制数字')
    expect(validateLatitude('')).toBe('纬度必须是十进制数字')
  })
})

describe('validateLongitude', () => {
  it('范围 -180~180 通过，越界或非数字报错', () => {
    expect(validateLongitude('104.0668')).toBeNull()
    expect(validateLongitude('-180')).toBeNull()
    expect(validateLongitude('180')).toBeNull()
    expect(validateLongitude('180.5')).toBe('经度范围 -180 ~ 180')
    expect(validateLongitude('114,05')).toBe('经度必须是十进制数字')
    expect(validateLongitude('')).toBe('经度必须是十进制数字')
  })
})

describe('validateAltitude', () => {
  it('不小于 30 米的十进制通过，默认 120 合法', () => {
    expect(validateAltitude('120')).toBeNull()
    expect(validateAltitude('150.5')).toBeNull()
    expect(validateAltitude('30')).toBeNull()
  })

  it('低于 30 米、非数字或空值报错', () => {
    expect(validateAltitude('29.9')).toBe('高度不能低于 30 米')
    expect(validateAltitude('0')).toBe('高度不能低于 30 米')
    expect(validateAltitude('-120')).toBe('高度不能低于 30 米')
    expect(validateAltitude('abc')).toBe('高度必须是十进制数字（米）')
    expect(validateAltitude('')).toBe('高度必须是十进制数字（米）')
  })
})
