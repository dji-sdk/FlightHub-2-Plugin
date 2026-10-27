// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { PluginCapabilityClient, PluginState, ViewPresentation } from 'fh2-plugin-sdk'
import { createViewState } from 'fh2-plugin-sdk'
import type { TrafficCaptureContext } from '../context'
import type { CaptureModeSettingsSnapshot } from '../../../shared/capture-mode'
import type { LaneChangePreviewState } from '../../../views/capture-evidence-preview/lane-change/contract'
import type { LaneChangeRecordsState } from '../../../views/capture-records/lane-change/contract'
import type { LaneChangeRenameDialogState } from '../../../views/lane-change-rename-dialog/contract'
import { laneChangeRenameDialogView } from '../../../views/lane-change-rename-dialog/contract'
import { laneChangeWorkbenchView } from '../../../views/lane-change-workbench/contract'
import { laneChangeCanvasView } from '../../../views/lane-change-annotation-canvas/contract'
import { createLaneChangeController } from './controller'
import type { LaneChangeControllerDeps } from './controller'
import { createLaneChangeRecordsState } from './records'
import { createLaneChangePreview } from './preview'

/**
 * 变道抓拍 Cockpit 装配模块：controller + 工作台/标注画布/重命名弹窗三个视图
 * + Overlay + 独立 Records/Preview 状态。父级入口由 capture/module 显式装配。
 */
export interface LaneChangeModule {
  readonly settingsState: PluginState<CaptureModeSettingsSnapshot>;
  readonly recordsState: PluginState<LaneChangeRecordsState>;
  readonly previewState: PluginState<LaneChangePreviewState>;
  setEnabled(enabled: boolean): Promise<void>;
  selectRecord(eventKey: string): void;
  recover(): Promise<void>;
  refreshGate(): void;
  resetSession(): void;
  clearSelection(): void;
  dispose(): Promise<void>;
}

export interface LaneChangeModuleDeps extends LaneChangeControllerDeps {
  readonly ctx: TrafficCaptureContext;
  /** 宿主顶层模态能力；缺席时重命名弹窗不可用（提示并降级，不恢复局部弹窗）。 */
  readonly dialog: PluginCapabilityClient<'platform:dialog'> | undefined;
  readonly map: PluginCapabilityClient<'platform:map'> | undefined;
}

export async function createLaneChangeCockpitModule (deps: LaneChangeModuleDeps): Promise<LaneChangeModule> {
  const { ctx } = deps
  const controller = createLaneChangeController(deps)
  const records = createLaneChangeRecordsState(controller.recordsState)
  const preview = createLaneChangePreview(records.state, deps.map ?? null)

  // --- 重命名弹窗（platform:dialog；标题栏/遮罩/关闭由宿主提供） ------------------

  const renameDialogState = createViewState<LaneChangeRenameDialogState>({ initialName: '' })
  let renamePresentation: ViewPresentation | undefined
  let renamingAnnotationId: string | null = null
  let renameGeneration = 0

  async function closeRenameDialog (): Promise<void> {
    renameGeneration += 1
    const presentation = renamePresentation
    renamePresentation = undefined
    renamingAnnotationId = null
    await presentation?.close().catch(() => {})
  }

  function notifyRenameBlocked (intent: 'warning' | 'error', message: string): void {
    try {
      deps.notification?.show({ key: `lane-change:rename:${intent}`, message, intent, durationMs: 4000 })
    } catch {
      // 通知展示失败不阻断重命名主流程
    }
  }

  async function requestRename (id: string): Promise<void> {
    const annotation = controller.workbenchState.get().annotations.find(item => item.id === id)
    if (!annotation) return
    if (!deps.dialog) {
      notifyRenameBlocked('warning', '宿主暂不支持重命名弹窗')
      deps.logger.warn('platform:dialog 不可用，无法打开重命名弹窗')
      return
    }
    await closeRenameDialog()
    const generation = renameGeneration
    renamingAnnotationId = id
    renameDialogState.update(() => ({ initialName: annotation.name }))
    let presentation: ViewPresentation
    try {
      presentation = await deps.dialog.open(laneChangeRenameDialogView.get(ctx), {
        title: '重命名标注',
        width: 360,
        height: 108,
      })
    } catch (error) {
      if (generation === renameGeneration) renamingAnnotationId = null
      notifyRenameBlocked('error', '重命名弹窗打开失败')
      deps.logger.warn('重命名弹窗打开失败', { message: error instanceof Error ? error.message : String(error) })
      return
    }
    if (generation !== renameGeneration) {
      await presentation.close().catch(() => {})
      return
    }
    renamePresentation = presentation
    void presentation.closed.then(() => {
      if (renamePresentation === presentation) {
        renamePresentation = undefined
        renamingAnnotationId = null
      }
    })
  }

  async function confirmRename (name: string): Promise<void> {
    const id = renamingAnnotationId
    if (id === null) return
    const trimmed = name.trim()
    if (trimmed === '') return
    await controller.workbench.renameAnnotation({ id, name: trimmed })
    // 关闭延后一拍：先让本次 View RPC 返回，避免卸载发起调用的 View
    deps.timers.setTimeout(() => {
      void closeRenameDialog()
    }, 0)
  }

  await laneChangeWorkbenchView.handle(ctx, {
    state: controller.workbenchState,
    methods: {
      ...controller.workbench,
      requestRename: ({ id }) => requestRename(id),
    },
  })
  await laneChangeCanvasView.handle(ctx, {
    state: controller.canvasState,
    methods: controller.canvas,
  })
  await laneChangeRenameDialogView.handle(ctx, {
    state: renameDialogState,
    methods: {
      confirm: async ({ name }) => {
        await confirmRename(name)
      },
      cancel: () => {
        void closeRenameDialog()
      },
    },
  })

  const workbenchPanel = await ctx.extensions.contribute('lane-change-workbench', {
    visible: false,
    interactive: true,
    width: 280,
    render: () => laneChangeWorkbenchView.get(ctx),
  })

  const canvasOverlay = await ctx.extensions.contribute('lane-change-annotation-canvas', {
    visible: false,
    interactive: false,
    placement: 'fill',
    render: () => laneChangeCanvasView.get(ctx),
  })

  controller.attachUi({
    workbench: workbenchPanel,
    canvas: canvasOverlay,
  })

  return {
    settingsState: controller.settingsState,
    recordsState: records.state,
    previewState: preview.state,
    setEnabled: enabled => controller.settings.setEnabled({ enabled }),
    selectRecord: preview.selectRecord,
    recover: () => controller.recover(),
    refreshGate: () => controller.refreshGate(),
    resetSession: () => controller.resetSession(),
    clearSelection: preview.clearSelection,
    async dispose () {
      await closeRenameDialog()
      records.subscription.dispose()
      preview.dispose()
      await controller.dispose()
    },
  }
}
