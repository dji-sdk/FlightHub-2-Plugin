// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { queryStore, updateStoreRecord } from '../shared/store'
import { msText } from '../shared/time'
import type { BusinessError } from '../shared/validation'
import type { EventCtx } from 'fh2-plugin-sdk/backend'

interface VideoCreatedPayload {
  readonly file_id?: unknown
  readonly device_sn?: unknown
  readonly object_key?: unknown
  readonly flight_id?: unknown
  readonly video_create_time_ms?: unknown
  readonly duration_sec?: unknown
  readonly video_create_time?: unknown
  readonly [key: string]: unknown
}

const MATCH_TOLERANCE_MS = 60 * 1000

// isVisibleLight 判一段视频是不是可见光(_V)变体。
//
// 2026-10-10 212 复盘：同一段录制会按镜头各传一份(_S/_T/_V)，而 AI 检测管线
// 只为可见光 _V 产出 MOT sidecar（video_ai_process_output/ 下三个变体的 mp4
// 都在，sidecar 只有 _V.json）。先到的 _T 把 pending 事件抢走后，作业第一步
// objectTrack 就"找不到 sidecar"，重试耗尽整条后处理失败 —— 而 _V 再到时已无
// pending 可绑（绑定的幂等条件就是只绑一次）。
// 命名口径：DJI 相机文件名是 <前缀>_<序号>_<镜头字母>.mp4，V=可见光 / T=红外。
// 取不到镜头字母（手工上传、命名不符）一律判 false：宁可不绑（事件留 pending
// 等 _V），也不绑一个注定找不到 sidecar 的变体 —— 绑错的代价是整条后处理静默失败。
function isVisibleLight (objectKey: string): boolean {
  let base = String(objectKey || '')
  const slash = base.lastIndexOf('/')
  if (slash >= 0) base = base.slice(slash + 1)
  const dot = base.lastIndexOf('.')
  if (dot > 0) base = base.slice(0, dot)
  const us = base.lastIndexOf('_')
  return us >= 0 && base.slice(us + 1) === 'V'
}

export function onVideoCreated (input: VideoCreatedPayload, _ctx: EventCtx) {
  const fileId = String(input.file_id || '')
  const dockSn = String(input.device_sn || '').trim()
  const objectKey = String(input.object_key || '').trim()
  const flightId = String(input.flight_id || '').trim()
  const startMs = Math.floor(Number(input.video_create_time_ms) || 0)
  const durationMs = Math.floor((Number(input.duration_sec) || 0) * 1000)
  const rawTime = String(input.video_create_time || '')
  if (!fileId || !dockSn || !objectKey) {
    throw { code: 'INVALID_ARGUMENT', message: '回调缺 file_id / device_sn / object_key' } satisfies BusinessError
  }
  if (startMs <= 0) {
    throw { code: 'NOT_FOUND', message: '回调没有可用的拍摄时刻(video_create_time_ms=0)，放弃匹配' } satisfies BusinessError
  }
  // 只绑可见光 _V 变体（理由见 isVisibleLight）。跳过只记日志、照常 return {}：
  // 这条消息与行人上路消费方共享扇出，throw 会把对方已处理成功的同一条消息拖进
  // 死信。_T/_S 跳过后，pending 事件原地等 _V 事件来绑。
  if (!isVisibleLight(objectKey)) {
    log.warn('视频不是可见光变体，跳过变道绑定（等 _V 事件）', {
      file_id: fileId,
      device_sn: dockSn,
    })
    return {}
  }
  const width = durationMs > 0 ? durationMs : 30 * 60 * 1000
  const filter = {
    dock_sn: { eq: dockSn },
    post_status: { eq: 'pending_video' },
    crossed_at_ms: {
      gte: msText(startMs - MATCH_TOLERANCE_MS),
      lte: msText(startMs + width + MATCH_TOLERANCE_MS),
    },
    ...(flightId ? { flight_id: { eq: flightId } } : {}),
  }
  if (!flightId) log.warn('视频回调没带架次号，退回只按机场匹配', { dock_sn: dockSn, tolerance_ms: MATCH_TOLERANCE_MS })
  const page = queryStore('lane_change_event', filter, {
    limit: 50,
    orderBy: [{ field: 'crossed_at_ms', dir: 'desc' }],
  })
  if (!page.list.length) return {}
  for (let index = 0; index < page.list.length; index++) {
    const event = page.list[index]!
    updateStoreRecord('lane_change_event', {
      id: { eq: event.id }, post_status: { eq: 'pending_video' },
    }, {
      video_file_id: fileId,
      video_object_key: objectKey,
      video_start_ms: msText(startMs),
      video_end_ms: durationMs > 0 ? msText(startMs + durationMs) : '',
      video_create_raw: rawTime,
      post_status: 'waiting_artifacts',
    })
  }
  // bizId = event_id + video_file_id：同一事件换一段视频要起新流程。
  // 不能只用 event_id——作业判"违法时刻落在这段视频之外"会退回等下一段视频，而
  // 平台工作流引擎对已完成 workflowId 拒绝重开，bizId 不带视频维度的话下一段视频绑上
  // 后再也起不了新流程（2026-10-10 212 复盘实证，事件卡 waiting_artifacts）。
  // already=true 只在"同一段视频的回调重复到达"时出现，那正是幂等想要的。
  for (let index = 0; index < page.list.length; index++) {
    const event = page.list[index]!
    const boundFileId = event.video_file_id || fileId
    flow.start('lane-change-postprocess', `${event.id}:${boundFileId}`, {
      event_id: event.id,
      video_file_id: boundFileId,
      video_object_key: event.video_object_key || objectKey,
    })
  }
  return {}
}
