// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/** 生成违停证据图片（SVG data URL）与地图照片图钉图标。 */

export interface EvidenceImageInput {
  readonly plate: string;
  readonly label: string;
  readonly index: number;
  readonly capturedAt: number;
  readonly bodyColor: string;
}

function pad2 (n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function formatClock (ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/**
 * 证据图：640×360 俯视路面场景 + 车身 + 车牌 + 时间戳 + 类型标签。
 * 初检截图与复检照片用视角/配色区分。
 */
export function createEvidenceImageUrl (input: EvidenceImageInput): string {
  const time = formatClock(input.capturedAt)
  const isRecheck = input.label !== '初检截图'
  const carX = isRecheck ? 190 : 205
  const carW = isRecheck ? 260 : 230
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">`
    + `<rect width="640" height="360" fill="#171717"/>`
    + `<rect y="252" width="640" height="108" fill="#292524"/>`
    + `<path d="M0 306H640" stroke="#57534e" stroke-width="4" stroke-dasharray="36 20"/>`
    + `<rect x="0" y="120" width="150" height="130" fill="#1c1917"/>`
    + `<rect x="490" y="120" width="150" height="130" fill="#1c1917"/>`
    + `<rect x="${carX}" y="118" width="${carW}" height="134" rx="16" fill="${input.bodyColor}" stroke="#0a0a0a" stroke-width="3"/>`
    + `<rect x="${carX + 22}" y="132" width="${carW - 44}" height="34" rx="8" fill="rgba(255,255,255,.28)"/>`
    + `<rect x="${carX + 22}" y="204" width="${carW - 44}" height="34" rx="8" fill="rgba(255,255,255,.28)"/>`
    + `<text x="24" y="40" fill="#fafaf9" font-size="22" font-family="sans-serif">${input.plate}</text>`
    + `<text x="24" y="66" fill="#a8a29e" font-size="16" font-family="sans-serif">${input.label}${input.index > 0 ? ` #${input.index}` : ''}</text>`
    + `<text x="540" y="40" fill="#fafaf9" font-size="18" font-family="sans-serif">${time}</text>`
    + `</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/**
 * 地图照片图钉：48×54，蓝色描边（对齐原生 #268AFF），内嵌缩略图。
 * SVG 以 <img> 渲染时内部只允许 data: 引用，缩略图本身是 data URL，可以内嵌。
 */
export function createPhotoMarkerIcon (thumbUrl: string, accent = '#268AFF'): string {
  const imageTag = thumbUrl
    ? `<image href="${thumbUrl}" x="8" y="6" width="32" height="32" preserveAspectRatio="xMidYMid slice"/>`
    : `<rect x="8" y="6" width="32" height="32" rx="4" fill="#3f3f46"/>`
      + `<path d="M17 15l9 7-9 7z" fill="#d4d4d8"/>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="54">`
    + `<rect x="4" y="2" width="40" height="40" rx="10" fill="#18181b" stroke="${accent}" stroke-width="2"/>${
      imageTag
    }<path d="M24 40L17 52h14z" fill="${accent}"/>`
    + `</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
