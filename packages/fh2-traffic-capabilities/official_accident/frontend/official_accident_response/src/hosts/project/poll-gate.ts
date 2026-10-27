// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { PlatformLocationState, PluginCapabilityClient } from 'fh2-plugin-sdk'

type LocationClient = PluginCapabilityClient<'platform:location'>
type LocationSnapshot = Pick<PlatformLocationState, 'hash'>
interface LocationSubscription {
  dispose(): Promise<void>;
}

export interface CockpitPollGateOptions {
  readonly location: LocationClient;
  /** 恢复非驾驶舱状态时的即时刷新（激活首拉 / 离开驾驶舱重拉）。 */
  readonly refresh: () => void;
  readonly startPolling: () => void;
  readonly stopPolling: () => void;
}

/** 驾驶舱是 project-app 内部路由：主应用 hash 以 #/cockpit 开头即视为在驾驶舱。 */
export function isInCockpitRoute (location: LocationSnapshot): boolean {
  return location.hash.startsWith('#/cockpit')
}

/**
 * 驾驶舱轮询闸门：project-app 在驾驶舱路由下保持挂载，插件列表页不可见。
 * 感知到 #/cockpit 后暂停自动轮询，离开后立即刷新并恢复；
 * 状态翻转去重，重复的路由通知不会重复启停。
 */
export function createCockpitPollGate (options: CockpitPollGateOptions): {
  start(): Promise<void>;
  dispose(): void;
} {
  let inCockpit = false
  let seen = false
  let disposed = false
  let subscription: LocationSubscription | undefined

  function apply (state: LocationSnapshot): void {
    if (disposed) return
    const next = isInCockpitRoute(state)
    if (seen && next === inCockpit) return
    seen = true
    inCockpit = next
    if (next) {
      options.stopPolling()
      return
    }
    options.refresh()
    options.startPolling()
  }

  return {
    async start () {
      // 先订阅再读当前状态：订阅建立到 getState 之间到达的路由变化不会丢失（apply 幂等去重）。
      subscription = await options.location.onStateChanged(apply)
      if (disposed) {
        await subscription.dispose()
        subscription = undefined
        return
      }
      apply(await options.location.getState())
    },
    dispose () {
      disposed = true
      options.stopPolling()
      const pending = subscription
      subscription = undefined
      void pending?.dispose().catch(() => {})
    },
  }
}
