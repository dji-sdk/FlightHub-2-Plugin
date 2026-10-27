// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type App, createApp, nextTick } from 'vue'
import WorkbenchView from './WorkbenchView.vue'
import type { LaneChangeWorkbenchState } from './contract'

/**
 * 抓拍按钮契约：paused 态不再显示「暂停中」，
 * 而是回到「开始抓拍」的蓝色主按钮（无 paused/capturing 样式类），点击恢复抓拍。
 */

function createState (overrides: Partial<LaneChangeWorkbenchState> = {}): LaneChangeWorkbenchState {
  return {
    panelVisible: true,
    panelCollapsed: false,
    enabled: true,
    captureStatus: 'idle',
    violationType: 'both',
    annotations: [{
      id: 'a1',
      name: '实线 1',
      kind: 'solid-line',
      loaded: true,
      coordinateMode: 'geo',
      createdAt: 2,
    }],
    highlightedAnnotationId: null,
    drawingKind: null,
    editing: false,
    captureBusy: false,
    message: null,
    ...overrides,
  }
}

function createClientHarness () {
  const methods = {
    setCollapsed: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    setViolationType: vi.fn(async () => {}),
    toggleAnnotationLoaded: vi.fn(async () => {}),
    requestRename: vi.fn(async () => {}),
    deleteAnnotation: vi.fn(async () => {}),
    setHighlight: vi.fn(async () => {}),
    beginDraw: vi.fn(async () => {}),
    finishEdit: vi.fn(async () => {}),
    beginEdit: vi.fn(async () => {}),
    toggleCapture: vi.fn(async () => {}),
  }
  const listeners = new Set<(value: LaneChangeWorkbenchState) => void>()
  const client = {
    state: {
      subscribe (listener: (value: LaneChangeWorkbenchState) => void) {
        listeners.add(listener)
        return {
          dispose: () => {
            listeners.delete(listener)
          },
        }
      },
    },
    ...methods,
  }
  return {
    client,
    methods,
    async push (value: LaneChangeWorkbenchState): Promise<void> {
      for (const listener of [...listeners]) listener(value)
      await nextTick()
    },
  }
}

const mountedApps: App[] = []

function mountWorkbench (client: unknown): void {
  const overlay = document.createElement('div')
  document.body.appendChild(overlay)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(WorkbenchView, { client, overlayElement: overlay })
  app.mount(container)
  mountedApps.push(app)
}

function captureButton (): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>('[data-testid="capture-toggle"]')
  if (!button) throw new Error('抓拍按钮未渲染')
  return button
}

describe('lane-change workbench', () => {
  afterEach(() => {
    while (mountedApps.length > 0) mountedApps.pop()?.unmount()
    document.body.innerHTML = ''
  })

  it('idle：显示「开始抓拍」，默认主按钮样式', async () => {
    const harness = createClientHarness()
    mountWorkbench(harness.client)
    await harness.push(createState())

    const button = captureButton()
    expect(button.textContent?.trim()).toBe('开始抓拍')
    expect(button.classList.contains('capturing')).toBe(false)
    expect(button.classList.contains('paused')).toBe(false)
    expect(button.disabled).toBe(false)
  })

  it('capturing：显示「暂停抓拍」并进入 capturing 态', async () => {
    const harness = createClientHarness()
    mountWorkbench(harness.client)
    await harness.push(createState({ captureStatus: 'capturing' }))

    const button = captureButton()
    expect(button.textContent?.trim()).toBe('暂停抓拍')
    expect(button.classList.contains('capturing')).toBe(true)
  })

  it('paused：回到「开始抓拍」蓝色主按钮，无 paused 态样式，点击恢复抓拍', async () => {
    const harness = createClientHarness()
    mountWorkbench(harness.client)
    await harness.push(createState({ captureStatus: 'paused' }))

    const button = captureButton()
    expect(button.textContent?.trim()).toBe('开始抓拍')
    expect(button.classList.contains('paused')).toBe(false)
    expect(button.classList.contains('capturing')).toBe(false)
    expect(button.disabled).toBe(false)

    button.click()
    await nextTick()
    expect(harness.methods.toggleCapture).toHaveBeenCalledTimes(1)
  })

  it('captureBusy：显示「处理中…」并禁用', async () => {
    const harness = createClientHarness()
    mountWorkbench(harness.client)
    await harness.push(createState({ captureBusy: true }))

    const button = captureButton()
    expect(button.textContent?.trim()).toBe('处理中…')
    expect(button.disabled).toBe(true)
  })

  it('禁用删除按钮不显示 Tooltip，已有 Tooltip 在进入绘制态时立即关闭', async () => {
    const harness = createClientHarness()
    mountWorkbench(harness.client)
    await harness.push(createState())

    const deleteButton = document.querySelector<HTMLButtonElement>('[data-testid="annotation-delete"]')!
    deleteButton.dispatchEvent(new MouseEvent('mouseenter'))
    await nextTick()
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('删除')

    await harness.push(createState({ drawingKind: 'solid-line' }))
    expect(deleteButton.disabled).toBe(true)
    expect(document.querySelector('[role="tooltip"]')).toBeNull()

    deleteButton.dispatchEvent(new MouseEvent('mouseenter'))
    await nextTick()
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('删除确认态在按钮禁用时清理，恢复后仍需两次点击才删除', async () => {
    const harness = createClientHarness()
    mountWorkbench(harness.client)
    await harness.push(createState())

    const deleteButton = document.querySelector<HTMLButtonElement>('[data-testid="annotation-delete"]')!
    deleteButton.click()
    await nextTick()
    expect(deleteButton.classList.contains('active')).toBe(true)
    expect(harness.methods.deleteAnnotation).not.toHaveBeenCalled()

    await harness.push(createState({ editing: true }))
    expect(deleteButton.disabled).toBe(true)
    expect(deleteButton.classList.contains('active')).toBe(false)

    await harness.push(createState())
    deleteButton.click()
    await nextTick()
    expect(harness.methods.deleteAnnotation).not.toHaveBeenCalled()
    deleteButton.click()
    await nextTick()
    expect(harness.methods.deleteAnnotation).toHaveBeenCalledWith({ id: 'a1' })
  })

  it('删除或切换类型时主动关闭当前操作 Tooltip', async () => {
    const harness = createClientHarness()
    mountWorkbench(harness.client)
    await harness.push(createState())

    const deleteButton = document.querySelector<HTMLButtonElement>('[data-testid="annotation-delete"]')!
    deleteButton.dispatchEvent(new MouseEvent('mouseenter'))
    await nextTick()
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull()
    deleteButton.click()
    deleteButton.click()
    await nextTick()
    expect(document.querySelector('[role="tooltip"]')).toBeNull()

    const renameButton = document.querySelector<HTMLButtonElement>('[data-testid="annotation-rename"]')!
    renameButton.dispatchEvent(new MouseEvent('mouseenter'))
    await nextTick()
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull()
    const typeSelect = document.querySelector<HTMLSelectElement>('[data-testid="violation-type-select"]')!
    typeSelect.value = 'guideArea'
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })
})
