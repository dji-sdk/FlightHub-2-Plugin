// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createViewState } from 'fh2-plugin-sdk'
import { createAlertDispatchApi } from '../../api/alert-dispatch-api'
import { dispatchFormView } from '../../views/dispatch-form/contract'
import type { DispatchFormState } from '../../views/dispatch-form/contract'
import { dispatchWorkspaceView } from '../../views/dispatch-workspace/contract'
import type { AlertDispatchProjectContext } from '../../types'

function errorMessage (error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export async function activate (ctx: AlertDispatchProjectContext) {
  const { extensions, logger, config } = ctx
  const api = createAlertDispatchApi(ctx.apiCall)
  const state = createViewState<DispatchFormState>({
    submitting: false,
    lastEventId: null,
    error: null,
  })
  // 工作区测试渲染默认隐藏；经插件配置开启后用于 renderWorkspace 双区域回归验证
  const workspaceTestEnabled = config.enableWorkspaceTest === true

  await extensions.contribute('alert-dispatch-sidebar-action', {
    icon: 'alert-dispatch',
    label: '警情派遣',
    disabled: false,
    showBadge: false,
    render: () => dispatchFormView.get(ctx),
    // 路由激活时由 main-app ProjectRight 工作区承载（与左侧 panel 同时显示）
    ...(workspaceTestEnabled ? { renderWorkspace: () => dispatchWorkspaceView.get(ctx) } : {}),
  })

  await dispatchFormView.handle(ctx, {
    state,
    methods: {
      dispatch: async (input) => {
        state.update(current => ({ ...current, submitting: true, error: null }))
        try {
          const result = await api.dispatchAlert(input)
          state.update(current => ({ ...current, submitting: false, lastEventId: result.eventId }))
          logger.info('警情派发成功', { eventId: result.eventId })
        } catch (error) {
          const message = errorMessage(error, '警情派发失败')
          state.update(current => ({ ...current, submitting: false, error: message }))
          logger.error('警情派发失败', { errorMessage: message })
        }
      },
    },
  })
  if (workspaceTestEnabled) {
    // 工作区 View 只读共享同一份派发状态，无自有方法
    await dispatchWorkspaceView.handle(ctx, {
      state,
      methods: {},
    })
  }
  logger.debug('警情派遣表单 View handler 注册完成', {
    viewIds: workspaceTestEnabled ? ['dispatch-form', 'dispatch-workspace'] : ['dispatch-form'],
  })

  return {
    dispose: async () => {
      // 侧栏贡献由 Engine 台账在 Host unmount / Runtime 停用时逆序释放。
    },
  }
}
