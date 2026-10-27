// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createPinia, setActivePinia } from 'pinia'
import { createApp, h, nextTick, provide } from 'vue'
import { expect, it, vi } from 'vitest'
import { IDE_KEY } from '../../composables/use-ide'
import { useRunStore } from '../../stores/run'
import RunTerminal from './RunTerminal.vue'

const state = vi.hoisted(() => ({ writes: [] as string[], reset: vi.fn(), scroll: vi.fn(), onScroll: undefined as (() => void) | undefined, callbacks: [] as (() => void)[], buffer: { viewportY: 0, baseY: 0, getLine: () => undefined } }))
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  buffer = { active: state.buffer }
  rows = 10
  open () {}
  loadAddon () {}
  registerLinkProvider () {}
  dispose () {}
  reset () {
    state.reset()
  }

  scrollToBottom () {
    state.scroll()
  }

  scrollToLine () {}
  onScroll (fn: () => void) {
    state.onScroll = fn
  }

  write (text: string, callback?: () => void) {
    state.writes.push(text)
    if (callback) state.callbacks.push(callback)
  }
} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {
  fit () {}
} }))

it('日志空态只显示一次；过滤其他来源不重写，滚动等待 write 完成并尊重用户视口', async () => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callback(0)
    return 0
  })
  const pinia = createPinia()
  setActivePinia(pinia)
  const app = createApp({ setup () {
    provide(IDE_KEY, {} as never)
    return () => h(RunTerminal)
  } })
  const root = document.createElement('div')
  app.use(pinia)
  app.mount(root)
  try {
    const run = useRunStore()
    expect(state.writes.join('')).toContain('暂无输出')
    run.note('dev', 'first')
    await nextTick()
    state.buffer.baseY = 20
    state.onScroll!()
    expect(state.reset).toHaveBeenCalledTimes(2)
    expect(state.scroll).not.toHaveBeenCalled()
    state.callbacks.splice(0).forEach(fn => fn())
    expect(state.scroll).toHaveBeenCalledOnce()
    const beforeTrim = state.reset.mock.calls.length
    run.append({ schemaVersion: 1, mode: 'dev', stream: 'stdout', line: Array.from({ length: 2010 }, (_, index) => `line-${index}`).join('\n') })
    await nextTick()
    expect(state.reset).toHaveBeenCalledTimes(beforeTrim + 1)
    const afterTrim = state.reset.mock.calls.length
    run.note('preview', 'filtered after trim')
    await nextTick()
    // 裁剪移除了已经渲染的首行，需要重写真实剩余缓冲。
    expect(state.reset).toHaveBeenCalledTimes(afterTrim + 1)
    run.clear()
    await nextTick()
    expect(state.writes.at(-1)).toContain('暂无输出')
    run.setFilter('dev')
    await nextTick()
    state.callbacks.splice(0).forEach(fn => fn())
    const resets = state.reset.mock.calls.length
    run.note('preview', 'hidden')
    await nextTick()
    expect(state.reset).toHaveBeenCalledTimes(resets)
    state.buffer.baseY = 50
    state.buffer.viewportY = 50
    state.onScroll!()
    root.querySelector('.run-terminal')!.dispatchEvent(new WheelEvent('wheel'))
    state.buffer.viewportY = 10
    state.onScroll!()
    state.scroll.mockClear()
    run.note('dev', 'new')
    await nextTick()
    state.callbacks.splice(0).forEach(fn => fn())
    expect(state.scroll).not.toHaveBeenCalled()
    state.buffer.viewportY = 50
    state.onScroll!()
    run.note('dev', 'follow')
    await nextTick()
    state.callbacks.splice(0).forEach(fn => fn())
    expect(state.scroll).toHaveBeenCalledOnce()
  } finally {
    app.unmount()
  }
})
