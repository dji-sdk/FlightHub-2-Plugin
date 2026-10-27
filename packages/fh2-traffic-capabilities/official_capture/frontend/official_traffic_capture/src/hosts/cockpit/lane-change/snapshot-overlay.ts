// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * confirm 码流截图叠绘：把「被压标线 + 涉事车辆 bbox」画到截图上，产出合成图。
 *
 * 坐标系：normalizedPoints 与 bbox 均为 [0,1] 归一化，且与 confirm 瞬间截图同帧同投影，
 * 直接乘以截图像素即可对齐（宿主 captureFrame 按 videoWidth/videoHeight 整帧 drawImage，无 letterbox）。
 *
 * 配色与直播标注画布保持一致（原生 draw-snapshot-overlay.ts）：标线描边 #FFD800、
 * 导流区填充 rgba(255,216,0,0.15)、涉事车辆 bbox 红框 #FF3B30。
 *
 * 任一步骤失败返回 null，由调用方降级使用裸截图，不阻断抓拍/上报/录像。
 */

/** 叠绘所需的归一化几何（confirm 瞬间的标注投影 + 同帧检测 bbox）。 */
export interface SnapshotOverlay {
  /** 标线类型：line=实线（polyline）/ polygon=导流区。 */
  readonly kind: 'line' | 'polygon';
  /** 标线归一化点 [0,1]；不足 2 点表示无标线可画（仅画 bbox）。 */
  readonly normalizedPoints: ReadonlyArray<{ readonly x: number; readonly y: number }>;
  /** 涉事车辆 bbox（归一化 [0,1]）；缺省表示无 bbox 可画（仅画标线）。 */
  readonly bbox?: {
    readonly cx: number;
    readonly cy: number;
    readonly w: number;
    readonly h: number;
  } | undefined;
}

export interface OverlayPolylineOp {
  readonly op: 'stroke-polyline';
  readonly points: ReadonlyArray<{ readonly x: number; readonly y: number }>;
  readonly strokeStyle: string;
  readonly lineWidth: number;
}

export interface OverlayPolygonOp {
  readonly op: 'fill-stroke-polygon';
  readonly points: ReadonlyArray<{ readonly x: number; readonly y: number }>;
  readonly strokeStyle: string;
  readonly fillStyle: string;
  readonly lineWidth: number;
}

export interface OverlayRectOp {
  readonly op: 'stroke-rect';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly strokeStyle: string;
  readonly lineWidth: number;
}

export type OverlayOp = OverlayPolylineOp | OverlayPolygonOp | OverlayRectOp

const LINE_STROKE_COLOR = '#FFD800'
const POLYGON_FILL_COLOR = 'rgba(255, 216, 0, 0.15)'
const BBOX_STROKE_COLOR = '#FF3B30'

/** 归一化几何 + 截图像素尺寸 → 绘制指令（纯函数，先标线后 bbox）。 */
export function buildOverlayOps (overlay: SnapshotOverlay, width: number, height: number): readonly OverlayOp[] {
  const ops: OverlayOp[] = []
  const lineWidth = Math.max(2, width / 400)

  const pts = overlay.normalizedPoints
  if (pts.length >= 2) {
    const points = pts.map(point => ({ x: point.x * width, y: point.y * height }))
    if (overlay.kind === 'polygon' && pts.length >= 3) {
      ops.push({ op: 'fill-stroke-polygon', points, strokeStyle: LINE_STROKE_COLOR, fillStyle: POLYGON_FILL_COLOR, lineWidth })
    } else {
      ops.push({ op: 'stroke-polyline', points, strokeStyle: LINE_STROKE_COLOR, lineWidth })
    }
  }

  const bbox = overlay.bbox
  if (bbox && bbox.w > 0 && bbox.h > 0) {
    ops.push({
      op: 'stroke-rect',
      x: (bbox.cx - bbox.w / 2) * width,
      y: (bbox.cy - bbox.h / 2) * height,
      width: bbox.w * width,
      height: bbox.h * height,
      strokeStyle: BBOX_STROKE_COLOR,
      lineWidth,
    })
  }
  return ops
}

/** 2D 绘图环境的最小结构子集；生产为 canvas 2d context，测试注入录制实现。 */
export interface OverlayContext2d {
  drawImage (image: CanvasImageSource, dx: number, dy: number): void;
  beginPath (): void;
  moveTo (x: number, y: number): void;
  lineTo (x: number, y: number): void;
  closePath (): void;
  stroke (): void;
  fill (): void;
  strokeRect (x: number, y: number, w: number, h: number): void;
  setLineDash (segments: number[]): void;
  lineWidth: number;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineJoin: CanvasLineJoin;
  lineCap: CanvasLineCap;
}

/** 把绘制指令翻译为 2d context 调用；不足 2 点的指令直接跳过。 */
export function paintOverlayOps (context: OverlayContext2d, ops: readonly OverlayOp[]): void {
  for (const op of ops) {
    context.lineWidth = op.lineWidth
    context.strokeStyle = op.strokeStyle

    if (op.op === 'stroke-rect') {
      context.setLineDash([])
      context.strokeRect(op.x, op.y, op.width, op.height)
      continue
    }

    const first = op.points[0]
    if (!first) continue
    context.lineJoin = 'round'
    context.lineCap = 'round'
    context.beginPath()
    context.moveTo(first.x, first.y)
    for (let index = 1; index < op.points.length; index += 1) {
      const point = op.points[index]
      if (point) context.lineTo(point.x, point.y)
    }
    if (op.op === 'fill-stroke-polygon') {
      context.closePath()
      context.fillStyle = op.fillStyle
      context.fill()
    }
    context.stroke()
  }
}

function loadImage (url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

function canvasToPngBlob (canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(blob => resolve(blob), 'image/png')
  })
}

/**
 * 截图 blob + 叠绘几何 → 合成 PNG blob。
 * 图像加载、画布创建或导出失败（含非浏览器环境）返回 null，由调用方降级。
 */
export async function composeSnapshotOverlay (frame: Blob, overlay: SnapshotOverlay): Promise<Blob | null> {
  try {
    const objectUrl = URL.createObjectURL(frame)
    try {
      const image = await loadImage(objectUrl)
      if (!image || !image.width || !image.height) return null
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const context = canvas.getContext('2d')
      if (!context) return null
      context.drawImage(image, 0, 0)
      paintOverlayOps(context, buildOverlayOps(overlay, image.width, image.height))
      return await canvasToPngBlob(canvas)
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  } catch {
    return null
  }
}
