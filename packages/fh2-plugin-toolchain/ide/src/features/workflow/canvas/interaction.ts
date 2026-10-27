// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 画布 Pointer 状态机（Plan §6.1）。
 *
 * 从 workflow-canvas.ts 抽出的手势核心：视口（平移/缩放）+ 连线拖拽的
 * 状态与坐标换算。DOM 事件由 WorkflowCanvas 接线后喂进来；本模块不
 * import DOM，只用纯数值，便于单测（缩放锚点、画布坐标换算、手势互斥）。
 *
 * 手势互斥（同一时刻只有一种）：
 * - pan：空白处按下拖动；
 * - link：从节点把手按下拖到目标节点上（pointerup 才提交，§5.3）；
 * - pointercancel / 切文档一律走 {@link cancel}，不提交任何意图（P2-4）。
 */

export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export interface InteractionHost {
  /** 宿主容器尺寸（缩放锚点换算用）。 */
  size (): { readonly width: number; readonly height: number };
  /** 画布坐标命中哪个节点（矩形命中，不受 pointer capture 影响）。 */
  hitTest (canvasX: number, canvasY: number): string | null;
  /** 视口变化（平移/缩放后重挂 transform）。 */
  onViewportChange (): void;
  /** 连线预览更新（from = 起点节点；pointer 为 null 时清除预览）。 */
  onLinkPreview (from: string, pointer: { readonly x: number; readonly y: number } | null): void;
  /** 连线提交（pointerup 命中目标才发生；目标为 null 时静默丢弃）。 */
  onLinkCommit (from: string, targetId: string | null): void;
  /** 空白处左键按下（清空 selection）。 */
  onBlankPress (): void;
}

export const MIN_SCALE = 0.2
export const MAX_SCALE = 2.5
export const FIT_PADDING = 48

type Gesture = { kind: 'none' } | { kind: 'pan'; pointerX: number; pointerY: number; originX: number; originY: number } | { kind: 'link'; from: string }

export class CanvasInteraction {
  private readonly host: InteractionHost
  private viewport: Viewport = { x: 0, y: 0, scale: 1 }
  private gesture: Gesture = { kind: 'none' }

  constructor (host: InteractionHost) {
    this.host = host
  }

  getViewport (): Viewport {
    return this.viewport
  }

  setViewport (viewport: Viewport): void {
    this.viewport = viewport
    this.host.onViewportChange()
  }

  /**
   * 宿主内坐标（相对宿主左上角）→ 画布坐标。
   * 坐标换算不含宿主在页面里的偏移 —— DOM 接线层先减掉 getBoundingClientRect
   * 的 left/top 再喂进来，本模块对页面滚动保持无感。
   */
  toCanvas (localX: number, localY: number): { readonly x: number; readonly y: number } {
    return {
      x: (localX - this.viewport.x) / this.viewport.scale,
      y: (localY - this.viewport.y) / this.viewport.scale,
    }
  }

  /** 画布内锚点缩放：该点在画布坐标系里的位置保持不变。 */
  zoomAt (anchorX: number, anchorY: number, factor: number): void {
    const next = clamp(this.viewport.scale * factor, MIN_SCALE, MAX_SCALE)
    if (next === this.viewport.scale) return
    const ratio = next / this.viewport.scale
    this.setViewport({
      scale: next,
      x: anchorX - (anchorX - this.viewport.x) * ratio,
      y: anchorY - (anchorY - this.viewport.y) * ratio,
    })
  }

  /** 容器中心缩放（工具栏按钮）。 */
  zoomBy (factor: number): void {
    const box = this.host.size()
    this.zoomAt(box.width / 2, box.height / 2, factor)
  }

  resetZoom (): void {
    this.setViewport({ ...this.viewport, scale: 1 })
  }

  /** 内容包围盒缩放到「整图可见」；空内容退回 1:1，避免除零。 */
  fit (contentWidth: number, contentHeight: number): void {
    const box = this.host.size()
    if (contentWidth <= 0 || contentHeight <= 0 || box.width === 0 || box.height === 0) {
      this.setViewport({ x: FIT_PADDING, y: FIT_PADDING, scale: 1 })
      return
    }
    const scale = clamp(Math.min(
      (box.width - FIT_PADDING * 2) / contentWidth,
      (box.height - FIT_PADDING * 2) / contentHeight,
      1,
    ), MIN_SCALE, MAX_SCALE)
    this.setViewport({
      scale,
      x: (box.width - contentWidth * scale) / 2,
      y: (box.height - contentHeight * scale) / 2,
    })
  }

  /** 把一个画布坐标点滚进可视区；已在视口内则不动（每次编辑不重新定位）。 */
  reveal (target: { readonly x: number; readonly y: number }, margin: { readonly x: number; readonly y: number }): void {
    const box = this.host.size()
    if (box.width === 0 || box.height === 0) return
    const { x, y, scale } = this.viewport
    const screenX = target.x * scale + x
    const screenY = target.y * scale + y
    const visible = screenX - margin.x >= 0 && screenX + margin.x <= box.width
      && screenY - margin.y >= 0 && screenY + margin.y <= box.height
    if (visible) return
    this.setViewport({
      scale,
      x: box.width / 2 - target.x * scale,
      y: box.height / 2 - target.y * scale,
    })
  }

  // ── 手势 ────────────────────────────────────────

  /** SVG 画布空白上的 pointerdown（按钮 2 = 右键，不启手势）。坐标为宿主内坐标。 */
  pressBlank (localX: number, localY: number, button: number): void {
    if (button === 2) return
    this.gesture = {
      kind: 'pan',
      pointerX: localX,
      pointerY: localY,
      originX: this.viewport.x,
      originY: this.viewport.y,
    }
    if (button === 0) this.host.onBlankPress()
  }

  /** 节点把手上的 pointerdown：进入连线手势。坐标为宿主内坐标。 */
  pressLink (from: string, localX: number, localY: number): void {
    this.gesture = { kind: 'link', from }
    this.host.onLinkPreview(from, this.toCanvas(localX, localY))
  }

  move (localX: number, localY: number): void {
    if (this.gesture.kind === 'link') {
      this.host.onLinkPreview(this.gesture.from, this.toCanvas(localX, localY))
      return
    }
    if (this.gesture.kind === 'pan') {
      this.setViewport({
        ...this.viewport,
        x: this.gesture.originX + (localX - this.gesture.pointerX),
        y: this.gesture.originY + (localY - this.gesture.pointerY),
      })
    }
  }

  /** pointerup：pan 结束；link 在命中目标时提交（§5.3）。坐标为宿主内坐标。 */
  release (localX: number, localY: number): void {
    if (this.gesture.kind === 'link') {
      const from = this.gesture.from
      const point = this.toCanvas(localX, localY)
      this.gesture = { kind: 'none' }
      this.host.onLinkPreview(from, null)
      this.host.onLinkCommit(from, this.host.hitTest(point.x, point.y))
      return
    }
    this.gesture = { kind: 'none' }
  }

  /** 滚轮缩放（deltaMode 归一：trackpad 像素滚动 vs 鼠标行滚动差一个量级）。坐标为宿主内坐标。 */
  wheel (localX: number, localY: number, deltaY: number, deltaMode: number): void {
    const delta = deltaMode === 1 ? deltaY * 16 : deltaY
    this.zoomAt(localX, localY, Math.exp(-delta / 400))
  }

  /**
   * 丢弃一切进行中的手势，**不提交任何意图**（pointercancel / 切换文档 /
   * 组件失活都走这里 —— 半途状态指向新文档里可能已不存在的节点，P2-4）。
   */
  cancel (): void {
    if (this.gesture.kind === 'link') this.host.onLinkPreview(this.gesture.from, null)
    this.gesture = { kind: 'none' }
  }

  isLinking (): boolean {
    return this.gesture.kind === 'link'
  }
}

function clamp (value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
