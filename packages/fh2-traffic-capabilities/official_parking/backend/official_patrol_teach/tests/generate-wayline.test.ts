// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { h_teach_generateWayline } from '../handlers/teach/generate-wayline'

// generate-wayline 的行为门禁。★ 核心钉一件事:【生成必须释放同架次锁】——
// 置终态的 update patch 里 recording_flight_id 必须显式置 null。
//
// 真踩过(worker 侧 2026-09-20 修复,见平台 worker 仓 29be054):
// 生成后不释放锁 → 同架次第二次 enterRoute 撞唯一索引 23505,
// 误报「该架次已有一条录制中的航线」(其实那条早就是 generated 终态)。
//
// ⚠️⚠️ 必须是 null、不能是空串:空串在 PG 唯一索引里【判重】,
// 第二条航线生成置空串时 UPDATE 直接 23505;而 null 互不相等,
// 同架次可以「生成→继续录→再生成」串行任意多段。
// 置 null 的链路：JS null 经存储层原样绑定为 NULL（存储层放行空值）。

function result<T> (data: T): { readonly ok: true; readonly data: T } {
  return { ok: true, data }
}

function page<T> (list: T[]): { list: T[]; total: number; limit: number; offset: number } {
  return { list, total: list.length, limit: list.length, offset: 0 }
}

function route (overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'route-1',
    project_id: 'project-1',
    name: '巡逻航线',
    flight_id: 'flight-1',
    dock_sn: 'dock-1',
    drone_sn: 'drone-1',
    status: 'recording',
    global_speed: '15',
    waypoint_speed: '5',
    wayline_uuid: '',
    wayline_file_id: '',
    kmz_object_key: '',
    screenshot_bytes: '0',
    recording_flight_id: 'flight-1',
    ...overrides,
  }
}

function waypoint (overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'waypoint-1',
    teach_route_id: 'route-1',
    seq: '000001',
    latitude: '22.5',
    longitude: '114.0',
    height: '10',
    gimbal_pitch: '-45',
    camera_yaw: '90',
    focal_length: '24',
    ai_recognition_on: 'false',
    ai_target_types: '',
    selected: 'true',
    ...overrides,
  }
}

function stubHappyStore () {
  const update = vi.fn((_entity: string, _filter: unknown, _patch: Record<string, unknown>) => result({ affected: 1 }))
  const query = vi.fn((entity: string) => result(page(entity === 'teach_route'
    ? [route()]
    : [waypoint(), waypoint({ id: 'waypoint-2', seq: '000002' })])))
  const generate = vi.fn((_intent: Record<string, unknown>) => ({ waylineUuid: 'wayline-1', objectKey: 'generated.kmz', name: '巡逻航线', waypointCount: 2 }))
  vi.stubGlobal('store', {
    query,
    update,
    delete: vi.fn(() => result({ deleted: 2 })),
  })
  vi.stubGlobal('wayline', { generate })
  vi.stubGlobal('log', { info: vi.fn(), warn: vi.fn(), error: vi.fn() })
  return { update, query, generate }
}

function thrownBy (run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('Expected the function to throw')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('h_teach_generateWayline 架次锁释放门禁', () => {
  it('成功生成后,置终态的 patch 必须显式携带 recording_flight_id: null(空串/缺失都算锁没释放)', () => {
    const { update } = stubHappyStore()

    const out = h_teach_generateWayline({ teach_route_id: 'route-1', name: '巡逻航线', drone_model_key: '0-100-1' })

    expect(out).toMatchObject({ teach_route_id: 'route-1', wayline_uuid: 'wayline-1', waypoint_count: 2 })
    expect(update).toHaveBeenCalledTimes(1)
    const [entity, filter, patch] = update.mock.calls[0]!
    expect(entity).toBe('teach_route')
    // 抢占条件保持 status=recording,与置 generated 的 patch 是同一次条件更新。
    expect(filter).toEqual({ id: { eq: 'route-1' }, status: { eq: 'recording' } })
    // ★ 门禁本体:null 严格相等(toBe 同时排除 undefined 与 ''),
    //   且键必须显式存在 —— 缺这个键就是插件化丢掉的那半句。
    expect('recording_flight_id' in patch).toBe(true)
    expect(patch.recording_flight_id).toBe(null)
    expect(patch.status).toBe('generated')
  })

  it('生成失败(能力面抛错)时不置终态也不动锁,航线保持 recording 可重试', () => {
    const update = vi.fn((_entity: string, _filter: unknown, _patch: Record<string, unknown>) => result({ affected: 1 }))
    vi.stubGlobal('store', {
      query: vi.fn((entity: string) => result(page(entity === 'teach_route'
        ? [route()]
        : [waypoint(), waypoint({ id: 'waypoint-2', seq: '000002' })]))),
      update,
      delete: vi.fn(),
    })
    vi.stubGlobal('wayline', {
      generate: vi.fn(() => {
        throw new Error('KMZ 上传失败')
      }),
    })
    vi.stubGlobal('log', { info: vi.fn(), warn: vi.fn(), error: vi.fn() })

    expect(thrownBy(() => h_teach_generateWayline({ teach_route_id: 'route-1', name: '巡逻航线', drone_model_key: '0-100-1' }))).toEqual({
      code: 'INTERNAL',
      message: '航线上传失败,录制内容已保留,请稍后重试',
    })
    expect(update).not.toHaveBeenCalled()
  })
})

describe('h_teach_generateWayline 机型 key 门禁', () => {
  // 与平台侧口径一致：
  // drone_model_key 必填,漏传当场 INVALID_ARGUMENT —— 不拦的话能力面按 M4D 兜底,
  // 产物静默错配(能飞、拍的不对),要到复飞才发现。
  it('漏传 drone_model_key 时 INVALID_ARGUMENT,且不触达能力面', () => {
    const { generate, update } = stubHappyStore()

    expect(thrownBy(() => h_teach_generateWayline({ teach_route_id: 'route-1', name: '巡逻航线' }))).toEqual({
      code: 'INVALID_ARGUMENT',
      message: 'drone_model_key 不能为空',
    })
    expect(generate).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('drone_model_key 必须透传到能力面 intent,丢了就是静默错配', () => {
    const { generate } = stubHappyStore()

    h_teach_generateWayline({ teach_route_id: 'route-1', name: '巡逻航线', drone_model_key: '0-100-1' })

    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate.mock.calls[0]![0]).toMatchObject({ droneEnumKey: '0-100-1' })
  })

  it('payload_model_key 可选:不传时 intent 不携带该键,传了则原样透传', () => {
    const { generate } = stubHappyStore()

    h_teach_generateWayline({ teach_route_id: 'route-1', name: '巡逻航线', drone_model_key: '0-103-0' })
    const intentWithoutPayload = generate.mock.calls[0]![0] as Record<string, unknown>
    expect(intentWithoutPayload.droneEnumKey).toBe('0-103-0')
    expect('payloadEnumKey' in intentWithoutPayload).toBe(false)

    h_teach_generateWayline({ teach_route_id: 'route-1', name: '巡逻航线', drone_model_key: '0-103-0', payload_model_key: '1-82-0' })
    expect(generate.mock.calls[1]![0]).toMatchObject({ droneEnumKey: '0-103-0', payloadEnumKey: '1-82-0' })
  })
})
