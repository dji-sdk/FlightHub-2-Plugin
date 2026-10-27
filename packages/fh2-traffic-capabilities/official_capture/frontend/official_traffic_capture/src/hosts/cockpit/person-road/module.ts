// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { CockpitContextState, PluginCapabilityClient, PluginState } from 'fh2-plugin-sdk'
import type { TrafficCaptureContext } from '../context'
import type { CaptureModeSettingsSnapshot } from '../../../shared/capture-mode'
import type { PersonRoadPreviewState } from '../../../views/capture-evidence-preview/person-road/contract'
import type { PersonRoadRecordsState } from '../../../views/capture-records/person-road/contract'
import { personRoadSkipHintView } from '../../../views/person-road-skip-hint/contract'
import { createPersonRoadController } from './controller'
import type { PersonRoadControllerDeps } from './controller'
import { createPersonRoadRecordsState } from './records'
import { createPersonRoadPreview } from './preview'

/**
 * 行人上路 Cockpit 装配模块：controller + skip 提示视图与 Overlay + K 键热键
 * + 独立 Records/Preview 状态。父级入口由 capture/module 显式装配。
 */
export interface PersonRoadModule {
  readonly settingsState: PluginState<CaptureModeSettingsSnapshot>;
  readonly recordsState: PluginState<PersonRoadRecordsState>;
  readonly previewState: PluginState<PersonRoadPreviewState>;
  setEnabled(enabled: boolean): Promise<void>;
  selectRecord(trackingId: string): void;
  selectPhoto(index: number): void;
  openMediaLibrary(): Promise<void>;
  skipCurrentTarget(): Promise<void>;
  recover(): Promise<void>;
  refreshGate(): void;
  resetSession(): void;
  clearSelection(): void;
  dispose(): Promise<void>;
}

export interface PersonRoadModuleDeps extends PersonRoadControllerDeps {
  readonly ctx: TrafficCaptureContext;
  readonly getContextSnapshot: () => CockpitContextState | null;
  readonly hotkeys: PluginCapabilityClient<'cockpit:hotkeys'> | undefined;
  readonly map: PluginCapabilityClient<'platform:map'> | undefined;
  readonly navigation: PluginCapabilityClient<'platform:navigation'> | undefined;
}

export async function createPersonRoadCockpitModule (deps: PersonRoadModuleDeps): Promise<PersonRoadModule> {
  const { ctx } = deps
  const controller = createPersonRoadController(deps)
  const records = createPersonRoadRecordsState(controller.recordsState)
  const preview = createPersonRoadPreview({
    recordsState: records.state,
    map: deps.map ?? null,
    getContextSnapshot: deps.getContextSnapshot,
    navigation: deps.navigation,
    logger: deps.logger,
  })

  await personRoadSkipHintView.handle(ctx, {
    state: controller.skipHintState,
    methods: {},
  })

  const skipHintOverlay = await ctx.extensions.contribute('person-road-skip-hint', {
    visible: false,
    placement: 'bottom',
    width: 270,
    height: 48,
    offsetY: -222,
    render: () => personRoadSkipHintView.get(ctx),
  })

  controller.attachUi({ skipHint: skipHintOverlay })

  // K 键结束本轮行人抓拍（Esc 为宿主安全键、X 为宿主悬停键、Q 为机头左转，均不可注册）
  // 结束失败已由 controller toast；此处仅消费拒绝避免 unhandled rejection
  const skipHotkey = deps.hotkeys
    ? await deps.hotkeys.register({
      key: 'k',
      onTrigger: () => void controller.skipCurrentTarget().catch((error) => {
        deps.logger.warn('结束本轮行人抓拍失败', { message: error instanceof Error ? error.message : String(error) })
      }),
    })
    : undefined

  return {
    settingsState: controller.settingsState,
    recordsState: records.state,
    previewState: preview.state,
    setEnabled: enabled => controller.settings.setEnabled({ enabled }),
    selectRecord: preview.selectRecord,
    selectPhoto: preview.selectPhoto,
    openMediaLibrary: preview.openMediaLibrary,
    skipCurrentTarget: () => controller.skipCurrentTarget(),
    recover: () => controller.recover(),
    refreshGate: () => controller.refreshGate(),
    resetSession: () => controller.resetSession(),
    clearSelection: preview.clearSelection,
    async dispose () {
      records.subscription.dispose()
      preview.dispose()
      await controller.dispose()
      await skipHotkey?.dispose()
    },
  }
}
