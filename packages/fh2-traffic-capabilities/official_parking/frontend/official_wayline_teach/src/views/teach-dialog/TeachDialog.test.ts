// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// @vitest-environment happy-dom
import { createApp, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TeachDialog from './TeachDialog.vue'
import type { TeachDialogClient, TeachDialogState, TeachDialogWaypoint } from './contract'

let root: HTMLElement | undefined
afterEach(() => root?.remove())

function waypoint (id: string, seq: number): TeachDialogWaypoint {
  return {
    id,
    seq,
    selected: true,
    height: 10,
    cameraYaw: 0,
    gimbalPitch: -90,
    focalLength: 100,
    aiRecognitionOn: false,
    aiTargetTypes: [],
    screenshotUrl: null,
    screenshotError: null,
  }
}

function generateState (
  overrides: Partial<Extract<TeachDialogState, { kind: 'generate' }>> = {},
): TeachDialogState {
  return {
    kind: 'generate',
    defaultName: '示教复飞航线 1',
    defaultGlobalSpeed: 15,
    defaultWaypointSpeed: 5,
    selectedCount: 2,
    screenshotBytes: 0,
    screenshotQuotaBytes: 80 * 1024 * 1024,
    waypoints: [waypoint('w1', 0), waypoint('w2', 1)],
    pending: false,
    error: null,
    ...overrides,
  }
}

function conflictState (): TeachDialogState {
  return {
    kind: 'conflict',
    routeName: '旧路线',
    waypointCount: 3,
    createdAt: '2026-09-16 10:00:00',
    confirmingRecreate: false,
    pending: false,
    error: null,
  }
}

function createClient (initial: TeachDialogState) {
  let current = initial
  const listeners = new Set<(value: TeachDialogState) => void>()
  const client = {
    state: {
      subscribe (listener: (value: TeachDialogState) => void) {
        listeners.add(listener)
        listener(current)
        return {
          dispose: () => {
            listeners.delete(listener)
          },
        }
      },
    },
    cancel: vi.fn(),
    loadExisting: vi.fn(),
    requestRecreate: vi.fn(),
    recreate: vi.fn(),
    retryScreenshot: vi.fn(),
    setWaypointSelected: vi.fn(),
    generate: vi.fn(),
  }
  return {
    client: client as unknown as TeachDialogClient,
    generate: client.generate,
    push (next: TeachDialogState) {
      current = next
      for (const listener of listeners) listener(next)
    },
  }
}

function mountView (client: TeachDialogClient): HTMLElement {
  root = document.createElement('div')
  document.body.append(root)
  createApp(TeachDialog, { client }).mount(root)
  return root
}

function queryNameInput (): HTMLInputElement {
  return root!.querySelector<HTMLInputElement>('input[placeholder="请输入航线名称"]')!
}

function querySpeedInputs (): HTMLInputElement[] {
  return [...root!.querySelectorAll<HTMLInputElement>('.speed-row input[type="number"]')]
}

async function typeName (value: string): Promise<void> {
  const input = queryNameInput()
  input.value = value
  input.dispatchEvent(new Event('input'))
  await nextTick()
}

describe('teachDialogView', () => {
  it('挂载后填充默认航线名称与速度', async () => {
    const { client } = createClient(generateState())
    mountView(client)
    await nextTick()
    expect(queryNameInput().value).toBe('示教复飞航线 1')
    expect(querySpeedInputs().map(input => input.value)).toEqual(['15', '5'])
  })

  it('清空默认名称后状态流再推送不回填（BACKSPACE 全删回归）', async () => {
    const { client, push } = createClient(generateState())
    mountView(client)
    await nextTick()
    await typeName('')
    // 模拟宿主侧截图上传进度 / 航点勾选等引起的任意状态推送
    push(generateState({ screenshotBytes: 1024 }))
    await nextTick()
    expect(queryNameInput().value).toBe('')
  })

  it('自定义名称与修改后的速度在状态推送后保留，生成时原样提交', async () => {
    const { client, generate, push } = createClient(generateState())
    mountView(client)
    await nextTick()
    await typeName('我的巡飞路线')
    const speeds = querySpeedInputs()
    speeds[0]!.value = '8'
    speeds[0]!.dispatchEvent(new Event('input'))
    speeds[1]!.value = '3.5'
    speeds[1]!.dispatchEvent(new Event('input'))
    await nextTick()
    push(generateState({ screenshotBytes: 1024 }))
    await nextTick()
    expect(queryNameInput().value).toBe('我的巡飞路线')
    expect(querySpeedInputs().map(input => input.value)).toEqual(['8', '3.5'])
    root!.querySelector<HTMLButtonElement>('.generate-button')!.click()
    expect(generate).toHaveBeenCalledWith({ name: '我的巡飞路线', globalSpeed: 8, waypointSpeed: 3.5 })
  })

  it('同一实例从冲突态进入生成态时重新应用默认值', async () => {
    const { client, push } = createClient(conflictState())
    mountView(client)
    await nextTick()
    push(generateState({ defaultName: '示教复飞航线 2' }))
    await nextTick()
    expect(queryNameInput().value).toBe('示教复飞航线 2')
    expect(querySpeedInputs().map(input => input.value)).toEqual(['15', '5'])
  })

  it('生成失败推送 error 状态后用户输入不被覆盖', async () => {
    const { client, push } = createClient(generateState())
    mountView(client)
    await nextTick()
    await typeName('重试命名')
    push(generateState({ pending: false, error: '生成失败，请重试' }))
    await nextTick()
    expect(queryNameInput().value).toBe('重试命名')
  })
})
