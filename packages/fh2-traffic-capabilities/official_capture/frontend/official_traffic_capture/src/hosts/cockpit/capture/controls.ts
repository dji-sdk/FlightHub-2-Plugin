// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createViewState } from 'fh2-plugin-sdk'
import type { ActionContext, Disposable, PluginValue, ViewPresentation } from 'fh2-plugin-sdk'
import { captureAlertToastView } from '../../../views/capture-alert-toast/contract'
import { captureSettingsView } from '../../../views/capture-settings/contract'
import type { TrafficCaptureContext } from '../context'
import type { LaneChangeModule } from '../lane-change/module'
import type { PersonRoadModule } from '../person-road/module'
import type { CockpitRuntimeEnv } from '../runtime-env'
import type { CaptureModeCoordinator } from './coordinator'
import type { CaptureRecordsHost } from './records-host'

export interface CaptureControls {
  revealRecords(input?: PluginValue): Promise<void>;
  dispose(): Promise<void>;
}

export async function createCaptureControls (deps: {
  readonly ctx: TrafficCaptureContext;
  readonly env: CockpitRuntimeEnv;
  readonly laneChange: LaneChangeModule;
  readonly personRoad: PersonRoadModule;
  readonly coordinator: CaptureModeCoordinator;
  readonly records: CaptureRecordsHost;
}): Promise<CaptureControls> {
  let entryAction: Awaited<ReturnType<typeof deps.ctx.extensions.contribute<'traffic-capture-popover-entry'>>> | undefined
  const settingsState = createViewState({
    laneChange: { enabled: false, canEnable: false, disabledReason: null as string | null },
    personRoad: { enabled: false, canEnable: false, disabledReason: null as string | null },
    switchBusy: false,
    alert: { enabled: true, popup: true, sound: true },
  })
  const sync = (): void => {
    const lane = deps.laneChange.settingsState.get()
    const person = deps.personRoad.settingsState.get()
    settingsState.update(() => ({
      laneChange: { enabled: lane.enabled, canEnable: lane.canEnable, disabledReason: lane.disabledReason },
      personRoad: { enabled: person.enabled, canEnable: person.canEnable, disabledReason: person.disabledReason },
      switchBusy: lane.switchBusy || person.switchBusy,
      alert: deps.env.alert.settingsState.get(),
    }))
    void entryAction?.update({ active: lane.enabled || person.enabled })
  }
  const subscriptions: Disposable[] = [
    deps.laneChange.settingsState.subscribe(sync),
    deps.personRoad.settingsState.subscribe(sync),
    deps.env.alert.settingsState.subscribe(sync),
  ]
  let settingsPresentation: ViewPresentation | undefined
  let transition = Promise.resolve()
  let disposed = false
  const closeSettings = async (): Promise<void> => {
    const current = settingsPresentation
    if (!current) return
    settingsPresentation = undefined
    await current.close()
  }
  const toggleSettings = async ({ openView }: ActionContext): Promise<void> => {
    if (disposed) return
    if (settingsPresentation) return closeSettings()
    const presentation = await openView(captureSettingsView.get(deps.ctx), { placement: 'right' })
    if (disposed) {
      await presentation.close()
      return
    }
    settingsPresentation = presentation
    void presentation.closed.then(() => {
      if (settingsPresentation === presentation) settingsPresentation = undefined
    })
  }
  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const run = async (): Promise<void> => {
      if (!disposed) await operation()
    }
    transition = transition.then(run, run)
    return transition
  }

  await captureSettingsView.handle(deps.ctx, {
    state: settingsState,
    methods: {
      close: () => {
        void enqueue(closeSettings)
      },
      setLaneChangeEnabled: (input) => {
        if (input.enabled) {
          deps.records.setActivePanel('lane-change')
        }
        return deps.coordinator.setEnabled('lane-change', input.enabled)
      },
      setPersonRoadEnabled: (input) => {
        if (input.enabled) {
          deps.records.setActivePanel('person-road')
        }
        return deps.coordinator.setEnabled('person-road', input.enabled)
      },
      setAlertEnabled: input => deps.env.alert.setEnabled(input),
      setAlertPopup: input => deps.env.alert.setPopup(input),
      setAlertSound: input => deps.env.alert.setSound(input),
    },
  })
  await captureAlertToastView.handle(deps.ctx, {
    state: deps.env.alert.toastState,
    methods: { click: () => deps.env.alert.handleToastClick() },
  })
  const toastOverlay = await deps.ctx.extensions.contribute('capture-alert-toast', {
    visible: false,
    interactive: true,
    placement: 'top',
    offsetY: 120,
    width: 220,
    height: 48,
    render: () => captureAlertToastView.get(deps.ctx),
  })
  const toastSubscription = deps.env.alert.toastState.subscribe((state) => {
    void toastOverlay.update({ visible: state.visible })
  })
  entryAction = await deps.ctx.extensions.contribute('traffic-capture-popover-entry', {
    icon: 'traffic-capture',
    label: '交通违章抓拍',
    active: false,
    disabled: false,
    async onTrigger (context) {
      await enqueue(() => toggleSettings(context))
    },
  })
  sync()

  return {
    revealRecords: input => deps.records.reveal(input),
    async dispose () {
      disposed = true
      await transition.catch(() => {})
      await closeSettings()
      toastSubscription.dispose()
      for (const subscription of subscriptions) subscription.dispose()
      await deps.env.alert.dispose()
    },
  }
}
