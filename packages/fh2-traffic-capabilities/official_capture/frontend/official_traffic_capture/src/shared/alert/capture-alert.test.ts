// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import { createCaptureAlertController } from './capture-alert'

function createFakeTimers () {
  const tasks = new Map<unknown, { callback: () => void; interval: boolean }>()
  let seq = 0
  return {
    setTimeout (callback: () => void, _ms: number) {
      const handle = ++seq
      tasks.set(handle, { callback, interval: false })
      return handle
    },
    clearTimeout (handle: unknown) {
      tasks.delete(handle)
    },
    setInterval (callback: () => void, _ms: number) {
      const handle = ++seq
      tasks.set(handle, { callback, interval: true })
      return handle
    },
    clearInterval (handle: unknown) {
      tasks.delete(handle)
    },
    runPending () {
      for (const [handle, task] of [...tasks.entries()]) {
        task.callback()
        if (!task.interval) tasks.delete(handle)
      }
    },
  }
}

describe('capture alert controller', () => {
  function createHarness () {
    const timers = createFakeTimers()
    const audio = { play: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }
    const onToastClick = vi.fn()
    const logger = { warn: vi.fn() }
    const controller = createCaptureAlertController({ audio, timers, onToastClick, logger })
    return { timers, audio, onToastClick, controller }
  }

  it('默认全开：alert 弹 toast + 播放音效，5 秒自动消失', () => {
    const { timers, audio, controller } = createHarness()
    controller.alert()
    expect(controller.toastState.get()).toEqual({ visible: true, message: '发现目标' })
    expect(audio.play).toHaveBeenCalledWith({ restart: true })

    timers.runPending()
    expect(controller.toastState.get().visible).toBe(false)
  })

  it('总开关关闭：不弹窗不播音', () => {
    const { audio, controller } = createHarness()
    controller.setEnabled({ enabled: false })
    controller.alert()
    expect(controller.toastState.get().visible).toBe(false)
    expect(audio.play).not.toHaveBeenCalled()
  })

  it('弹窗与音效独立：只开音效时不弹 toast；只开弹窗时不播音', () => {
    const { audio, controller } = createHarness()
    controller.setPopup({ popup: false })
    controller.alert()
    expect(controller.toastState.get().visible).toBe(false)
    expect(audio.play).toHaveBeenCalledOnce()

    controller.setSound({ sound: false })
    controller.setPopup({ popup: true })
    controller.alert()
    expect(controller.toastState.get().visible).toBe(true)
    expect(audio.play).toHaveBeenCalledOnce()
  })

  it('新告警替换旧告警并重新计时', () => {
    const { timers, controller } = createHarness()
    controller.alert()
    // 第一个 5s 计时未到即来新告警：替换文案并重新计时
    controller.alert('发现新目标')
    expect(controller.toastState.get()).toEqual({ visible: true, message: '发现新目标' })
    timers.runPending()
    expect(controller.toastState.get().visible).toBe(false)
  })

  it('toast 点击：隐藏并回调（reveal 记录面板），dispose 清理计时与音频', async () => {
    const { timers, audio, onToastClick, controller } = createHarness()
    controller.alert()
    controller.handleToastClick()
    expect(controller.toastState.get().visible).toBe(false)
    expect(onToastClick).toHaveBeenCalledOnce()

    // 点击后自动消失计时已取消
    timers.runPending()
    expect(onToastClick).toHaveBeenCalledOnce()

    await controller.dispose()
    expect(audio.dispose).toHaveBeenCalledOnce()
  })
})
