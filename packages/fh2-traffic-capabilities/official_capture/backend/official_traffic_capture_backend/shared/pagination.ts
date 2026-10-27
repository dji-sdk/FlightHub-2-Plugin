// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
export interface PageBounds {
  readonly page: number
  readonly size: number
  readonly offset: number
}

export function pageBounds (input: Record<string, unknown>, defaultSize: number, maxSize: number): PageBounds {
  let page = Math.floor(Number(input.page) || 1)
  let size = Math.floor(Number(input.page_size) || defaultSize)
  if (page < 1) page = 1
  if (size < 1) size = defaultSize
  if (size > maxSize) size = maxSize
  return { page, size, offset: (page - 1) * size }
}
