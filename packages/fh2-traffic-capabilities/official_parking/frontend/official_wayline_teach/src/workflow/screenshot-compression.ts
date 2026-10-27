// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024

type CanvasTarget = OffscreenCanvas | HTMLCanvasElement

function createCanvas (width: number, height: number): CanvasTarget | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

async function canvasToJpeg (canvas: CanvasTarget, quality: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: 'image/jpeg', quality })
  }
  if (!(canvas instanceof HTMLCanvasElement)) return null
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
}

async function renderJpeg (bitmap: ImageBitmap, scale: number, quality: number): Promise<Blob | null> {
  const canvas = createCanvas(
    Math.max(1, Math.round(bitmap.width * scale)),
    Math.max(1, Math.round(bitmap.height * scale)),
  )
  const context = canvas?.getContext('2d')
  if (!canvas || !context || !('drawImage' in context)) return null
  const drawing = context as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  drawing.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvasToJpeg(canvas, quality)
}

/** 按方案依次尝试 q=0.7 与 1920px 宽缩放，浏览器不支持时让服务端返回 413。 */
export async function compressScreenshot (blob: Blob): Promise<Blob> {
  if (blob.size <= MAX_SCREENSHOT_BYTES || typeof createImageBitmap !== 'function') return blob
  const bitmap = await createImageBitmap(blob)
  try {
    const lowerQuality = await renderJpeg(bitmap, 1, 0.7)
    if (lowerQuality && lowerQuality.size <= MAX_SCREENSHOT_BYTES) return lowerQuality
    const scale = Math.min(1, 1920 / bitmap.width)
    const resized = await renderJpeg(bitmap, scale, 0.7)
    return resized ?? lowerQuality ?? blob
  } finally {
    bitmap.close()
  }
}
