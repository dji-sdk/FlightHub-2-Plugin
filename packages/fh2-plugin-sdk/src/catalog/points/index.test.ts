// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { PluginContext, PluginValue } from '../../contracts/index.js'
import { POINT_IDS, isCssLength, points } from './index.js'

describe('sDK 11 Point Catalog', () => {
  it('11 个 ID 唯一，Dialog 已统一为 Capability', () => {
    expect(POINT_IDS).toEqual([
      'cockpit.ui.toolbar-actions',
      'cockpit.ui.menubar',
      'cockpit.ui.live-overlay',
      'cockpit.ui.left-bottom-panels',
      'cockpit.ui.left-panel',
      'cockpit.ui.sublive-tab',
      'cockpit.ui.flight-actions',
      'cockpit.ui.live-context-menu',
      'plan.form-extensions',
      'project.sidebar-actions',
      'message.alert-popups',
    ])
    expect(POINT_IDS).not.toContain('project.routes')
    expect(new Set(POINT_IDS).size).toBe(11)
    expect(POINT_IDS).not.toContain('project.floating-panels')
    expect(POINT_IDS).not.toContain('cockpit.ui.dialog')
    expect(POINT_IDS).not.toContain('workflow.pages')
    expect(POINT_IDS).not.toContain('cockpit.map.panels')
    expect(POINT_IDS).not.toContain('cockpit.sidebar-panels')
    expect(POINT_IDS).not.toContain('cockpit.sublive-tabs')
    expect(Object.keys(points)).toEqual(POINT_IDS)
  })

  it('所有 Action Point 统一使用 onTrigger', () => {
    const actionPointIds = [
      'cockpit.ui.toolbar-actions',
      'cockpit.ui.menubar',
      'cockpit.ui.flight-actions',
      'cockpit.ui.live-context-menu',
    ] as const
    for (const pointId of actionPointIds) {
      expect(points[pointId].contract).toHaveProperty('onTrigger')
      expect(points[pointId].contract).not.toHaveProperty('onClick')
    }
  })

  it('plan 表单扩展是 multiple Point，贡献字段补丁并保留原生提交', () => {
    const point = points['plan.form-extensions']
    expect(point.multiple).toBe(true)
    const contract = point.contract
    expect(contract.anchor).toEqual({
      kind: 'static',
      type: 'enum',
      values: ['form-end', 'task-strategy:after'],
      optional: true,
    })
    expect(contract.planType).toEqual({
      kind: 'static',
      type: 'enum',
      values: ['all', 'normal', 'atob', 'manual'],
    })
    expect(contract.render).toMatchObject({ kind: 'method' })
    expect(contract.validate).toMatchObject({ kind: 'method' })
    expect(contract.onSubmit).toMatchObject({ kind: 'method' })
    expect(contract.onEditSubmit).toMatchObject({ kind: 'method', optional: true })
    expect(contract).not.toHaveProperty('active')
    expect(contract).not.toHaveProperty('onTrigger')
  })

  it('cockpit Action 使用正式 SDK 的具名槽', () => {
    expect(points['cockpit.ui.toolbar-actions'].contract.anchor).toEqual({
      kind: 'static',
      type: 'enum',
      values: ['footer-toolbar', 'footer-toolbar:before-ai'],
      optional: true,
    })
    expect(points['cockpit.ui.flight-actions'].contract.anchor).toEqual({
      kind: 'static',
      type: 'enum',
      values: ['flight-actions', 'flight-actions:after-return-home'],
      optional: true,
    })
    expect(points['cockpit.ui.menubar'].contract).not.toHaveProperty('anchor')
    expect(points['cockpit.ui.menubar'].contract).not.toHaveProperty('badge')
  })

  it('panel 与 SubLive Tab 使用独立 revealable Point', () => {
    for (const id of ['cockpit.ui.left-panel', 'cockpit.ui.sublive-tab'] as const) {
      expect(points[id].revealable).toBe(true)
      expect(points[id].contract.label).toMatchObject({ kind: 'state', type: 'string' })
      expect(points[id].contract.icon).toMatchObject({ kind: 'state', type: 'iconId', optional: true })
      expect(points[id].contract.render).toMatchObject({ kind: 'method' })
      expect(points[id].contract.width).toMatchObject({ kind: 'state', type: 'number', optional: true })
    }
  })

  it('live Overlay 发布直播路、预设偏移与四边自由定位', () => {
    const contract = points['cockpit.ui.live-overlay'].contract
    expect(contract.stream).toMatchObject({
      kind: 'static',
      values: ['DronePayload', 'DronePayloadSide', 'Fpv', 'Dock', 'Assistant', 'LensType'],
      optional: true,
    })
    expect(contract.overlayLevel).toEqual({
      kind: 'static',
      type: 'enum',
      values: ['normal', 'top'],
    })
    expect(contract.placement).toMatchObject({
      kind: 'state',
      values: ['fill', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'custom'],
    })
    expect(contract.offsetX).toMatchObject({ type: 'cssLength', optional: true })
    expect(contract.offsetY).toMatchObject({ type: 'cssLength', optional: true })
    for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
      expect(contract[edge]).toMatchObject({ type: 'cssLength', optional: true })
    }
    expect(contract).not.toHaveProperty('x')
    expect(contract).not.toHaveProperty('y')
    expect(contract).not.toHaveProperty('onPointerRevoked')
    expect(contract).not.toHaveProperty('zIndex')
    expect(contract).not.toHaveProperty('priority')
  })

  it('project 侧栏入口要求路由和 View，允许声明位置与可选工作区 View', () => {
    const contract = points['project.sidebar-actions'].contract
    expect(contract.path).toMatchObject({ kind: 'static', type: 'string' })
    expect(contract.position).toMatchObject({ kind: 'static', type: 'number', optional: true })
    expect(contract.showBadge).toMatchObject({ kind: 'state', type: 'boolean', default: false })
    expect(contract.render).toMatchObject({ kind: 'method' })
    expect(contract.renderWorkspace).toMatchObject({ kind: 'method', optional: true })
    expect(contract).not.toHaveProperty('badge')
    expect(contract).not.toHaveProperty('onTrigger')
    expect(contract).not.toHaveProperty('active')
    expect(contract).not.toHaveProperty('layout')
  })

  it('直播状态 Overlay 使用可交互且可定位的专用契约', () => {
    const contract = points['cockpit.ui.live-overlay'].contract
    expect(contract.visible).toMatchObject({ kind: 'state', default: false })
    expect(contract.interactive).toMatchObject({ kind: 'state', default: false })
    expect(contract.width).toMatchObject({ type: 'cssLength', default: 320 })
    expect(contract.height).toMatchObject({ type: 'cssLength', default: 36 })
    expect(contract.placement).toMatchObject({ type: 'enum' })
    expect(contract.render).toMatchObject({ kind: 'method' })
  })

  it('左下角面板栈不允许插件控制定位、高度或排序', () => {
    const contract = points['cockpit.ui.left-bottom-panels'].contract
    expect(contract.visible).toMatchObject({ kind: 'state', default: false })
    expect(contract.interactive).toMatchObject({ kind: 'state', default: true })
    expect(contract.width).toMatchObject({ type: 'cssLength', default: 240 })
    expect(contract.render).toMatchObject({ kind: 'method' })
    expect(contract).not.toHaveProperty('height')
    expect(contract).not.toHaveProperty('placement')
    expect(contract).not.toHaveProperty('order')
  })

  it('cssLength 接受数字、单位和计算表达式，拒绝任意 CSS', () => {
    expect(isCssLength(12)).toBe(true)
    expect(isCssLength('50%')).toBe(true)
    expect(isCssLength('calc(100% - 12px)')).toBe(true)
    expect(isCssLength('clamp(240px, 40vw, 480px)')).toBe(true)
    expect(isCssLength('var(--overlay-width)')).toBe(false)
    expect(isCssLength('url(https://example.com/x)')).toBe(false)
    expect(isCssLength('auto')).toBe(false)
  })
})

type TestContext = PluginContext<Record<string, never>, {
  'test-action': 'cockpit.ui.toolbar-actions';
  'test-menubar': 'cockpit.ui.menubar';
  'test-panel': 'cockpit.ui.left-panel';
  'test-left-bottom-panel': 'cockpit.ui.left-bottom-panels';
  'test-overlay': 'cockpit.ui.live-overlay';
  'test-tab': 'cockpit.ui.sublive-tab';
  'test-alert': 'message.alert-popups';
  'test-project': 'project.sidebar-actions';
  'test-project-panel-only': 'project.sidebar-actions';
  'test-plan-form': 'plan.form-extensions';
}>

/** 仅由 tsc 检查，不在运行时调用。 */
async function typeChecks (ctx: TestContext): Promise<void> {
  const handle = await ctx.extensions.contribute('test-action', {
    icon: 'icon',
    label: 'label',
    onTrigger ({ openView, notify }) {
      void openView
      void notify
    },
  })
  await handle.update({ active: true })
  // @ts-expect-error Cockpit SDK Action 不支持 badge
  await handle.update({ badge: 1 })

  // Menubar 与 Toolbar 一致：onTrigger 收到 ActionContext（openView 锚定按钮 Popover）
  await ctx.extensions.contribute('test-menubar', {
    icon: 'icon',
    label: 'label',
    onTrigger ({ openView, notify }) {
      void openView
      void notify
    },
  })

  await ctx.extensions.contribute('test-plan-form', {
    render: () => ({ viewId: 'plan-form', initialState: null }),
    validate: async (input) => {
      expectTypeOf(input.form.name).toEqualTypeOf<string>()
      expectTypeOf(input.form.wayline_uuid).toEqualTypeOf<string>()
      expectTypeOf(input.form.task_type).toEqualTypeOf<1 | 2 | 3 | 4 | 5 | 6 | 7>()
      expectTypeOf(input.form.vlm_enabled).toEqualTypeOf<boolean | undefined>()
      expectTypeOf(input.form.wayline_list).items.toMatchTypeOf<{ wayline_uuid: string }>()
      expectTypeOf(input.form.future_host_field).toEqualTypeOf<PluginValue>()
      return { valid: true }
    },
    onSubmit: async input => ({ patrol_capture_enabled: input.context.mode === 'create' }),
    onEditSubmit: async (input) => {
      expectTypeOf(input.context.mode).toEqualTypeOf<'edit'>()
      expectTypeOf(input.form.biz_ext).toMatchTypeOf<Record<string, PluginValue> | undefined>()
    },
  })

  const panel = await ctx.extensions.contribute('test-panel', {
    visible: false,
    label: '面板',
    render: () => ({ viewId: 'panel', initialState: null }),
  })
  await panel.reveal({ source: 'test' })

  const leftBottomPanel = await ctx.extensions.contribute('test-left-bottom-panel', {
    visible: false,
    interactive: true,
    width: 240,
    render: () => ({ viewId: 'left-bottom-panel', initialState: null }),
  })
  await leftBottomPanel.update({ visible: true })
  // @ts-expect-error 左下角面板高度由内容决定
  await leftBottomPanel.update({ height: 200 })

  const overlay = await ctx.extensions.contribute('test-overlay', {
    visible: true,
    interactive: false,
    width: 320,
    height: 36,
    placement: 'top',
    render: () => ({ viewId: 'overlay', initialState: null }),
  })
  // @ts-expect-error overlayLevel 来自 Manifest static，运行期不可更新
  await overlay.update({ overlayLevel: 'top' })

  const tab = await ctx.extensions.contribute('test-tab', {
    visible: false,
    label: '预览',
    render: () => ({ viewId: 'tab', initialState: null }),
  })
  await tab.reveal()

  await ctx.extensions.contribute('test-alert', {
    visible: true,
    render: () => ({
      viewId: 'alert',
      initialState: null,
    }),
  })

  const projectAction = await ctx.extensions.contribute('test-project', {
    icon: 'icon',
    label: 'project action',
    showBadge: false,
    render: () => ({ viewId: 'project', initialState: null }),
    renderWorkspace: () => ({ viewId: 'project-workspace', initialState: null }),
  })
  await projectAction.update({ showBadge: true })
  // @ts-expect-error Project 侧边栏只暴露布尔红点，不接收数字 badge
  await projectAction.update({ badge: 1 })
  // @ts-expect-error renderWorkspace 是 method，不允许经 update 修改
  await projectAction.update({ renderWorkspace: () => ({ viewId: 'x', initialState: null }) })

  // renderWorkspace 可选：只提供 render 合法
  await ctx.extensions.contribute('test-project-panel-only', {
    icon: 'icon',
    label: 'project panel only',
    showBadge: false,
    render: () => ({ viewId: 'project', initialState: null }),
  })

  // @ts-expect-error 未声明 extensionId
  await ctx.extensions.contribute('ghost', {})
  // @ts-expect-error 未发布的旧 API 已删除
  await ctx.extensions.register('test-action', {})
  // @ts-expect-error method 不允许 update
  await handle.update({ onTrigger: () => {} })
  // @ts-expect-error Footer Point 不支持 reveal
  await handle.reveal()
  // @ts-expect-error 全局字符串式 reveal 已删除
  await ctx.extensions.reveal('test-panel')
}

void typeChecks
