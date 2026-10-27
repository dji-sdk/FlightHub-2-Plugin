// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { dialogState, showDialog } from '../../services/dialog'
import DialogHost from './DialogHost.vue'

/**
 * DialogHost 的 pairs 字段：行式键值对进对话框（工作流向导的事件筛选条件）。
 *
 * 契约重点：必填校验（至少一条）拦提交不关窗；提交结果里是普通对象；
 * 对话框切换时表单状态重建（含 pairs 的对象初值）。
 */

function mountHost (): { unmount: () => void } {
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({ setup: () => () => h(DialogHost) })
  app.mount(root)
  return {
    unmount: () => {
      app.unmount()
      root.remove()
    },
  }
}

function change (input: HTMLInputElement, text: string): void {
  input.value = text
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function click (element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: false }))
}

/** 内容区（pairs 行在这里；确认按钮在 NModal 的 #footer，不在这棵子树里）。 */
function dialogCard (): HTMLElement | null {
  return document.querySelector('.dialog-card')
}

/** 整个对话框卡片（NModal card preset 根），按钮从这里找。 */
function dialogRoot (): HTMLElement | null {
  return document.querySelector('.n-modal')
}

function confirmButton (): HTMLButtonElement | undefined {
  return [...(dialogRoot()?.querySelectorAll('button') ?? [])]
    .find(button => button.textContent?.includes('创建'))
}

/**
 * 发起 pairs 对话框。★ 返回值不做任何等待（await 会递归解包嵌套 Promise，
 * 等它就等于等对话框关闭）；渲染等待由调用方显式用 waitForDialog 做。
 */
function startPairsDialog (): Promise<unknown> {
  return showDialog({
    title: '配置「事件消息」',
    body: ['至少限定 status。'],
    fields: [
      { kind: 'pairs', name: 'match', label: '事件筛选条件', required: true, keyPlaceholder: 'event_type', valuePlaceholder: 'pending' },
    ],
    confirmLabel: '创建',
  })
}

/** NModal 传送门渲染跨两个 tick（调试确认一次不够）。 */
async function waitForDialog (): Promise<void> {
  await nextTick()
  await nextTick()
}

async function fillOnePair (): Promise<void> {
  const card = dialogCard()
  if (card === null) throw new Error('对话框未渲染')
  const add = [...card.querySelectorAll('button')].find(button => button.textContent?.includes('＋'))
  if (add === undefined) throw new Error('没有新增按钮')
  click(add)
  await nextTick()
  const inputs = [...card.querySelectorAll('.wf-key-list input')] as HTMLInputElement[]
  if (inputs.length < 2) throw new Error(`新增后应有键值两个输入框，实际 ${inputs.length}`)
  change(inputs[0]!, 'event_type')
  change(inputs[1]!, 'illegal_road')
}

describe('dialogHost pairs 字段', () => {
  it('右上角关闭返回 null，自定义取消键才返回 cancelResult', async () => {
    const { unmount } = mountHost()

    const switched = showDialog({
      title: '调用已有业务功能',
      cancelLabel: '改为新建功能…',
      cancelResult: { action: 'create' },
      confirmLabel: '加入画布',
    })
    await waitForDialog()
    const cancel = [...dialogRoot()!.querySelectorAll('button')]
      .find(button => button.textContent?.includes('改为新建功能'))
    expect(cancel).toBeDefined()
    click(cancel!)
    expect(await switched).toEqual({ action: 'create' })
    await waitForDialog()

    const closed = showDialog({
      title: '调用已有业务功能',
      cancelLabel: '改为新建功能…',
      cancelResult: { action: 'create' },
      confirmLabel: '加入画布',
    })
    await waitForDialog()
    const close = dialogRoot()!.querySelector('.n-base-close')
    expect(close).not.toBeNull()
    click(close!)
    expect(await closed).toBeNull()
    unmount()
  })

  it('必填校验：一条没填拦提交不关窗，填了提交出对象', async () => {
    const { unmount } = mountHost()
    const pending = startPairsDialog()
    await waitForDialog()

    const card = dialogCard()
    expect(card).not.toBeNull()
    const confirm = confirmButton()
    expect(confirm).toBeDefined()

    click(confirm!)
    await nextTick()
    expect(card!.textContent).toContain('事件筛选条件要至少一条')
    expect(dialogState().current).not.toBeNull()

    await fillOnePair()
    click(confirm!)
    const result = await pending
    expect(result).toEqual({ match: { event_type: 'illegal_road' } })
    unmount()
  })

  it('对话框切换时 pairs 初值重建，不带上一个的残留', async () => {
    const { unmount } = mountHost()

    const first = startPairsDialog()
    await waitForDialog()
    await fillOnePair()
    click(confirmButton()!)
    expect(await first).toEqual({ match: { event_type: 'illegal_road' } })
    await waitForDialog()

    // 第二个对话框带初值：提交结果只能是初值 —— 若上一个对话框的 pairs
    // 残留进来（曾经的 values 泄漏 bug），这里会多出 event_type。
    const second = showDialog({
      title: '再来一个',
      fields: [{ kind: 'pairs', name: 'match', label: '事件筛选条件', value: { status: 'pending' } }],
      confirmLabel: '确定',
    })
    await waitForDialog()
    const cards = document.querySelectorAll('.dialog-card')
    const card = cards[cards.length - 1]! as HTMLElement
    const inputs = [...card.querySelectorAll('.wf-key-list input')] as HTMLInputElement[]
    expect(inputs[0]!.value).toBe('status')
    expect(inputs[1]!.value).toBe('pending')
    const confirmAgain = [...(dialogRoot()?.querySelectorAll('button') ?? [])]
      .find(button => button.textContent?.includes('确定'))
    click(confirmAgain!)
    expect(await second).toEqual({ match: { status: 'pending' } })
    unmount()
  })
})
