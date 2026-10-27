// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Disposable, PlanFormContextState, PlanFormEditSubmitInput, PlanFormSubmitInput, PluginValue } from 'fh2-plugin-sdk'
import type { PatrolFormState } from '../../views/patrol-form/contract'
import type { ParkingPatrolPlanContext } from '../../types'
import { activate } from './activate'

interface StateSource<T> {
  subscribe (handler: (state: T) => void): Disposable;
}

const providers = vi.hoisted(() => ({
  patrolForm: undefined as CapturedProvider | undefined,
}))

interface CapturedProvider {
  state: StateSource<PatrolFormState>;
  methods: {
    setEnabled (input: { enabled: boolean }): Promise<void>;
    setRecheckDelayMinutes (input: { value: number | null }): Promise<void>;
  };
}

const viewMocks = vi.hoisted(() => ({
  patrolFormView: {
    get: vi.fn(() => ({ viewId: 'patrol-form', initialState: null })),
    handle: vi.fn(async (_ctx: unknown, provider: unknown) => {
      providers.patrolForm = provider as CapturedProvider
      return { dispose: vi.fn() }
    }),
  },
}))

vi.mock('../../views/patrol-form/contract', async importOriginal => ({
  ...(await importOriginal<typeof import('../../views/patrol-form/contract')>()),
  patrolFormView: viewMocks.patrolFormView,
}))

interface FormContextCapabilityMock {
  getState (): PlanFormContextState;
  onStateChanged (handler: (state: PlanFormContextState) => void): Disposable;
}

function createFormContextMock (initial: PlanFormContextState = { available: false, revision: 0 }): {
  capability: FormContextCapabilityMock;
  push (state: PlanFormContextState): void;
  activeCount (): number;
} {
  const handlers = new Set<(state: PlanFormContextState) => void>()
  let current = initial
  return {
    capability: {
      getState: () => current,
      onStateChanged: (handler) => {
        handlers.add(handler)
        return { dispose: () => {
          handlers.delete(handler)
        } }
      },
    },
    push: (state) => {
      current = state
      for (const handler of handlers) handler(state)
    },
    activeCount: () => handlers.size,
  }
}

function availableState (overrides: Partial<Extract<PlanFormContextState, { available: true }>> = {}): Extract<PlanFormContextState, { available: true }> {
  return {
    available: true,
    revision: 1,
    projectId: 'project-1',
    mode: 'create',
    planType: 'normal',
    isMultiWayline: false,
    draft: { wayline_uuid: 'w-1' },
    ...overrides,
  }
}

interface TestHarness {
  context: ParkingPatrolPlanContext;
  contribution: Record<string, unknown>;
  formContext: ReturnType<typeof createFormContextMock>;
  rewrite: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof activate> extends Promise<infer T> ? T extends { dispose: () => Promise<void> } ? T['dispose'] : never : never;
}

async function createHarness (options: {
  formContext?: ReturnType<typeof createFormContextMock>;
  wpmzAvailable?: boolean;
} = {}): Promise<TestHarness> {
  const formContext = options.formContext ?? createFormContextMock()
  const rewrite = vi.fn(async ({ target }: { target: { waylineId: string } }) => ({
    waylineId: target.waylineId,
    changed: false,
  }))
  let contribution: Record<string, unknown> | undefined
  const context = {
    host: { id: 'plan' },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config: { enableMock: true },
    capabilities: {
      get: vi.fn(async (id: string) => {
        if (id === 'plan:form-context') return formContext.capability
        if (id === 'platform:wpmz' && options.wpmzAvailable !== false) {
          return { parseCoordinates: vi.fn(async () => []), rewrite }
        }
        return undefined
      }),
    },
    views: { get: vi.fn((id: string) => ({ viewId: id, initialState: null })) },
    extensions: {
      contribute: vi.fn(async (extensionId: string, implementation: Record<string, unknown>) => {
        contribution = { extensionId, ...implementation }
        return {
          update: vi.fn(),
          dispose: vi.fn(),
        }
      }),
    },
  } as unknown as ParkingPatrolPlanContext

  const teardown = await activate(context)
  return {
    context,
    get contribution () {
      return contribution as Record<string, unknown>
    },
    formContext,
    rewrite,
    dispose: teardown!.dispose,
  }
}

function submitInput (
  overrides: Partial<PlanFormSubmitInput['context']> = {},
  formOverrides: Record<string, PluginValue> = {},
): PlanFormSubmitInput {
  return {
    context: {
      projectId: 'project-1',
      mode: 'create',
      planType: 'normal',
      isMultiWayline: false,
      ...overrides,
    },
    form: {
      name: '巡逻',
      task_type: 1,
      repeat_type: 0,
      wayline_uuid: 'w-1',
      sn: 'dock-1',
      landing_dock_sn: 'dock-1',
      out_of_control_action_in_flight: 1,
      media_folder_id_paths: '',
      ...formOverrides,
    },
  }
}

function editSubmitInput (bizExt: Record<string, PluginValue> | undefined): PlanFormEditSubmitInput {
  return {
    context: {
      projectId: 'project-1',
      mode: 'edit',
      planType: 'normal',
      isMultiWayline: false,
    },
    form: {
      ...submitInput().form,
      ...(bizExt ? { biz_ext: bizExt } : {}),
    },
  }
}

describe('parking-patrol plan form extension', () => {
  let reader: () => PatrolFormState

  beforeEach(() => {
    providers.patrolForm = undefined
    reader = () => {
      let latest: PatrolFormState | undefined
      providers.patrolForm!.state.subscribe((value) => {
        latest = value
      })
      return latest as PatrolFormState
    }
  })

  it('贡献 patrol-form：render + validate + create/edit 提交生命周期', async () => {
    const harness = await createHarness()
    expect(harness.contribution.extensionId).toBe('patrol-form')
    expect(typeof harness.contribution.render).toBe('function')
    expect(typeof harness.contribution.validate).toBe('function')
    expect(typeof harness.contribution.onSubmit).toBe('function')
    expect(typeof harness.contribution.onEditSubmit).toBe('function')
    await harness.dispose()
  })

  it('订阅 form-context：可用性、多航线互斥与自动关闭', async () => {
    const harness = await createHarness()
    expect(reader().contextAvailable).toBe(false)
    // 违停复检间隔默认 10 分钟
    expect(reader().recheckDelayMinutes).toBe(10)

    harness.formContext.push(availableState())
    expect(reader()).toMatchObject({ contextAvailable: true, multiWayline: false, recheckDelayMinutes: 10 })

    await providers.patrolForm!.methods.setEnabled({ enabled: true })
    expect(reader().enabled).toBe(true)

    harness.formContext.push(availableState({ isMultiWayline: true, revision: 2 }))
    expect(reader()).toMatchObject({ multiWayline: true, enabled: false })

    // 多航线期间 setEnabled 被拒绝
    await providers.patrolForm!.methods.setEnabled({ enabled: true })
    expect(reader().enabled).toBe(false)
    await harness.dispose()
  })

  it('开关关闭：validate 直通，onSubmit 返回空补丁（不携带 biz_ext）', async () => {
    const harness = await createHarness()
    harness.formContext.push(availableState())

    await expect((harness.contribution.validate as (i: PlanFormSubmitInput) => Promise<unknown>)(submitInput()))
      .resolves.toEqual({ valid: true })
    await expect((harness.contribution.onSubmit as (i: PlanFormSubmitInput) => Promise<unknown>)(submitInput()))
      .resolves.toEqual({})
    await harness.dispose()
  })

  it('开关开启：改写当前航线 finishAction 后返回 biz_ext.es-patrol', async () => {
    const harness = await createHarness()
    harness.formContext.push(availableState())
    await providers.patrolForm!.methods.setEnabled({ enabled: true })

    const patch = await (harness.contribution.onSubmit as (i: PlanFormSubmitInput) => Promise<Record<string, unknown>>)(submitInput())
    expect(harness.rewrite).toHaveBeenCalledWith({
      target: { projectId: 'project-1', waylineId: 'w-1' },
      changes: { missionConfig: { finishAction: 'no-action' } },
    })
    expect(patch).toEqual({ biz_ext: { 'es-patrol': { recheck_delay_sec: 600 } } })
    await harness.dispose()
  })

  it('违停复检间隔：合法输入更新状态，非法输入（0/负数/小数/超上限/空）归一为 null', async () => {
    const harness = await createHarness()
    harness.formContext.push(availableState())

    await providers.patrolForm!.methods.setRecheckDelayMinutes({ value: 15 })
    expect(reader().recheckDelayMinutes).toBe(15)

    for (const invalid of [0, -1, 1.5, 26, null]) {
      await providers.patrolForm!.methods.setRecheckDelayMinutes({ value: invalid })
      expect(reader().recheckDelayMinutes).toBeNull()
    }

    await providers.patrolForm!.methods.setRecheckDelayMinutes({ value: 25 })
    expect(reader().recheckDelayMinutes).toBe(25)
    await harness.dispose()
  })

  it('违停复检间隔：修改后的合法值随提交换算为秒写入 biz_ext.es-patrol', async () => {
    const harness = await createHarness()
    harness.formContext.push(availableState())
    await providers.patrolForm!.methods.setEnabled({ enabled: true })
    await providers.patrolForm!.methods.setRecheckDelayMinutes({ value: 15 })

    const patch = await (harness.contribution.onSubmit as (i: PlanFormSubmitInput) => Promise<Record<string, unknown>>)(submitInput())
    expect(patch).toEqual({ biz_ext: { 'es-patrol': { recheck_delay_sec: 900 } } })
    await harness.dispose()
  })

  it('validate：开关开启且违停复检间隔非法时拦截提交', async () => {
    const harness = await createHarness()
    harness.formContext.push(availableState())
    await providers.patrolForm!.methods.setEnabled({ enabled: true })
    await providers.patrolForm!.methods.setRecheckDelayMinutes({ value: null })

    const result = await (harness.contribution.validate as (i: PlanFormSubmitInput) => Promise<{ valid: boolean; message?: string }>)(submitInput())
    expect(result).toEqual({ valid: false, message: '违停复检间隔需为 1-25 的整数（分钟）' })
    await harness.dispose()
  })

  it('onSubmit：违停复检间隔非法时抛错且不改写航线', async () => {
    const harness = await createHarness()
    harness.formContext.push(availableState())
    await providers.patrolForm!.methods.setEnabled({ enabled: true })
    await providers.patrolForm!.methods.setRecheckDelayMinutes({ value: 0 })
    expect(reader().recheckDelayMinutes).toBeNull()

    await expect((harness.contribution.onSubmit as (i: PlanFormSubmitInput) => Promise<unknown>)(submitInput()))
      .rejects.toThrow('违停复检间隔需为 1-25 的整数（分钟）')
    expect(harness.rewrite).not.toHaveBeenCalled()
    await harness.dispose()
  })

  it('编辑已有巡逻任务：由插件识别 biz_ext 并恢复 finishAction', async () => {
    const harness = await createHarness()

    await (harness.contribution.onEditSubmit as (i: PlanFormEditSubmitInput) => Promise<void>)(
      editSubmitInput({ 'es-patrol': {} }),
    )

    expect(harness.rewrite).toHaveBeenCalledWith({
      target: { projectId: 'project-1', waylineId: 'w-1' },
      changes: { missionConfig: { finishAction: 'no-action' } },
    })
    await harness.dispose()
  })

  it('编辑非巡逻任务：隐藏生命周期不获取 WPMZ 能力', async () => {
    const harness = await createHarness()

    await (harness.contribution.onEditSubmit as (i: PlanFormEditSubmitInput) => Promise<void>)(
      editSubmitInput({ other: {} }),
    )

    expect(harness.context.capabilities.get).toHaveBeenCalledTimes(1)
    expect(harness.context.capabilities.get).toHaveBeenCalledWith('plan:form-context')
    expect(harness.rewrite).not.toHaveBeenCalled()
    await harness.dispose()
  })

  it('开关关闭：onSubmit 不获取或调用 platform:wpmz', async () => {
    const harness = await createHarness()
    harness.formContext.push(availableState())

    await (harness.contribution.onSubmit as (i: PlanFormSubmitInput) => Promise<unknown>)(submitInput())
    expect(harness.context.capabilities.get).toHaveBeenCalledTimes(1)
    expect(harness.context.capabilities.get).toHaveBeenCalledWith('plan:form-context')
    expect(harness.rewrite).not.toHaveBeenCalled()
    await harness.dispose()
  })

  it('开关开启但 platform:wpmz 不可用：提交失败且不返回任务归属补丁', async () => {
    const harness = await createHarness({ wpmzAvailable: false })
    harness.formContext.push(availableState())
    await providers.patrolForm!.methods.setEnabled({ enabled: true })

    await expect((harness.contribution.onSubmit as (i: PlanFormSubmitInput) => Promise<unknown>)(submitInput()))
      .rejects.toThrow('平台航线改写能力不可用')
    expect(harness.rewrite).not.toHaveBeenCalled()
    await harness.dispose()
  })

  it('复制继承：sourceBizExt 含 es-patrol 时默认开启开关', async () => {
    const harness = await createHarness()
    harness.formContext.push(availableState({
      mode: 'copy',
      sourceBizExt: { 'es-patrol': {} },
      revision: 2,
    }))
    expect(reader().enabled).toBe(true)

    // 用户可关闭；后续快照不再重复应用源状态
    await providers.patrolForm!.methods.setEnabled({ enabled: false })
    harness.formContext.push(availableState({
      mode: 'copy',
      sourceBizExt: { 'es-patrol': {} },
      revision: 3,
    }))
    expect(reader().enabled).toBe(false)
    await harness.dispose()
  })

  it('复制继承：源任务携带合法 recheck_delay_sec 时换算为分钟继承', async () => {
    const harness = await createHarness()
    harness.formContext.push(availableState({
      mode: 'copy',
      sourceBizExt: { 'es-patrol': { recheck_delay_sec: 120 } },
      revision: 2,
    }))
    expect(reader()).toMatchObject({ enabled: true, recheckDelayMinutes: 2 })

    const patch = await (harness.contribution.onSubmit as (i: PlanFormSubmitInput) => Promise<Record<string, unknown>>)(submitInput())
    expect(patch).toEqual({ biz_ext: { 'es-patrol': { recheck_delay_sec: 120 } } })
    await harness.dispose()
  })

  it('复制继承：源 recheck_delay_sec 缺失/非法/非整分钟/超上限时回落默认 10 分钟', async () => {
    const harness = await createHarness()
    for (const [sourceValue, revision] of [
      [{}, 2],
      [{ recheck_delay_sec: 0 }, 3],
      [{ recheck_delay_sec: 1800 }, 4],
      [{ recheck_delay_sec: '120' }, 5],
      [{ recheck_delay_sec: 90 }, 6],
    ] as const) {
      harness.formContext.push(availableState({
        mode: 'copy',
        sourceBizExt: { 'es-patrol': sourceValue },
        revision,
      }))
      expect(reader()).toMatchObject({ enabled: true, recheckDelayMinutes: 10 })
    }
    await harness.dispose()
  })

  it('复制继承：用户已修改违停复检间隔后源状态到达，不覆盖用户值', async () => {
    const harness = await createHarness()
    harness.formContext.push(availableState({ mode: 'copy', revision: 1 }))
    await providers.patrolForm!.methods.setRecheckDelayMinutes({ value: 15 })

    harness.formContext.push(availableState({
      mode: 'copy',
      sourceBizExt: { 'es-patrol': { recheck_delay_sec: 120 } },
      revision: 2,
    }))
    expect(reader()).toMatchObject({ enabled: true, recheckDelayMinutes: 15 })
    await harness.dispose()
  })

  it('复制继承：用户先手动开启后源状态到达，不覆盖用户选择', async () => {
    const harness = await createHarness()
    harness.formContext.push(availableState({ mode: 'copy', revision: 1 }))
    await providers.patrolForm!.methods.setEnabled({ enabled: true })

    harness.formContext.push(availableState({
      mode: 'copy',
      sourceBizExt: {},
      revision: 2,
    }))
    expect(reader().enabled).toBe(true)
    await harness.dispose()
  })

  it('源任务非巡逻（sourceBizExt 无 es-patrol）：开关保持默认关闭', async () => {
    const harness = await createHarness()
    harness.formContext.push(availableState({
      mode: 'copy',
      sourceBizExt: { 'other-plugin': {} },
      revision: 2,
    }))
    expect(reader().enabled).toBe(false)
    await harness.dispose()
  })

  it('新表单实例重置上一张表单的开关、违停复检间隔与复制初始化状态', async () => {
    const harness = await createHarness()
    harness.formContext.push(availableState({ formInstanceId: 'form-1' }))
    await providers.patrolForm!.methods.setEnabled({ enabled: true })
    await providers.patrolForm!.methods.setRecheckDelayMinutes({ value: 15 })
    expect(reader()).toMatchObject({ enabled: true, recheckDelayMinutes: 15 })

    harness.formContext.push({ available: false, revision: 2 })
    harness.formContext.push(availableState({
      formInstanceId: 'form-2',
      mode: 'copy',
      sourceBizExt: { 'other-plugin': {} },
      revision: 3,
    }))
    expect(reader()).toMatchObject({ enabled: false, contextAvailable: true, recheckDelayMinutes: 10 })

    harness.formContext.push(availableState({
      formInstanceId: 'form-2',
      mode: 'copy',
      sourceBizExt: { 'es-patrol': { recheck_delay_sec: 120 } },
      revision: 4,
    }))
    expect(reader()).toMatchObject({ enabled: true, recheckDelayMinutes: 2 })
    await harness.dispose()
  })

  it('validate：开关开启且多航线时拦截；缺少航线副本时拦截', async () => {
    const harness = await createHarness()
    harness.formContext.push(availableState())
    await providers.patrolForm!.methods.setEnabled({ enabled: true })

    const multi = await (harness.contribution.validate as (i: PlanFormSubmitInput) => Promise<{ valid: boolean; message?: string }>)(submitInput({ isMultiWayline: true }))
    expect(multi).toEqual({ valid: false, message: '多航线任务暂不支持违停巡逻' })

    const missingWayline = await (harness.contribution.validate as (i: PlanFormSubmitInput) => Promise<{ valid: boolean; message?: string }>)({
      context: submitInput().context,
      form: { ...submitInput().form, wayline_uuid: '' },
    })
    expect(missingWayline.valid).toBe(false)
    await harness.dispose()
  })

  it('validate：开关开启且开启多模态识别时拦截', async () => {
    const harness = await createHarness()
    harness.formContext.push(availableState())
    await providers.patrolForm!.methods.setEnabled({ enabled: true })

    const result = await (harness.contribution.validate as (i: PlanFormSubmitInput) => Promise<{ valid: boolean; message?: string }>)(
      submitInput({}, { vlm_enabled: true }),
    )
    expect(result).toEqual({ valid: false, message: '多模态识别任务暂不支持违停巡逻' })
    await harness.dispose()
  })

  it('validate：开关开启且任务策略为连续执行时拦截', async () => {
    const harness = await createHarness()
    harness.formContext.push(availableState())
    await providers.patrolForm!.methods.setEnabled({ enabled: true })

    const result = await (harness.contribution.validate as (i: PlanFormSubmitInput) => Promise<{ valid: boolean; message?: string }>)(
      submitInput({}, { task_type: 5 }),
    )
    expect(result).toEqual({ valid: false, message: '连续执行任务暂不支持违停巡逻' })
    await harness.dispose()
  })

  it('validate：开关关闭时不校验多模态识别与连续执行字段，直通', async () => {
    const harness = await createHarness()
    harness.formContext.push(availableState())

    const result = await (harness.contribution.validate as (i: PlanFormSubmitInput) => Promise<{ valid: boolean; message?: string }>)(
      submitInput({}, { vlm_enabled: true, task_type: 5 }),
    )
    expect(result).toEqual({ valid: true })
    await harness.dispose()
  })

  it('dispose 释放 form-context 订阅', async () => {
    const harness = await createHarness()
    harness.formContext.push(availableState())
    expect(harness.formContext.activeCount()).toBe(1)

    await harness.dispose()
    expect(harness.formContext.activeCount()).toBe(0)
    // dispose 后不再接收快照
    harness.formContext.push(availableState({ isMultiWayline: true, revision: 2 }))
    expect(reader().multiWayline).toBe(false)
  })
})
