// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TrafficMockBackend } from './traffic-mock.js'

const servers: Server[] = []
const parkedHandles: Array<ReturnType<typeof setTimeout>> = []

afterEach(async () => {
  for (const handle of parkedHandles.splice(0)) clearTimeout(handle)
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  vi.restoreAllMocks()
})

/**
 * 哨兵延迟：大到在单个用例内绝不可能自然到期，只能由 flush() 触发。
 * 这样「flush 前尚未完成」是硬断言，而不是靠跑得比 wall-clock 快。
 */
const MEDIA_ADDED_SENTINEL_MS = 3_600_017
const AI_DETECT_SENTINEL_MS = 3_600_019

interface DelayedCallbacks {
  /** 已排队、等待 flush 的延迟回调数。 */
  readonly pending: number;
  /** 按排队顺序同步执行当前所有延迟回调。 */
  flush: () => void;
}

/**
 * 接管 backend 排的延迟回调，而不是接管整个时钟。
 *
 * 不用 `vi.useFakeTimers()`：Node 24 下它会把 undici 连接池的内部定时器一并伪造，
 * advanceTimersByTime 之后任何 fetch 都不再 resolve（空 backend 亦可复现，与被测逻辑无关）。
 * 这里只拦截延迟等于哨兵值的 setTimeout —— 即 backend 自己排的那些 —— 其余全部透传真实定时器。
 */
function captureDelayedCallbacks (...sentinels: readonly number[]): DelayedCallbacks {
  const realSetTimeout = globalThis.setTimeout
  const queue: Array<() => void> = []
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    handler: Parameters<typeof setTimeout>[0],
    ms?: number,
    ...args: unknown[]
  ) => {
    if (typeof handler === 'function' && ms !== undefined && sentinels.includes(ms)) {
      // 交还一个真实但永不到期的 handle，backend 的 clearTimeout / Set 记账照常工作
      const parked = realSetTimeout(() => {}, 2_147_483_647)
      parked.unref()
      parkedHandles.push(parked)
      queue.push(() => {
        (handler as (...callbackArgs: unknown[]) => void)(...args)
      })
      return parked
    }
    return realSetTimeout(handler, ms, ...args)
  }) as typeof setTimeout)
  return {
    get pending () {
      return queue.length
    },
    flush () {
      for (const run of queue.splice(0)) run()
    },
  }
}

async function startBackend (backend: TrafficMockBackend): Promise<{ url: string }> {
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://local.test')
    void backend.handle(req, res, requestUrl).then((handled) => {
      if (!handled && !res.writableEnded) {
        res.writeHead(404)
        res.end()
      }
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { url: `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}` }
}

const PROJECT = 'mock-project'
const VIOLATION = `/plugin-api/traffic-violation/api/v1/projects/${PROJECT}/traffic-violation`

function multipartBody (fields: Record<string, string>, file: { field: string; name: string; content: string }): { body: Buffer; contentType: string } {
  const boundary = '----mockboundary7d4a2'
  const lines: string[] = []
  for (const [name, value] of Object.entries(fields)) {
    lines.push(`--${boundary}`, `Content-Disposition: form-data; name="${name}"`, '', value)
  }
  lines.push(`--${boundary}`, `Content-Disposition: form-data; name="${file.field}"; filename="${file.name}"`, 'Content-Type: image/jpeg', '', file.content)
  lines.push(`--${boundary}--`, '')
  return {
    body: Buffer.from(lines.join('\r\n')),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

describe('traffic mock backend status', () => {
  it('status/toggle start 记录 active 状态并互斥；stop 清理；status 查询回读', async () => {
    const { url } = await startBackend(new TrafficMockBackend())

    const start = await fetch(`${url}${VIOLATION}/status/toggle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dock_sn: 'dock-1', flight_id: 'flight-1', action: 'start', scene: 'illegal_lane_change' }),
    })
    expect(await start.json()).toMatchObject({ code: 0 })

    const query = await fetch(`${url}${VIOLATION}/status?dock_sn=dock-1&scene=illegal_lane_change`)
    expect(await query.json()).toMatchObject({
      code: 0,
      data: { is_active: true, project_id: PROJECT, flight_id: 'flight-1' },
    })

    // 互斥：start 另一个 scene 会顶掉旧 scene
    await fetch(`${url}${VIOLATION}/status/toggle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dock_sn: 'dock-1', flight_id: 'flight-2', action: 'start', scene: 'illegal_road' }),
    })
    const queryAfterSwitch = await fetch(`${url}${VIOLATION}/status?dock_sn=dock-1&scene=illegal_road`)
    expect(await queryAfterSwitch.json()).toMatchObject({ data: { is_active: true, flight_id: 'flight-2' } })

    const stop = await fetch(`${url}${VIOLATION}/status/toggle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dock_sn: 'dock-1', action: 'stop', scene: 'illegal_road' }),
    })
    expect(await stop.json()).toMatchObject({ code: 0 })
    const queryAfterStop = await fetch(`${url}${VIOLATION}/status?dock_sn=dock-1&scene=illegal_road`)
    expect(await queryAfterStop.json()).toMatchObject({ data: { is_active: false, flight_id: '' } })
  })
})

describe('traffic mock backend tracking', () => {
  it('illegal_road tracking 创建后延迟回传 media_added 并填充 latest_photo', async () => {
    const mediaAdded = captureDelayedCallbacks(MEDIA_ADDED_SENTINEL_MS)
    const backend = new TrafficMockBackend({ mediaAddedDelayMs: MEDIA_ADDED_SENTINEL_MS })
    const { url } = await startBackend(backend)

    const start = await fetch(`${url}${VIOLATION}/tracking/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dock_sn: 'dock-1', flight_id: 'flight-1', started_at: Date.now() }),
    })
    const startJson = await start.json() as { data: { tracking_id: number } }
    expect(startJson.data.tracking_id).toBe(1)

    const listBefore = await (await fetch(`${url}${VIOLATION}/trackings?flight_id=flight-1&scene=illegal_road`)).json() as {
      data: { total: number; trackings: Array<{ id: number; ended_at: number; latest_photo: unknown }> };
    }
    expect(listBefore.data.total).toBe(1)
    expect(listBefore.data.trackings[0]).toMatchObject({ ended_at: 0, latest_photo: null })

    // 回调必须是「排了队但还没跑」，否则下面的 flush 断言不成立
    expect(mediaAdded.pending).toBe(1)
    mediaAdded.flush()

    const events = await (await fetch(`${url}/plugin-api/mock/traffic/ws-events?cursor=0`)).json() as {
      events: Array<{ bizCode: string; subBizCode: string; data: Record<string, unknown> }>;
    }
    const mediaEvent = events.events.find(event => event.bizCode === 'violation_capture')
    expect(mediaEvent).toMatchObject({ subBizCode: 'media_added' })
    expect(mediaEvent?.data).toMatchObject({ scene: 'illegal_road', tracking_id: 1, media_type: 1 })

    const listAfter = await (await fetch(`${url}${VIOLATION}/trackings?flight_id=flight-1`)).json() as {
      data: { trackings: Array<{ latest_photo: { preview_url: string } | null }> };
    }
    expect(listAfter.data.trackings[0]?.latest_photo?.preview_url).toContain('/plugin-api/mock/traffic/media/')

    const media = await fetch(`${url}${listAfter.data.trackings[0]!.latest_photo!.preview_url}`)
    expect(media.status).toBe(200)
    expect(media.headers.get('content-type')).toBe('image/png')
    const bytes = Buffer.from(await media.arrayBuffer())
    expect(bytes[0]).toBe(0x89)
    expect(bytes[1]).toBe(0x50)
  })

  it('illegal_lane_change immediately tracking 关闭窗口并结束同 dock 的 illegal_road tracking', async () => {
    const { url } = await startBackend(new TrafficMockBackend())

    await fetch(`${url}${VIOLATION}/tracking/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dock_sn: 'dock-1', flight_id: 'flight-1', started_at: 1000 }),
    })
    const laneChange = await fetch(`${url}${VIOLATION}/tracking/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dock_sn: 'dock-1',
        flight_id: 'flight-1',
        started_at: 5000,
        scene: 'illegal_lane_change',
        immediately: true,
        crossed_at: 5000,
        collision_type: 'solid_line',
        annotation: { id: 1, snapshot: { name: 'AI实线 1', kind: 'line', normalized_points: [], geo_points: [] } },
      }),
    })
    const laneChangeJson = await laneChange.json() as { data: { tracking_id: number } }
    expect(laneChangeJson.data.tracking_id).toBe(2)

    const list = await (await fetch(`${url}${VIOLATION}/trackings?flight_id=flight-1`)).json() as {
      data: { trackings: Array<{ id: number; scene: string; started_at: number; ended_at: number; crossed_at?: number; collision_type?: string; annotation_snapshot?: string }> };
    }
    const road = list.data.trackings.find(item => item.scene === 'illegal_road')
    const lane = list.data.trackings.find(item => item.scene === 'illegal_lane_change')
    expect(road?.ended_at).toBeGreaterThan(0)
    expect(lane).toMatchObject({
      started_at: 5000,
      ended_at: 15_000,
      crossed_at: 5000,
      collision_type: 'solid_line',
    })
    expect(typeof lane?.annotation_snapshot).toBe('string')
  })

  it('tracking/stop 设置结束时间', async () => {
    const { url } = await startBackend(new TrafficMockBackend())
    await fetch(`${url}${VIOLATION}/tracking/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dock_sn: 'dock-1', flight_id: 'flight-1', started_at: 1000 }),
    })
    const stop = await fetch(`${url}${VIOLATION}/tracking/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tracking_id: 1, ended_at: 9000 }),
    })
    expect(await stop.json()).toMatchObject({ code: 0 })
    const list = await (await fetch(`${url}${VIOLATION}/trackings?flight_id=flight-1`)).json() as {
      data: { trackings: Array<{ ended_at: number }> };
    }
    expect(list.data.trackings[0]?.ended_at).toBe(9000)
  })
})

describe('traffic mock backend ai-detect', () => {
  async function uploadFrame (url: string): Promise<string> {
    const { body, contentType } = multipartBody(
      { dock_sn: 'dock-1', flight_id: 'flight-1', project_id: 'mock-project', drone_timestamp: '1000' },
      { field: 'file', name: 'live-frame.jpg', content: 'fake-jpeg-bytes' },
    )
    const response = await fetch(`${url}/plugin-api/traffic-violation/api/v1/ai-detect/lane-marking/frame`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: new Uint8Array(body),
    })
    const json = await response.json() as { code: number; data: { request_id: string } }
    expect(json.code).toBe(0)
    return json.data.request_id
  }

  it('frame 上传后进入 processing，延迟完成并推送 lane_change_ai_detect_done', async () => {
    const aiDetect = captureDelayedCallbacks(AI_DETECT_SENTINEL_MS)
    const { url } = await startBackend(new TrafficMockBackend({ aiDetectDelayMs: AI_DETECT_SENTINEL_MS }))

    const requestId = await uploadFrame(url)

    const pollBefore = await (await fetch(`${url}/plugin-api/traffic-violation/api/v1/ai-detect/lane-marking/request/${requestId}`)).json() as {
      data: { status: string };
    }
    expect(pollBefore.data.status).toBe('processing')

    expect(aiDetect.pending).toBe(1)
    aiDetect.flush()

    const pollAfter = await (await fetch(`${url}/plugin-api/traffic-violation/api/v1/ai-detect/lane-marking/request/${requestId}`)).json() as {
      data: { status: string; objects: Array<{ type: string; shape: string }> };
    }
    expect(pollAfter.data.status).toBe('done')
    expect(pollAfter.data.objects).toHaveLength(2)
    expect(pollAfter.data.objects[0]).toMatchObject({ type: 'white_solid_line', shape: 'polyline' })
    expect(pollAfter.data.objects[1]).toMatchObject({ type: 'guide_area', shape: 'polygon' })

    const events = await (await fetch(`${url}/plugin-api/mock/traffic/ws-events?cursor=0`)).json() as {
      events: Array<{ bizCode: string; subBizCode: string; data: Record<string, unknown> }>;
    }
    const aiEvent = events.events.find(event => event.bizCode === 'lane_change_ai_detect')
    expect(aiEvent?.subBizCode).toBe('lane_change_ai_detect_done')
    expect(aiEvent?.data).toMatchObject({ request_id: requestId, dock_sn: 'dock-1', image_width: 1280 })
  })

  it('ai-config 注入 empty/error 模式；ws-events 游标只返回增量', async () => {
    const aiDetect = captureDelayedCallbacks(AI_DETECT_SENTINEL_MS)
    const { url } = await startBackend(new TrafficMockBackend({ aiDetectDelayMs: AI_DETECT_SENTINEL_MS }))

    await fetch(`${url}/plugin-api/mock/traffic/ai-config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'empty' }),
    })
    const emptyRequest = await uploadFrame(url)
    expect(aiDetect.pending).toBe(1)
    aiDetect.flush()
    const emptyPoll = await (await fetch(`${url}/plugin-api/traffic-violation/api/v1/ai-detect/lane-marking/request/${emptyRequest}`)).json() as {
      data: { objects: unknown[] };
    }
    expect(emptyPoll.data.objects).toEqual([])

    // 游标：第一次拉取后，第二次只返回新事件
    const firstPull = await (await fetch(`${url}/plugin-api/mock/traffic/ws-events?cursor=0`)).json() as {
      events: unknown[];
      nextCursor: number;
    }
    expect(firstPull.events).toHaveLength(1)
    const secondPull = await (await fetch(`${url}/plugin-api/mock/traffic/ws-events?cursor=${firstPull.nextCursor}`)).json() as {
      events: unknown[];
    }
    expect(secondPull.events).toHaveLength(0)

    await fetch(`${url}/plugin-api/mock/traffic/ai-config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'error' }),
    })
    const errorRequest = await uploadFrame(url)
    expect(aiDetect.pending).toBe(1)
    aiDetect.flush()
    const errorPoll = await (await fetch(`${url}/plugin-api/traffic-violation/api/v1/ai-detect/lane-marking/request/${errorRequest}`)).json() as {
      data: { error_msg: string };
    }
    expect(errorPoll.data.error_msg).toContain('unavailable')
  })

  it('非 multipart 请求被拒绝；reset 清空全部状态', async () => {
    const { url } = await startBackend(new TrafficMockBackend())

    const badFrame = await fetch(`${url}/plugin-api/traffic-violation/api/v1/ai-detect/lane-marking/frame`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(badFrame.status).toBe(400)

    await fetch(`${url}${VIOLATION}/tracking/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dock_sn: 'dock-1', flight_id: 'flight-1', started_at: 1000 }),
    })
    await fetch(`${url}/plugin-api/mock/traffic/reset`, { method: 'POST' })
    const list = await (await fetch(`${url}${VIOLATION}/trackings`)).json() as { data: { total: number } }
    expect(list.data.total).toBe(0)
  })
})
