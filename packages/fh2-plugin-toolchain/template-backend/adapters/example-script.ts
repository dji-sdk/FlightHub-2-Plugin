// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// adapters/example-script.ts —— Workflow Adapter 入口:流程 JSON 里 run_script 步的执行体。
//
// ★ 运行形态(与 Handler 的三处关键差别):
//   · 触发方:不是 HTTP 调用,而是 workflows/example-flow.json 里的那一步;
//   · 重试语义:⚠️⚠️ 平台工作流引擎会重试这一步 —— 出参整份进入流程执行历史且无法删除,
//     于是【幂等必须在这里再次成立】(本例靠 record_key 唯一键,重跑回 created=false);
//   · 注入面:workflowAdapter 世界(types/adapter.d.ts),与 Handler 世界不同
//     (objectTrack / video 只在这边;media / data / flow / notify 三路都有)。
//
// ★ 入参从哪来:流程 JSON 那一步的 inputs 显式接线( {"from":"trigger.record_key"} ),
//   平台解好放进 input;【没有接线就没有这个键】 —— 没写就是没接上,不是"默认有"。
//   能接什么、必须接什么,由 plugin.json 里 scripts[].io 声明(本脚本:record_key/title
//   必填,出参 id/created) —— 流程 JSON 接了 io 之外的键、或漏接必填键,发布门禁当场红。
//
// ★ 回什么:返回值经平台投影,【只有 io.outputs 声明过的键】能进
//   steps.<步id>.* 供下游接线 —— 没声明的键到不了下游,这是防止 history 膨胀的闸。
import { createRecord } from '../shared/records'
import type { RecordInput } from '../shared/records'
import type { AdapterCtx } from 'fh2-plugin-sdk/backend'

export function handle (input: RecordInput, _ctx: AdapterCtx): {
  readonly id: string
  readonly created: boolean
} {
  const result = createRecord(input, 'workflow')
  // id 供流程下一步接线({"from": "steps.create-record.id"});
  // created 让下游能判"这一步是新建还是幂等命中"(见 example-flow.json 第二步)。
  return { id: result.record_key, created: result.created }
}
