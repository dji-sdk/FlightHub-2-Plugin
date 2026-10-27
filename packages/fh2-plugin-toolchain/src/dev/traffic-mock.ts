// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { closeRequestAfterResponse } from './http-lifecycle.js'

/**
 * 交通违章抓拍 Mock 后端：复刻交通违章抓拍后端协议（status/toggle、tracking、ai-detect），
 * Node 内存态为唯一事实源；异步结果（AI 识别、媒体回传）写入事件日志，
 * 由宿主 Shell 经 `/plugin-api/mock/traffic/ws-events` 轮询桥接为 WS 推送。
 */

const VIOLATION_BASE = '/plugin-api/traffic-violation/api/v1/projects'
const AI_DETECT_BASE = '/plugin-api/traffic-violation/api/v1/ai-detect'
const MOCK_BASE = '/plugin-api/mock/traffic'

const AI_DETECT_DONE_DELAY_MS = 1500
const MEDIA_ADDED_DELAY_MS = 2500
const AI_OK_OBJECTS = [
  {
    type: 'white_solid_line',
    shape: 'polyline',
    points: [[0.25, 0.62], [0.45, 0.58], [0.65, 0.54], [0.85, 0.5]],
  },
  {
    type: 'guide_area',
    shape: 'polygon',
    points: [[0.55, 0.7], [0.75, 0.66], [0.8, 0.8], [0.6, 0.84]],
  },
] as const

/** 192x108 证据缩略图（深蓝底 + 黄色标线 + 红色车辆块）。 */
const MOCK_MEDIA_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAMAAAABsCAIAAACzYCrFAAACoklEQVR4nO3Ty1YTURBG4f8xSCAQhNwBISB3JAmCgoqCEgUFFQVf2YFP4siBE1baQVLVOSeXvdY371NVuzVRbABmiv4CDDUCgosmik3ATBOlJmBGQHBRptQCzAgILsqUW4CZMuUDwIyA4KJs5RlgYMRCzZtV2AmTLlA4CMgOLSNv7eOAV+9ymTUs2bURBQUGbNq1qly5d2qZt2rZtRUGBv1+lSpXWqFFjxYoV+/atW7du3dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt27dq1a9euXbt26BBg7dB3QHYKOHoRQAAAABJRU5ErkJggg==',
  'base64',
)

export interface MockWsEvent {
  readonly id: number;
  readonly bizCode: string;
  readonly subBizCode: string;
  readonly data: Record<string, unknown>;
  readonly timestamp: number;
}

interface MockTracking {
  id: number;
  project_id: string;
  dock_sn: string;
  flight_id: string;
  scene: string;
  started_at: number;
  ended_at: number;
  crossed_at?: number;
  collision_type?: string;
  annotation_snapshot?: string;
  folder_id: number;
  parent_folder_id: number;
  latest_photo?: {
    file_id: number;
    preview_url: string;
    original_url: string;
    photo_time_ms: number;
  } | null;
}

interface AiDetectRequest {
  request_id: string;
  dock_sn: string;
  flight_id: string;
  status: 'processing' | 'done';
  objects?: unknown[];
  error_msg?: string;
}

export type MockAiDetectMode = 'ok' | 'empty' | 'error'

export interface TrafficMockOptions {
  readonly now?: () => number;
  readonly aiDetectDelayMs?: number;
  readonly mediaAddedDelayMs?: number;
}

export class TrafficMockBackend {
  private readonly now: () => number
  private readonly aiDetectDelayMs: number
  private readonly mediaAddedDelayMs: number
  private readonly activeScenes = new Map<string, { scene: string; flightId: string; projectId: string }>()
  private readonly trackings: MockTracking[] = []
  private readonly aiRequests = new Map<string, AiDetectRequest>()
  private readonly events: MockWsEvent[] = []
  private aiDetectMode: MockAiDetectMode = 'ok'
  private trackingSequence = 0
  private mediaSequence = 0
  private eventSequence = 0
  private aiRequestSequence = 0
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()

  constructor (options: TrafficMockOptions = {}) {
    this.now = options.now ?? Date.now
    this.aiDetectDelayMs = options.aiDetectDelayMs ?? AI_DETECT_DONE_DELAY_MS
    this.mediaAddedDelayMs = options.mediaAddedDelayMs ?? MEDIA_ADDED_DELAY_MS
  }

  close (): void {
    for (const timer of [...this.timers]) clearTimeout(timer)
    this.timers.clear()
  }

  private emit (bizCode: string, subBizCode: string, data: Record<string, unknown>): void {
    this.eventSequence += 1
    this.events.push({
      id: this.eventSequence,
      bizCode,
      subBizCode,
      data,
      timestamp: this.now(),
    })
  }

  /** 是否命中交通违章 Mock 路由（含 ai-detect 与 mock 控制端点）。 */
  matches (pathname: string): boolean {
    return pathname.startsWith(VIOLATION_BASE)
      || pathname.startsWith(AI_DETECT_BASE)
      || pathname.startsWith(MOCK_BASE)
  }

  async handle (req: IncomingMessage, res: ServerResponse, requestUrl: URL): Promise<boolean> {
    const pathname = requestUrl.pathname
    if (!this.matches(pathname)) return false

    if (pathname === `${MOCK_BASE}/ws-events`) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return true
      }
      const cursor = Number(requestUrl.searchParams.get('cursor') ?? '0') || 0
      const pending = this.events.filter(event => event.id > cursor)
      sendJson(res, 200, {
        events: pending,
        nextCursor: pending.length > 0 ? pending[pending.length - 1]!.id : cursor,
      })
      return true
    }

    if (pathname === `${MOCK_BASE}/ai-config`) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return true
      }
      const body = await readJsonBody(req)
      if (body === undefined) {
        sendJson(res, 400, { error: 'invalid json' })
        return true
      }
      if (body.mode === 'ok' || body.mode === 'empty' || body.mode === 'error') {
        this.aiDetectMode = body.mode
      }
      sendJson(res, 200, { mode: this.aiDetectMode })
      return true
    }

    if (pathname === `${MOCK_BASE}/reset`) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return true
      }
      this.reset()
      sendJson(res, 200, { ok: true })
      return true
    }

    const mediaMatchPath = pathname.match(/^\/plugin-api\/mock\/traffic\/media\/(\d+)$/)
    if (mediaMatchPath !== null) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return true
      }
      closeRequestAfterResponse(req, res)
      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'no-store',
      })
      res.end(MOCK_MEDIA_PNG)
      return true
    }

    const violationMatch = matchViolationPath(pathname)
    if (violationMatch !== undefined) {
      await this.handleViolationApi(req, res, violationMatch)
      return true
    }

    if (pathname === `${AI_DETECT_BASE}/lane-marking/frame`) {
      await this.handleAiDetectFrame(req, res)
      return true
    }

    const aiPollMatch = pathname.match(/^\/plugin-api\/traffic-violation\/api\/v1\/ai-detect\/lane-marking\/request\/([^/]+)$/)
    if (aiPollMatch !== null) {
      this.handleAiDetectPoll(res, aiPollMatch[1]!)
      return true
    }

    sendJson(res, 404, { error: 'not found' })
    return true
  }

  private mediaPathPattern (): RegExp {
    return /./
  }

  private async handleViolationApi (
    req: IncomingMessage,
    res: ServerResponse,
    match: { readonly projectId: string; readonly segments: readonly string[] },
  ): Promise<void> {
    const action = match.segments.join('/')
    if (action === 'status/toggle' && req.method === 'POST') {
      const body = await readJsonBody(req)
      if (body === undefined || typeof body.dock_sn !== 'string' || (body.action !== 'start' && body.action !== 'stop')) {
        sendJson(res, 400, envelope(40001, 'invalid parameter'))
        return
      }
      const scene = typeof body.scene === 'string' && body.scene ? body.scene : 'illegal_road'
      if (body.action === 'start') {
        if (typeof body.flight_id !== 'string' || !body.flight_id) {
          sendJson(res, 400, envelope(40001, 'invalid parameter: start 需要 flight_id'))
          return
        }
        // 原生后端语义：任一 scene start 会清理同 dock 的其他 active scene
        this.activeScenes.set(body.dock_sn, { scene, flightId: body.flight_id, projectId: match.projectId })
      } else if (scene === undefined) {
        this.activeScenes.delete(body.dock_sn)
      } else {
        const active = this.activeScenes.get(body.dock_sn)
        if (active?.scene === scene) this.activeScenes.delete(body.dock_sn)
      }
      sendJson(res, 200, envelope(0, 'Success', { message: 'ok' }))
      return
    }

    if (action === 'status' && req.method === 'GET') {
      const dockSn = requestParam(req, 'dock_sn')
      if (!dockSn) {
        sendJson(res, 400, envelope(40001, 'invalid parameter: 缺少 dock_sn'))
        return
      }
      const active = this.activeScenes.get(dockSn)
      sendJson(res, 200, envelope(0, 'Success', {
        is_active: active !== undefined,
        project_id: active?.projectId ?? '',
        flight_id: active?.flightId ?? '',
      }))
      return
    }

    if (action === 'tracking/start' && req.method === 'POST') {
      const body = await readJsonBody(req)
      if (body === undefined
        || typeof body.dock_sn !== 'string'
        || typeof body.flight_id !== 'string'
        || typeof body.started_at !== 'number' || body.started_at <= 0) {
        sendJson(res, 400, envelope(40001, 'invalid parameter'))
        return
      }
      const scene = typeof body.scene === 'string' && body.scene ? body.scene : 'illegal_road'
      this.trackingSequence += 1
      const trackingId = this.trackingSequence
      const crossedAt = typeof body.crossed_at === 'number' ? body.crossed_at : undefined
      const tracking: MockTracking = {
        id: trackingId,
        project_id: match.projectId,
        dock_sn: body.dock_sn,
        flight_id: body.flight_id,
        scene,
        started_at: body.started_at,
        ended_at: scene === 'illegal_lane_change' && crossedAt !== undefined
          ? crossedAt + 10_000
          : 0,
        ...(crossedAt !== undefined ? { crossed_at: crossedAt } : {}),
        ...(typeof body.collision_type === 'string' ? { collision_type: body.collision_type } : {}),
        ...(typeof body.annotation === 'object' && body.annotation !== null
          ? { annotation_snapshot: JSON.stringify((body.annotation as Record<string, unknown>).snapshot ?? null) }
          : {}),
        folder_id: 0,
        parent_folder_id: 0,
        latest_photo: null,
      }
      // 原生语义：变道 immediately=true 会关闭同 dock 进行中的 illegal_road tracking
      if (scene === 'illegal_lane_change' && body.immediately === true) {
        for (const item of this.trackings) {
          if (item.dock_sn === body.dock_sn && item.scene === 'illegal_road' && item.ended_at === 0) {
            item.ended_at = this.now()
          }
        }
      }
      this.trackings.push(tracking)

      // 媒体回传：延迟推送 media_added 并填充 latest_photo（图片走 mock 媒体端点）
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        this.mediaSequence += 1
        const mediaId = this.mediaSequence
        tracking.latest_photo = {
          file_id: mediaId,
          preview_url: `${MOCK_BASE}/media/${mediaId}`,
          original_url: `${MOCK_BASE}/media/${mediaId}`,
          photo_time_ms: this.now(),
        }
        this.emit('violation_capture', 'media_added', {
          scene,
          tracking_id: trackingId,
          dock_sn: tracking.dock_sn,
          flight_id: tracking.flight_id,
          media_id: mediaId,
          media_type: 1,
        })
      }, this.mediaAddedDelayMs)
      this.timers.add(timer)

      sendJson(res, 200, envelope(0, 'Success', { tracking_id: trackingId, message: 'ok' }))
      return
    }

    if (action === 'tracking/stop' && req.method === 'POST') {
      const body = await readJsonBody(req)
      if (body === undefined || typeof body.tracking_id !== 'number' || typeof body.ended_at !== 'number') {
        sendJson(res, 400, envelope(40001, 'invalid parameter'))
        return
      }
      const tracking = this.trackings.find(item => item.id === body.tracking_id)
      if (tracking) tracking.ended_at = body.ended_at
      sendJson(res, 200, envelope(0, 'Success', { message: 'ok' }))
      return
    }

    if (action === 'trackings' && req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://mock.local')
      const flightId = url.searchParams.get('flight_id') ?? ''
      const scene = url.searchParams.get('scene')
      const list = this.trackings.filter(item =>
        (flightId === '' || item.flight_id === flightId)
        && (scene === null || scene === '' || item.scene === scene))
      sendJson(res, 200, envelope(0, 'Success', {
        total: list.length,
        trackings: list.map(item => ({ ...item })),
      }))
      return
    }

    const mediaMatch = action.match(/tracking\/(\d+)\/media$/)
    if (mediaMatch !== null && req.method === 'GET') {
      const trackingId = Number(mediaMatch[1])
      const tracking = this.trackings.find(item => item.id === trackingId)
      const media = tracking?.latest_photo
      sendJson(res, 200, envelope(0, 'Success', {
        total: media ? 1 : 0,
        media: media
          ? [{
              id: media.file_id,
              media_type: 1,
              preview_url: media.preview_url,
              original_url: media.original_url,
              file_name: `mock-${media.file_id}.png`,
              captured_at_ms: media.photo_time_ms,
            }]
          : [],
      }))
      return
    }

    sendJson(res, 404, envelope(40400, 'not found'))
  }

  private async handleAiDetectFrame (req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, envelope(40500, 'method not allowed'))
      return
    }
    const contentType = String(req.headers['content-type'] ?? '')
    if (!contentType.startsWith('multipart/form-data')) {
      sendJson(res, 400, envelope(40001, 'invalid parameter: 需要 multipart/form-data'))
      return
    }
    const parts = await readMultipartBody(req, contentType)
    if (parts === undefined) {
      sendJson(res, 400, envelope(40001, 'invalid parameter: multipart 解析失败'))
      return
    }
    const field = (name: string): string => {
      const part = parts.fields.find(item => item.name === name)
      return typeof part?.value === 'string' ? part.value : ''
    }
    const dockSn = field('dock_sn')
    if (!dockSn || parts.files.length === 0) {
      sendJson(res, 400, envelope(40001, 'invalid parameter: 缺少 dock_sn 或文件'))
      return
    }

    this.aiRequestSequence += 1
    const requestId = `mock-ai-${this.aiRequestSequence}`
    const request: AiDetectRequest = {
      request_id: requestId,
      dock_sn: dockSn,
      flight_id: field('flight_id'),
      status: 'processing',
    }
    this.aiRequests.set(requestId, request)

    const timer = setTimeout(() => {
      this.timers.delete(timer)
      const mode = this.aiDetectMode
      if (mode === 'error') {
        request.status = 'done'
        request.error_msg = 'mock ai service unavailable'
      } else if (mode === 'empty') {
        request.status = 'done'
        request.objects = []
      } else {
        request.status = 'done'
        request.objects = AI_OK_OBJECTS.map(object => ({ ...object, points: object.points.map(point => [...point]) }))
      }
      this.emit('lane_change_ai_detect', 'lane_change_ai_detect_done', {
        request_id: requestId,
        dock_sn: request.dock_sn,
        flight_id: request.flight_id,
        image_width: 1280,
        image_height: 720,
        objects: request.objects ?? [],
        ...(request.error_msg !== undefined ? { error_msg: request.error_msg } : {}),
      })
    }, this.aiDetectDelayMs)
    this.timers.add(timer)

    sendJson(res, 200, envelope(0, 'Success', { request_id: requestId }))
  }

  private handleAiDetectPoll (res: ServerResponse, requestId: string): void {
    const request = this.aiRequests.get(requestId)
    if (!request) {
      sendJson(res, 404, envelope(40400, 'request not found'))
      return
    }
    sendJson(res, 200, envelope(0, 'Success', {
      status: request.status,
      ...(request.objects !== undefined ? { objects: request.objects } : {}),
      ...(request.error_msg !== undefined ? { error_msg: request.error_msg } : {}),
    }))
  }

  private reset (): void {
    for (const timer of [...this.timers]) clearTimeout(timer)
    this.timers.clear()
    this.activeScenes.clear()
    this.trackings.length = 0
    this.aiRequests.clear()
    this.events.length = 0
    this.aiDetectMode = 'ok'
    this.trackingSequence = 0
    this.mediaSequence = 0
    this.eventSequence = 0
    this.aiRequestSequence = 0
  }
}

function requestParam (req: IncomingMessage, name: string): string {
  const url = new URL(req.url ?? '/', 'http://mock.local')
  return url.searchParams.get(name) ?? ''
}

function matchViolationPath (pathname: string): { projectId: string; segments: readonly string[] } | undefined {
  const match = pathname.match(/^\/plugin-api\/traffic-violation\/api\/v1\/projects\/([^/]+)\/traffic-violation\/(.+)$/)
  if (match === null) return undefined
  return { projectId: match[1]!, segments: match[2]!.split('/') }
}

interface MultipartParseResult {
  readonly fields: Array<{ name: string; value: string | undefined }>;
  readonly files: Array<{ field: string; name: string; contentType: string; bytes: number }>;
}

/** 轻量 multipart 解析：只提取字段值与文件元信息（Mock 后端不消费文件内容）。 */
async function readMultipartBody (req: IncomingMessage, contentType: string): Promise<MultipartParseResult | undefined> {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]
  if (!boundary) return undefined
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.byteLength
    if (size > 10 * 1024 * 1024) return undefined
    chunks.push(buffer)
  }
  const body = Buffer.concat(chunks)
  const delimiter = Buffer.from(`--${boundary}`)
  const fields: MultipartParseResult['fields'] = []
  const files: MultipartParseResult['files'] = []

  let start = body.indexOf(delimiter)
  while (start !== -1) {
    const next = body.indexOf(delimiter, start + delimiter.length)
    if (next === -1) break
    // 跳过 boundary 后的 CRLF
    let partStart = start + delimiter.length
    if (body[partStart] === 0x0D && body[partStart + 1] === 0x0A) partStart += 2
    let partEnd = next
    if (body[partEnd - 2] === 0x0D && body[partEnd - 1] === 0x0A) partEnd -= 2
    const part = body.subarray(partStart, partEnd)
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd !== -1) {
      const headers = part.subarray(0, headerEnd).toString('utf8')
      const content = part.subarray(headerEnd + 4)
      const nameMatch = headers.match(/name="([^"]*)"/)
      const fileMatch = headers.match(/filename="([^"]*)"/)
      const typeMatch = headers.match(/content-type:\s*([^\r\n]+)/i)
      if (nameMatch !== null) {
        if (fileMatch !== null) {
          files.push({
            field: nameMatch[1]!,
            name: fileMatch[1]!,
            contentType: typeMatch?.[1]?.trim() ?? 'application/octet-stream',
            bytes: content.byteLength,
          })
        } else {
          fields.push({ name: nameMatch[1]!, value: content.toString('utf8') })
        }
      }
    }
    start = next
  }
  return { fields, files }
}

async function readJsonBody (req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

function envelope (code: number, msg: string, data: unknown = null): Record<string, unknown> {
  return { code, msg, data }
}

function sendJson (res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
