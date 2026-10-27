// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type App, createApp, nextTick } from 'vue'
import LaneChangeAnnotationCanvas from './LaneChangeAnnotationCanvas.vue'
import type { LaneChangeCanvasState } from './contract'

/**
 * 右键菜单交互回归：菜单按钮的 mousedown 冒泡到画布根曾把菜单清空，
 * 随后的 click 读到空菜单导致「删除标注 / 删除顶点 / 插入顶点」点击无效果。
 * 这里直接挂载真实 SFC 验证事件接线（纯逻辑命中测试由 controller 侧覆盖）。
 */

function createState (overrides: Partial<LaneChangeCanvasState> = {}): LaneChangeCanvasState {
  return {
    visible: true,
    shapes: [{
      id: 'shape-1',
      kind: 'solid-line',
      points: [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }],
      coordinateMode: 'normalized',
    }],
    draftPoints: [],
    drawingKind: null,
    editing: true,
    selectedShapeId: null,
    highlightedShapeId: null,
    ...overrides,
  }
}

function createClientHarness () {
  const methods = {
    addDraftPoint: vi.fn(async () => {}),
    removeLastDraftPoint: vi.fn(async () => {}),
    finishDraft: vi.fn(async () => {}),
    cancelDraft: vi.fn(async () => {}),
    selectShape: vi.fn(async () => {}),
    moveVertex: vi.fn(async () => {}),
    moveShape: vi.fn(async () => {}),
    insertVertex: vi.fn(async () => {}),
    deleteVertex: vi.fn(async () => {}),
    deleteShape: vi.fn(async () => {}),
  }
  const listeners = new Set<(value: LaneChangeCanvasState) => void>()
  const client = {
    state: {
      subscribe (listener: (value: LaneChangeCanvasState) => void) {
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
    async push (value: LaneChangeCanvasState): Promise<void> {
      for (const listener of [...listeners]) listener(value)
      await nextTick()
    },
  }
}

const mountedApps: App[] = []

async function mountCanvas (client: unknown): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(LaneChangeAnnotationCanvas, { client })
  app.mount(container)
  mountedApps.push(app)
  await nextTick()
  const root = container.querySelector<HTMLElement>('[data-plugin-view="lane-change-annotation-canvas"]')
  if (!root) throw new Error('画布根节点未挂载')
  // happy-dom 的 getBoundingClientRect 返回 0：把根节点矩形固定为 100×100，clientX/Y 即归一化坐标 ×100
  root.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100 }) as DOMRect
  return root
}

function dispatch (element: Element, type: string, init: MouseEventInit = {}): void {
  element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
}

function menuButtonLabels (): string[] {
  return [...document.querySelectorAll('.context-menu button')]
    .map(button => button.textContent?.trim() ?? '')
}

function findMenuButton (label: string): HTMLButtonElement | null {
  return [...document.querySelectorAll<HTMLButtonElement>('.context-menu button')]
    .find(button => button.textContent?.trim() === label) ?? null
}

describe('lane-change annotation canvas 右键菜单', () => {
  afterEach(() => {
    while (mountedApps.length > 0) mountedApps.pop()?.unmount()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('编辑态右键顶点：菜单按钮 mousedown 不得关闭菜单，删除顶点调用 client', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe (): void {}
      unobserve (): void {}
      disconnect (): void {}
    })
    const harness = createClientHarness()
    const root = await mountCanvas(harness.client)
    await harness.push(createState())

    // (20, 50) → 归一化 (0.2, 0.5)，命中第一个顶点
    dispatch(root, 'contextmenu', { clientX: 20, clientY: 50 })
    await nextTick()
    expect(menuButtonLabels()).toEqual(['删除顶点', '删除标注'])

    const button = findMenuButton('删除顶点')
    expect(button).not.toBeNull()
    // 回归点：菜单按钮 mousedown 冒泡到画布根曾把菜单清空
    dispatch(button!, 'mousedown', { button: 0 })
    await nextTick()
    expect(document.querySelector('.context-menu')).not.toBeNull()

    dispatch(button!, 'click', { button: 0 })
    await nextTick()
    expect(harness.methods.deleteVertex).toHaveBeenCalledWith({ shapeId: 'shape-1', vertexIndex: 0 })
    expect(document.querySelector('.context-menu')).toBeNull()
  })

  it('右键线段中点：插入顶点以右键点位写入 client', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe (): void {}
      unobserve (): void {}
      disconnect (): void {}
    })
    const harness = createClientHarness()
    const root = await mountCanvas(harness.client)
    await harness.push(createState())

    // (50, 50) → 归一化 (0.5, 0.5)，命中线段（距两顶点均 0.3 > 阈值）
    dispatch(root, 'contextmenu', { clientX: 50, clientY: 50 })
    await nextTick()
    expect(menuButtonLabels()).toEqual(['插入顶点', '删除标注'])

    const button = findMenuButton('插入顶点')
    dispatch(button!, 'mousedown', { button: 0 })
    dispatch(button!, 'click', { button: 0 })
    await nextTick()
    expect(harness.methods.insertVertex).toHaveBeenCalledWith({
      shapeId: 'shape-1',
      segmentIndex: 0,
      point: { x: 0.5, y: 0.5 },
    })
  })

  it('菜单删除标注：调用 client.deleteShape 并关闭菜单', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe (): void {}
      unobserve (): void {}
      disconnect (): void {}
    })
    const harness = createClientHarness()
    const root = await mountCanvas(harness.client)
    await harness.push(createState())

    dispatch(root, 'contextmenu', { clientX: 50, clientY: 50 })
    await nextTick()
    const button = findMenuButton('删除标注')
    dispatch(button!, 'mousedown', { button: 0 })
    dispatch(button!, 'click', { button: 0 })
    await nextTick()
    expect(harness.methods.deleteShape).toHaveBeenCalledWith({ shapeId: 'shape-1' })
    expect(document.querySelector('.context-menu')).toBeNull()
  })

  it('菜单外画布 mousedown 关闭菜单', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe (): void {}
      unobserve (): void {}
      disconnect (): void {}
    })
    const harness = createClientHarness()
    const root = await mountCanvas(harness.client)
    await harness.push(createState())

    dispatch(root, 'contextmenu', { clientX: 20, clientY: 50 })
    await nextTick()
    expect(document.querySelector('.context-menu')).not.toBeNull()

    // 画布空白处 mousedown：菜单关闭
    dispatch(root, 'mousedown', { button: 0, clientX: 5, clientY: 5 })
    await nextTick()
    expect(document.querySelector('.context-menu')).toBeNull()
  })

  it('非编辑态右键不打开菜单', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe (): void {}
      unobserve (): void {}
      disconnect (): void {}
    })
    const harness = createClientHarness()
    const root = await mountCanvas(harness.client)
    await harness.push(createState({ editing: false }))

    dispatch(root, 'contextmenu', { clientX: 20, clientY: 50 })
    await nextTick()
    expect(document.querySelector('.context-menu')).toBeNull()
  })
})
