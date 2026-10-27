// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/** 生成交通抓拍 Mock 证据图片（SVG data URL）。 */

function pad2 (n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function formatClock (ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** 变道证据图：俯视路面 + 黄色标线/导流区 + 涉事车辆红框。 */
export function createLaneChangeEvidenceImageUrl (input: {
  readonly collisionType: 'solid_line' | 'guide_area';
  readonly index: number;
  readonly capturedAt: number;
}): string {
  const time = formatClock(input.capturedAt)
  const isSolid = input.collisionType === 'solid_line'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">`
    + `<rect width="640" height="360" fill="#171717"/>`
    + `<rect y="252" width="640" height="108" fill="#292524"/>${
      isSolid
        ? `<path d="M110 300L530 300" stroke="#FFD800" stroke-width="6"/>`
        : `<path d="M150 320L320 190L490 320Z" fill="rgba(0,212,255,.35)" stroke="#00D4FF" stroke-width="5"/>`
    }<rect x="238" y="196" width="164" height="96" rx="12" fill="#dc2626" stroke="#FF3183" stroke-width="4" fill-opacity="0.9"/>`
    + `<rect x="252" y="208" width="136" height="26" rx="6" fill="rgba(255,255,255,.3)"/>`
    + `<rect x="252" y="252" width="136" height="26" rx="6" fill="rgba(255,255,255,.3)"/>`
    + `<text x="24" y="40" fill="#fafaf9" font-size="22" font-family="sans-serif">违章变道抓拍</text>`
    + `<text x="24" y="66" fill="#a8a29e" font-size="16" font-family="sans-serif">${isSolid ? '压实线' : '导流区'} #${input.index}</text>`
    + `<text x="540" y="40" fill="#fafaf9" font-size="18" font-family="sans-serif">${time}</text>`
    + `</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** 行人上路证据图：路面 + 行人轮廓；远景（视角宽）与近景（SPZ 变焦放大）区分。 */
export function createPersonRoadEvidenceImageUrl (input: {
  readonly phase: 'far' | 'near';
  readonly index: number;
  readonly capturedAt: number;
}): string {
  const time = formatClock(input.capturedAt)
  const near = input.phase === 'near'
  const scale = near ? 1.9 : 1
  const personX = near ? 250 : 296
  const personY = near ? 168 : 236
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">`
    + `<rect width="640" height="360" fill="#171717"/>`
    + `<rect y="252" width="640" height="108" fill="#292524"/>`
    + `<path d="M0 306H640" stroke="#57534e" stroke-width="4" stroke-dasharray="36 20"/>`
    + `<g transform="translate(${personX},${personY}) scale(${scale})">`
    + `<circle cx="24" cy="0" r="13" fill="#fbbf24"/>`
    + `<rect x="13" y="15" width="22" height="46" rx="9" fill="#00cc7a"/>`
    + `<rect x="8" y="62" width="9" height="34" rx="4" fill="#0ea5e9"/>`
    + `<rect x="31" y="62" width="9" height="34" rx="4" fill="#0ea5e9"/>`
    + `<rect x="-6" y="18" width="10" height="36" rx="4" fill="#0ea5e9" transform="rotate(-18 -1 36)"/>`
    + `<rect x="44" y="18" width="10" height="36" rx="4" fill="#0ea5e9" transform="rotate(18 49 36)"/>`
    + `</g>${
      near ? `<rect x="${personX - 14}" y="${personY - 22}" width="${96 * 1.9 / 1.9 + 60}" height="${130 * scale}" fill="none" stroke="#FF3183" stroke-width="3" stroke-dasharray="8 6" rx="6"/>` : ''
    }<text x="24" y="40" fill="#fafaf9" font-size="22" font-family="sans-serif">行人上路抓拍</text>`
    + `<text x="24" y="66" fill="#a8a29e" font-size="16" font-family="sans-serif">${near ? '近景' : '远景'} #${input.index}</text>`
    + `<text x="540" y="40" fill="#fafaf9" font-size="18" font-family="sans-serif">${time}</text>`
    + `</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
