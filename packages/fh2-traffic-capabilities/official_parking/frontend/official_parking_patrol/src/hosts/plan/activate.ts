// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createViewState } from 'fh2-plugin-sdk'
import type { PlanFormContextState, PluginValue } from 'fh2-plugin-sdk'
import {
  DEFAULT_RECHECK_DELAY_MINUTES,
  RECHECK_DELAY_ERROR_MESSAGE,
  isValidRecheckDelayMinutes,
  patrolFormView,
} from '../../views/patrol-form/contract'
import type { PatrolFormState } from '../../views/patrol-form/contract'
import type { ParkingPatrolPlanContext } from '../../types'

const INITIAL_STATE: PatrolFormState = {
  enabled: false,
  contextAvailable: false,
  multiWayline: false,
  submitting: false,
  recheckDelayMinutes: DEFAULT_RECHECK_DELAY_MINUTES,
}

/**
 * 任务归属标识：提交体 biz_ext 顶层 key；值携带巡逻参数（recheck_delay_sec 违停复检间隔，单位秒）。
 * 计划库下发时携带该 key 即为巡逻任务；同一任务最多归属一个业务插件。
 */
const PATROL_BIZ_EXT_KEY = 'es-patrol'

/** TaskType.Continuous：连续执行任务的提交体 task_type 取值。 */
const TASK_TYPE_CONTINUOUS = 5

/** Plan Host 装配入口：表单上下文订阅 + 违停开关 View + 提交补丁贡献。 */
export async function activate (ctx: ParkingPatrolPlanContext) {
  const { extensions, logger } = ctx
  const state = createViewState<PatrolFormState>({ ...INITIAL_STATE })

  // —— 订阅 plan:form-context：驱动开关可用性、多航线互斥与复制继承 ——
  const formContext = await ctx.capabilities.get('plan:form-context')
  if (!formContext) {
    logger.warn('plan:form-context 不可用，违停巡逻表单扩展将保持只读')
  }
  let contextSubscription: { dispose(): void } | undefined

  // 复制继承：源任务 biz_ext 含 es-patrol 时默认开启；用户手动切换后不再覆盖
  let sourceApplied = false
  let userTouched = false
  let delayTouched = false
  let formInstanceId = ''

  /** 从源任务 biz_ext 读取违停复检间隔（秒→分钟）；非整分钟或超出 [1, 25] 口径时回落默认值。 */
  function readSourceRecheckDelayMinutes (sourceBizExt: Record<string, PluginValue>): number {
    const source = sourceBizExt[PATROL_BIZ_EXT_KEY]
    if (typeof source !== 'object' || source === null) return DEFAULT_RECHECK_DELAY_MINUTES
    const seconds = (source as Record<string, PluginValue>).recheck_delay_sec
    if (typeof seconds !== 'number' || seconds % 60 !== 0) return DEFAULT_RECHECK_DELAY_MINUTES
    const minutes = seconds / 60
    return isValidRecheckDelayMinutes(minutes) ? minutes : DEFAULT_RECHECK_DELAY_MINUTES
  }

  function applyContext (next: PlanFormContextState): void {
    if (!next.available) {
      state.update(current => ({ ...current, contextAvailable: false, multiWayline: false }))
      return
    }
    state.update((current) => {
      const isNewForm = Boolean(next.formInstanceId && next.formInstanceId !== formInstanceId)
      if (isNewForm) {
        formInstanceId = next.formInstanceId ?? ''
        sourceApplied = false
        userTouched = false
        delayTouched = false
      }
      const multiWayline = next.isMultiWayline
      let enabled = isNewForm ? false : current.enabled
      let recheckDelayMinutes = isNewForm ? DEFAULT_RECHECK_DELAY_MINUTES : current.recheckDelayMinutes
      if (!sourceApplied && next.sourceBizExt && PATROL_BIZ_EXT_KEY in next.sourceBizExt) {
        sourceApplied = true
        if (!userTouched) enabled = true
        // 复制巡逻任务时继承源任务的违停复检间隔；用户已手动修改则保留用户值
        if (!delayTouched) recheckDelayMinutes = readSourceRecheckDelayMinutes(next.sourceBizExt)
      }
      return {
        ...current,
        contextAvailable: true,
        multiWayline,
        // 切到多航线时自动关闭开关，避免残留启用状态
        enabled: multiWayline ? false : enabled,
        recheckDelayMinutes,
      }
    })
  }
  if (formContext) {
    applyContext(await formContext.getState())
    contextSubscription = await formContext.onStateChanged(applyContext)
  }

  async function rewriteFinishAction (projectId: string, waylineId: unknown): Promise<void> {
    if (typeof waylineId !== 'string' || waylineId.length === 0) {
      throw new Error('违停巡逻需要已生成的任务航线')
    }
    const wpmz = await ctx.capabilities.get('platform:wpmz')
    if (!wpmz) throw new Error('平台航线改写能力不可用，无法启用违停巡逻')
    await wpmz.rewrite({
      target: { projectId, waylineId },
      changes: { missionConfig: { finishAction: 'no-action' } },
    })
  }

  await patrolFormView.handle(ctx, {
    state,
    methods: {
      setEnabled: ({ enabled }) => {
        userTouched = true
        state.update((current) => {
          if (current.multiWayline || current.submitting) return current
          return { ...current, enabled }
        })
      },
      setRecheckDelayMinutes: ({ value }) => {
        delayTouched = true
        state.update((current) => {
          if (current.submitting) return current
          // 状态不变量：recheckDelayMinutes 恒为 [1, 25] 整数或 null（非法输入归一为 null）
          return { ...current, recheckDelayMinutes: isValidRecheckDelayMinutes(value) ? value : null }
        })
      },
    },
  })

  await extensions.contribute('patrol-form', {
    render: () => patrolFormView.get(ctx),
    validate: async (input) => {
      const current = state.get()
      if (!current.enabled) return { valid: true }
      if (input.context.isMultiWayline) {
        return { valid: false, message: '多航线任务暂不支持违停巡逻' }
      }
      // vlm_enabled 仅在开启多模态识别时写入提交体
      if (input.form.vlm_enabled === true) {
        return { valid: false, message: '多模态识别任务暂不支持违停巡逻' }
      }
      if (input.form.task_type === TASK_TYPE_CONTINUOUS) {
        return { valid: false, message: '连续执行任务暂不支持违停巡逻' }
      }
      const waylineUuid = input.form.wayline_uuid
      if (typeof waylineUuid !== 'string' || waylineUuid.length === 0) {
        return { valid: false, message: '违停巡逻需要已生成的任务航线' }
      }
      if (!isValidRecheckDelayMinutes(current.recheckDelayMinutes)) {
        return { valid: false, message: RECHECK_DELAY_ERROR_MESSAGE }
      }
      return { valid: true }
    },
    onSubmit: async (input) => {
      const current = state.get()
      if (!current.enabled) return {}
      if (!isValidRecheckDelayMinutes(current.recheckDelayMinutes)) {
        throw new Error(RECHECK_DELAY_ERROR_MESSAGE)
      }
      await rewriteFinishAction(input.context.projectId, input.form.wayline_uuid)
      // 提交契约单位为秒：分钟 × 60 写入 recheck_delay_sec
      return { biz_ext: { [PATROL_BIZ_EXT_KEY]: { recheck_delay_sec: current.recheckDelayMinutes * 60 } } }
    },
    onEditSubmit: async (input) => {
      if (!input.form.biz_ext || !(PATROL_BIZ_EXT_KEY in input.form.biz_ext)) return
      await rewriteFinishAction(input.context.projectId, input.form.wayline_uuid)
    },
  })

  return {
    dispose: async () => {
      contextSubscription?.dispose()
      contextSubscription = undefined
    },
  }
}
