// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createViewState } from 'fh2-plugin-sdk'
import type { ViewPresentation } from 'fh2-plugin-sdk'
import type { AppCockpitContext } from '../../generated/plugin-types'
import { issueDialogView } from '../../views/issue-dialog/contract'
import type { IssueDialogInput, IssueDialogState } from '../../views/issue-dialog/contract'
import { issuePanelView } from '../../views/issue-panel/contract'
import type { IssuePanelState, IssueRecord } from '../../views/issue-panel/contract'

const ENTRY_ICON = 'issue'
const ENTRY_ACTIVE_ICON = 'issue-active'

let issueSequence = 1

function createIssueRecord (input: IssueDialogInput): IssueRecord {
  const issue: IssueRecord = {
    id: `issue-${issueSequence}`,
    title: input.title,
    description: input.description,
    severity: input.severity,
    status: 'new',
  }
  issueSequence += 1
  return issue
}

/**
 * 进阶示例：工具栏图标切换左下附着面板，面板通过 `platform:dialog` 打开宿主弹窗。
 * 数据保存在 Entry 内存中，不依赖后端；宿主未提供弹窗能力时在面板内提示。
 */
export async function registerIssueExample (ctx: AppCockpitContext): Promise<void> {
  const dialog = await ctx.capabilities.get('platform:dialog')
  const issues: IssueRecord[] = [
    createIssueRecord({ title: '机场入口发现占道物', description: '正门左侧有共享单车占用车道', severity: 'medium' }),
    createIssueRecord({ title: '围栏外侧树枝越界', description: '东侧围栏外树枝触碰安全区', severity: 'low' }),
  ]
  let panelVisible = false
  let presentation: ViewPresentation | undefined
  let panelContribution: Awaited<ReturnType<typeof ctx.extensions.contribute<'issue-panel'>>>
  let entryContribution: Awaited<ReturnType<typeof ctx.extensions.contribute<'issue-entry'>>>

  const panelState = createViewState<IssuePanelState>({ issues: [...issues], error: '' })
  const dialogState = createViewState<IssueDialogState>({ pending: false })

  const syncPanel = (): void => {
    panelState.update(current => ({ ...current, issues: [...issues] }))
  }
  const updateIssueStatus = (id: string, status: IssueRecord['status']): void => {
    for (const [index, issue] of issues.entries()) {
      if (issue.id !== id)
        continue
      issues[index] = { ...issue, status }
      break
    }
    syncPanel()
  }
  const closeDialog = async (): Promise<void> => {
    const current = presentation
    presentation = undefined
    await current?.close()
  }
  const openCreateDialog = async (): Promise<void> => {
    if (!dialog) {
      panelState.update(current => ({ ...current, error: '当前 Host 未提供弹窗能力' }))
      return
    }
    dialogState.update(() => ({ pending: false }))
    await closeDialog()
    presentation = await dialog.open(issueDialogView.get(ctx), { title: '上报现场问题', width: 520 })
    const current = presentation
    void current.closed.then(() => {
      if (presentation === current)
        presentation = undefined
    })
  }

  await issuePanelView.handle(ctx, {
    state: panelState,
    methods: {
      requestCreate: openCreateDialog,
      acknowledgeIssue: ({ id }) => {
        updateIssueStatus(id, 'acknowledged')
      },
      resolveIssue: ({ id }) => {
        updateIssueStatus(id, 'resolved')
      },
      dismiss: async () => {
        panelVisible = false
        await panelContribution.update({ visible: false })
        await entryContribution.update({ active: false, icon: ENTRY_ICON })
      },
    },
  })
  await issueDialogView.handle(ctx, {
    state: dialogState,
    methods: {
      cancel: closeDialog,
      submit: async (input) => {
        dialogState.update(() => ({ pending: true }))
        try {
          issues.unshift(createIssueRecord(input))
          syncPanel()
          await closeDialog()
        } finally {
          dialogState.update(() => ({ pending: false }))
        }
      },
    },
  })

  panelContribution = await ctx.extensions.contribute('issue-panel', {
    visible: false,
    interactive: true,
    width: 280,
    render: () => issuePanelView.get(ctx),
  })
  entryContribution = await ctx.extensions.contribute('issue-entry', {
    icon: ENTRY_ICON,
    label: '现场问题',
    active: false,
    disabled: false,
    async onTrigger () {
      panelVisible = !panelVisible
      await panelContribution.update({ visible: panelVisible })
      await entryContribution.update({ active: panelVisible, icon: panelVisible ? ENTRY_ACTIVE_ICON : ENTRY_ICON })
    },
  })
}
