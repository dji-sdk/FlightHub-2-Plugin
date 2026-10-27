// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { extractHandlerExports } from './compiler.js'

describe('extractHandlerExports', () => {
  it('export function h_*（h_ 模式）', () => {
    const source = 'export function h_get(input) { return input }'
    const result = extractHandlerExports(source)
    expect(result.hPrefixed).toEqual(['h_get'])
    expect(result.other).toEqual([])
  })

  it('export function 不带 h_（目录派生模式）', () => {
    const source = 'export function getEvent(input) { return input }'
    const result = extractHandlerExports(source)
    expect(result.hPrefixed).toEqual([])
    expect(result.other).toEqual(['getEvent'])
  })

  it('export async function 两种模式', () => {
    const source = 'export async function h_async() {}\nexport async function plain() {}'
    const result = extractHandlerExports(source)
    expect(result.hPrefixed).toEqual(['h_async'])
    expect(result.other).toEqual(['plain'])
  })

  it('export const 箭头函数', () => {
    const source = 'export const h_arrow = (input) => input\nexport const plainArrow = (input) => input'
    const result = extractHandlerExports(source)
    expect(result.hPrefixed).toEqual(['h_arrow'])
    expect(result.other).toEqual(['plainArrow'])
  })

  it('export const function 表达式', () => {
    const source = 'export const h_fn = function(input) { return input }'
    const result = extractHandlerExports(source)
    expect(result.hPrefixed).toEqual(['h_fn'])
  })

  it('只将运行时函数值导出识别为 Handler', () => {
    const source = [
      'function decorate (_target: unknown) {}',
      '@decorate',
      'export class Decorated {}',
      'export enum Status { Ready = "ready" }',
      'export namespace Metadata { export const label = Status.Ready }',
      'export type Input = { id: string }',
      'export interface Output { id: string }',
      'export const config = { status: Status.Ready }',
      'export const arrow = (input: Input): Output => ({ id: input.id })',
      'export const expression = function (input: Input): Output { return { id: input.id } }',
      'export function named (input: Input): Output { return { id: input.id } }',
    ].join('\n')

    const result = extractHandlerExports(source)

    expect(result.hPrefixed).toEqual([])
    expect(result.other).toEqual(['arrow', 'expression', 'named'])
  })

  it('export { a, b } 命名导出列表', () => {
    const source = 'function h_a() {}\nfunction h_b() {}\nexport { h_a, h_b }'
    const result = extractHandlerExports(source)
    expect(result.hPrefixed).toEqual(['h_a', 'h_b'])
  })

  it('export { xxx as h_alias } 重命名导出', () => {
    const source = 'function getEvent() {}\nexport { getEvent as h_getEvent }'
    const result = extractHandlerExports(source)
    expect(result.hPrefixed).toEqual(['h_getEvent'])
    expect(result.other).toEqual([])
  })

  it('export { xxx as yyy } 无 h_ 别名', () => {
    const source = 'function getEvent() {}\nexport { getEvent as fetchEvent }'
    const result = extractHandlerExports(source)
    expect(result.hPrefixed).toEqual([])
    expect(result.other).toEqual(['fetchEvent'])
  })

  it('命名导出列表只提取本地函数绑定', () => {
    const source = [
      'const h_data = { enabled: true }',
      'const h_arrow = (input) => input',
      'type Internal = { enabled: boolean }',
      'export { h_data, h_arrow }',
      'export type { Internal }',
    ].join('\n')
    const result = extractHandlerExports(source)
    expect(result.hPrefixed).toEqual(['h_arrow'])
    expect(result.other).toEqual([])
  })

  it('export { xxx } from "..." re-export', () => {
    const source = 'export { h_reexported } from "../shared/index.js"'
    const result = extractHandlerExports(source)
    expect(result.hPrefixed).toEqual(['h_reexported'])
  })

  it('混合：同一文件 h_ 和非 h_ 并存', () => {
    const source = [
      'import { db } from "../shared/db.js"',
      'export function h_legacy(input) { return db(input) }',
      'export function modern(input) { return db(input) }',
      'export const h_arrowFn = (input) => db(input)',
      'export const modernArrow = (input) => db(input)',
    ].join('\n')
    const result = extractHandlerExports(source)
    expect([...result.hPrefixed].sort()).toEqual(['h_arrowFn', 'h_legacy'])
    expect([...result.other].sort()).toEqual(['modern', 'modernArrow'])
  })

  it('字符串中的 export 不误报', () => {
    const source = [
      'const msg = "export function h_fake() {}"',
      'export function h_real() { return msg }',
    ].join('\n')
    const result = extractHandlerExports(source)
    expect(result.hPrefixed).toEqual(['h_real'])
  })

  it('注释中的 export 不误报', () => {
    const source = [
      '// export function h_commented() {}',
      '/* export const h_blocked = 1 */',
      'export function h_actual() {}',
    ].join('\n')
    const result = extractHandlerExports(source)
    expect(result.hPrefixed).toEqual(['h_actual'])
  })

  it('非函数 export(对象/常量/as const 枚举)不是 Handler 入口', () => {
    const source = 'export const config = { a: 1 }\nexport const Statuses = [\'a\'] as const\nexport function h_ok() {}'
    const result = extractHandlerExports(source)
    expect(result.hPrefixed).toEqual(['h_ok'])
    expect(result.other).toEqual([])
  })

  it('函数值的 export const(箭头函数/function 表达式)是入口', () => {
    const source = 'export const handler = function (input) { return input }\nexport const h_arrow = (input) => input'
    const result = extractHandlerExports(source)
    expect(result.hPrefixed).toEqual(['h_arrow'])
    expect(result.other).toEqual(['handler'])
  })

  it('export default 不视为 Handler 入口', () => {
    const source = 'export default function handler() {}\nexport function h_ok() {}'
    const result = extractHandlerExports(source)
    expect(result.hPrefixed).toEqual(['h_ok'])
    expect(result.other).toEqual([])
  })
})
