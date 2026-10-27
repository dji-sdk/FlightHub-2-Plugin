// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/** FH2 插件平台首期固定 Host 集合。 */
export const HOST_IDS = ['cockpit', 'plan', 'message', 'project'] as const

export type HostId = (typeof HOST_IDS)[number]

export function isHostId (value: string): value is HostId {
  return (HOST_IDS as readonly string[]).includes(value)
}
