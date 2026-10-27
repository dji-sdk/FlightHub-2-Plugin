// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 视觉/几何 fixture（Plan §8.6）：linear / fan-out / fan-in / diamond /
 * long-edge / finalizers / wait-callback / accident-response（真实事故流程）
 * / parking-patrol（真实巡逻流程）/ large / invalid-cycle。
 *
 * 真实流程按 `fh2-traffic-capabilities` 的 workflow JSON 结构等价转写
 * （steps/needs/trigger/await/when/trigger 字段一致，长描述裁剪），
 * 不跨 workspace import —— fixture 必须自包含且确定性。
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseWorkflowDocument, toGraph } from '../../../../../src/workflow/core/model.js'
import type { WorkflowGraph } from '../../../../../src/workflow/core/model.js'

/**
 * 视觉快照输出目录（canvas-visual.test.ts 产物；不进 git）。
 * ★ 按本模块文件位置解析（routing-polish §8：固定同一位置）——
 *   从前是相对 CWD 的路径，从不同目录起跑会散落到 src/ 或 _test/ 下。
 */
export const SNAPSHOT_OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '.canvas-snapshots')

export function graphOf (json: string): WorkflowGraph {
  const result = parseWorkflowDocument(json)
  if (!result.ok) throw new Error(result.message)
  return toGraph(result.document)
}

export const LINEAR = `{"name":"linear","trigger":{"api":{}},"steps":[
  {"id":"a","action":"x"},
  {"id":"b","action":"x","needs":["a"]},
  {"id":"c","action":"x","needs":["b"]},
  {"id":"d","action":"x","needs":["c"]}
]}`

export const FAN_OUT = `{"name":"fan-out","trigger":{"api":{}},"steps":[
  {"id":"source","action":"x"},
  {"id":"t0","action":"x","needs":["source"]},
  {"id":"t1","action":"x","needs":["source"]},
  {"id":"t2","action":"x","needs":["source"]},
  {"id":"t3","action":"x","needs":["source"]},
  {"id":"t4","action":"x","needs":["source"]}
]}`

export const FAN_IN = `{"name":"fan-in","trigger":{"api":{}},"steps":[
  {"id":"s0","action":"x"},{"id":"s1","action":"x"},{"id":"s2","action":"x"},
  {"id":"s3","action":"x"},{"id":"s4","action":"x"},
  {"id":"sink","action":"x","needs":["s0","s1","s2","s3","s4"]}
]}`

export const DIAMOND = `{"name":"diamond","trigger":{"api":{}},"steps":[
  {"id":"top","action":"x"},
  {"id":"left","action":"x","needs":["top"]},
  {"id":"right","action":"x","needs":["top"]},
  {"id":"bottom","action":"x","needs":["left","right"]}
]}`

export const LONG_EDGE = `{"name":"long-edge","trigger":{"api":{}},"steps":[
  {"id":"start","action":"x"},
  {"id":"mid_a","action":"x","needs":["start"]},
  {"id":"mid_b","action":"x","needs":["mid_a"]},
  {"id":"end","action":"x","needs":["mid_b","start"]}
]}`

export const FINALIZERS = `{"name":"finalizers","trigger":{"api":{}},"steps":[
  {"id":"work","action":"x"},
  {"id":"branch_left","action":"x","needs":["work"]},
  {"id":"branch_right","action":"x","needs":["work"]},
  {"id":"close_ok","action":"x","needs":["branch_left","branch_right"],"trigger":"allDone"},
  {"id":"close_fail","action":"x","needs":["branch_left"],"trigger":"allDone"}
]}`

export const WAIT_CALLBACK = `{"name":"wait-callback","trigger":{"api":{}},"steps":[
  {"id":"begin","action":"x"},
  {"id":"wait_ack","action":"wait_signal","needs":["begin"],"await":{"signal":"ack","timeoutSec":60}},
  {"id":"cb_form","action":"x","needs":["begin"],"callback":{"signal":"form_done","timeoutSec":120}},
  {"id":"after","action":"x","needs":["wait_ack","cb_form"]}
]}`

/** 真实事故快处流程（official_accident_plugin/workflows/accident-response-cascade.json 等价转写）。 */
export const ACCIDENT_RESPONSE = `{"name":"accident-response-cascade","trigger":{"stream":{"match":{"status":"unacknowledged","event_type":"警情"},"seed":["eventId","eventType","occurredAt","priority","lat","lng","payload"]}},"steps":[
  {"id":"ack","action":"wait_signal","await":{"signal":"acknowledge","timeoutSec":3600}},
  {"id":"mark_ack","action":"update_event_status","needs":["ack"],"inputs":{"status":{"const":"acknowledged"},"eventId":{"from":"trigger.eventId"}},"when":{"field":"trigger.eventId","op":"present"}},
  {"id":"pick","action":"wait_signal","needs":["ack"],"await":{"signal":"route_selected","provides":[{"key":"waylineUuid","type":"string"},{"key":"dockSn","type":"string"},{"key":"projectUuid","type":"string"}],"interruptedBy":["ignore"]}},
  {"id":"dispatch","action":"dispatch_mission","needs":["pick"],"inputs":{"waylineUuid":{"from":"steps.pick.waylineUuid"},"dockSn":{"from":"steps.pick.dockSn"},"projectUuid":{"from":"steps.pick.projectUuid"}}},
  {"id":"mark_handling","action":"update_event_status","needs":["dispatch","mark_ack"],"inputs":{"status":{"const":"handling"},"eventId":{"from":"trigger.eventId"},"flightMissionId":{"from":"steps.dispatch.missionId"}},"when":{"field":"trigger.eventId","op":"present"}},
  {"id":"poll","action":"query_flight_task","needs":["dispatch"],"inputs":{"missionId":{"from":"steps.dispatch.missionId"},"untilStatusIn":{"const":[1,4,5,7,8]},"everySec":{"const":15}},"timeoutSec":1800},
  {"id":"close_ack_timeout","action":"update_event_status","needs":["ack"],"trigger":"allDone","inputs":{"status":{"const":"ack_timeout"},"eventId":{"from":"trigger.eventId"}},"when":{"and":[{"field":"trigger.eventId","op":"present"},{"field":"steps.ack.$state","op":"eq","value":"timedOut"}]}},
  {"id":"close_ignored","action":"update_event_status","needs":["pick","mark_ack"],"trigger":"allDone","inputs":{"status":{"const":"ignored"},"eventId":{"from":"trigger.eventId"}},"when":{"and":[{"field":"trigger.eventId","op":"present"},{"field":"steps.pick.$state","op":"eq","value":"interrupted"}]}},
  {"id":"mark_completed","action":"update_event_status","needs":["poll","mark_handling"],"inputs":{"status":{"const":"completed"},"eventId":{"from":"trigger.eventId"}},"when":{"and":[{"field":"trigger.eventId","op":"present"},{"field":"steps.poll.taskStatus","op":"in","value":[5]}]}},
  {"id":"mark_terminated","action":"update_event_status","needs":["poll","mark_handling"],"inputs":{"status":{"const":"terminated"},"eventId":{"from":"trigger.eventId"}},"when":{"and":[{"field":"trigger.eventId","op":"present"},{"field":"steps.poll.taskStatus","op":"in","value":[1,4,7,8]}]}},
  {"id":"close_error","action":"update_event_status","needs":["dispatch","poll","mark_handling"],"trigger":"allDone","inputs":{"status":{"const":"terminated"},"eventId":{"from":"trigger.eventId"}},"when":{"and":[{"field":"trigger.eventId","op":"present"},{"or":[{"field":"steps.dispatch.$state","op":"eq","value":"failed"},{"field":"steps.poll.$state","op":"eq","value":"failed"}]}]}}
]}`

/** 真实违停巡逻流程（official_illegal_parking/workflows/patrol-capture.json 等价转写）。 */
export const PARKING_PATROL = `{"name":"patrol-capture","trigger":{"bizNotify":{"subscriber":"es-patrol","seed":["taskUuid","projectUuid","dockSn","waylineUuid","occurredAt"],"params":{"recheck_delay_sec":{"as":"recheckDelaySec","type":"number","max":1800}}},"api":{"seed":["taskUuid","projectUuid","dockSn","waylineUuid","occurredAt","recheckDelaySec"]}},"steps":[
  {"id":"airborne","action":"query_flight_task","inputs":{"missionId":{"from":"trigger.taskUuid"},"untilStatusIn":{"const":[2,1,4,5,7,8]},"everySec":{"const":5}},"timeoutSec":900},
  {"id":"spawn","action":"spawn_agent","needs":["airborne"],"when":{"field":"steps.airborne.taskStatus","op":"eq","value":2},"inputs":{"taskUuid":{"from":"trigger.taskUuid"},"projectUuid":{"from":"trigger.projectUuid"},"dockSn":{"from":"trigger.dockSn"},"waylineUuid":{"from":"trigger.waylineUuid"},"flightId":{"from":"trigger.taskUuid"}},"timeoutSec":120,"maxAttempts":1},
  {"id":"phase1_done","action":"wait_signal","needs":["spawn"],"when":{"field":"steps.spawn.sessionId","op":"present"},"await":{"signal":"phase1_done","timeoutSec":2400,"provides":[{"key":"targetCount","type":"number"}],"interruptedBy":["abort"]}},
  {"id":"recheck_gate","action":"wait_signal","needs":["phase1_done"],"await":{"signal":"recheck_start","timeoutSecFrom":"trigger.recheckDelaySec","interruptedBy":["abort"]}},
  {"id":"phase2_done","action":"wait_signal","needs":["recheck_gate"],"trigger":"allDone","when":{"field":"steps.recheck_gate.$state","op":"in","value":["timedOut","succeeded"]},"await":{"signal":"session_done","timeoutSec":2400,"provides":[{"key":"completedCount","type":"number"},{"key":"failedCount","type":"number"}],"interruptedBy":["abort"]}},
  {"id":"cancel_gate","action":"wait_signal","needs":["phase2_done"],"trigger":"allDone","when":{"field":"steps.spawn.sessionId","op":"present"},"await":{"signal":"cancel_return","timeoutSec":30,"interruptedBy":["return_now","abort"]}},
  {"id":"go_home","action":"return_home","needs":["cancel_gate"],"trigger":"allDone","when":{"field":"steps.cancel_gate.$state","op":"in","value":["timedOut","interrupted"]},"inputs":{"sessionId":{"from":"steps.spawn.sessionId"},"flightId":{"from":"trigger.taskUuid"},"dockSn":{"from":"trigger.dockSn"}},"timeoutSec":60},
  {"id":"poll_landed","action":"query_flight_task","needs":["go_home"],"inputs":{"missionId":{"from":"trigger.taskUuid"},"untilStatusIn":{"const":[1,4,5,7,8]},"everySec":{"const":15}},"timeoutSec":1800},
  {"id":"mark_done","action":"update_event_status","needs":["poll_landed"],"when":{"field":"trigger.eventId","op":"present"},"inputs":{"status":{"const":"completed"},"eventId":{"from":"trigger.eventId"},"flightMissionId":{"from":"trigger.taskUuid"}}},
  {"id":"close_error","action":"update_event_status","needs":["airborne","spawn","phase1_done","recheck_gate","phase2_done","go_home","poll_landed","mark_done"],"trigger":"allDone","when":{"and":[{"field":"trigger.eventId","op":"present"},{"field":"steps.mark_done.eventStatus","op":"blank"}]},"inputs":{"status":{"const":"terminated"},"eventId":{"from":"trigger.eventId"},"flightMissionId":{"from":"trigger.taskUuid"}}}
]}`

/** 手写配置中的环：a→b→c→a 三点互指（graph 层保留三条边，路由走 invalid gutter）。 */
export const INVALID_CYCLE = `{"name":"invalid-cycle","trigger":{"api":{}},"steps":[
  {"id":"a","action":"x","needs":["c"]},
  {"id":"b","action":"x","needs":["a"],"when":{"field":"trigger.x","op":"present"},"callback":{"signal":"c","timeoutSec":5}},
  {"id":"c","action":"x","needs":["b"],"trigger":"allDone","await":{"signal":"s","timeoutSec":10}}
]}`

/** 有向环：needs 两点互指（graph 层保留两条边，路由走 invalid gutter）。 */
export const CYCLE_MUTUAL = `{"name":"cycle-mutual","trigger":{"api":{}},"steps":[
  {"id":"a","action":"x","needs":["b"]},
  {"id":"b","action":"x","needs":["a"]},
  {"id":"leaf","action":"x","needs":["b"]}
]}`

/** 30+ 节点 / 60+ 边的合成大图（确定性生成）。 */
export function largeGraph (tiers = 7, perTier = 5): WorkflowGraph {
  const steps: string[] = []
  for (let t = 0; t < tiers; t += 1) {
    for (let i = 0; i < perTier; i += 1) {
      steps.push(`{"id":"n${t}_${i}","action":"x"${t === 0 ? '' : `,"needs":["n${t - 1}_${i}"]`}}`)
    }
  }
  // 层间交叉连线，把边数推过 60
  for (let t = 1; t < tiers; t += 1) {
    for (let i = 0; i < perTier; i += 1) {
      steps.push(`{"id":"x${t}_${i}","action":"x","needs":["n${t}_${i}","n${t - 1}_${(i + 1) % perTier}"]}`)
    }
  }
  const graph = graphOf(`{"name":"large","trigger":{"api":{}},"steps":[${steps.join(',')}]}`)
  if (graph.nodes.length < 30) throw new Error('large fixture 节点数不足 30')
  if (graph.edges.length < 60) throw new Error(`large fixture 边数不足 60（实际 ${graph.edges.length}）`)
  return graph
}

/** 正式 fixture 集合（invalid 除外）都必须 fallback = 0（Plan §4.6/§8.2）。 */
export const VALID_FIXTURES: ReadonlyArray<readonly [string, WorkflowGraph]> = [
  ['linear', graphOf(LINEAR)],
  ['fan-out', graphOf(FAN_OUT)],
  ['fan-in', graphOf(FAN_IN)],
  ['diamond', graphOf(DIAMOND)],
  ['long-edge', graphOf(LONG_EDGE)],
  ['finalizers', graphOf(FINALIZERS)],
  ['wait-callback', graphOf(WAIT_CALLBACK)],
  ['accident-response', graphOf(ACCIDENT_RESPONSE)],
  ['parking-patrol', graphOf(PARKING_PATROL)],
  ['large', largeGraph()],
]
