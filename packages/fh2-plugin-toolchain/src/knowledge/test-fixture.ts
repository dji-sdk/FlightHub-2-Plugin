// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 测试用知识包生成器：造一份**结构与真包同形**的最小知识包。
 *
 * ★ 为什么不直接指向 worker 仓的产物：那要求跑测试的机器上有 worker 仓并先构建，
 * 单测不能有这种前置。真包的兼容性由单独一条「对真包跑一遍」的用例守（见 knowledge-catalog.test.ts），
 * 它在真包缺失时跳过而不是失败。
 *
 * ⚠️ 这里的 catalog 内容必须覆盖那几个**有语义分支**的取值：
 * retry 三档、ioResolution 三档、always=false 的出参、seedNotGuaranteed。
 * 少一个分支，适配层的对应那行代码就没有测试。
 */

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface FixtureOptions {
  readonly knowledgeId?: string;
  /** 额外塞一个动作，用来造出「同 id 不同内容」。 */
  readonly extraAction?: string;
  /** 往 files[] 里注入一条非法路径条目（只改清单，不建文件）。 */
  readonly injectFileEntry?: string;
  /** 让 knowledge.json 声明 checkers 非空（默认空数组）。 */
  readonly withChecker?: boolean;
  readonly local?: boolean;
}

export interface FixturePackage {
  readonly directory: string;
  readonly knowledgeId: string;
}

/** 与真包同形的 catalog/actions.json 内容。 */
export function fixtureActions (extraAction?: string): unknown[] {
  const actions: unknown[] = [
    {
      name: 'dispatch_mission',
      owner: 'platform',
      capability: 'device.mission:execute',
      kind: 'activity',
      isFlight: true,
      retry: 'none',
      heartbeating: false,
      ioResolution: 'catalog',
      inputs: [
        { name: 'waylineUuid', type: 'id', required: true, always: true },
        { name: 'lat', type: 'number', always: true },
      ],
      outputs: [
        { name: 'missionId', type: 'id', always: true },
        { name: 'allowed', type: 'bool', always: true },
      ],
      notes: ['下发飞行意图（过 Guard）'],
    },
    {
      name: 'query_flight_task',
      owner: 'platform',
      capability: 'flight_task.detail:read',
      kind: 'activity',
      retry: 'default',
      heartbeating: true,
      ioResolution: 'catalog',
      inputs: [{ name: 'missionId', type: 'id', required: true, always: true }],
      outputs: [
        { name: 'taskStatus', type: 'number', always: true },
        // 只在轮询超时那一次产出 —— 适配层要把它翻成 from:'dynamic'。
        { name: 'pollTimedOut', type: 'bool', always: false },
      ],
    },
    {
      name: 'wait_signal',
      owner: 'platform',
      kind: 'await_signal',
      // 不跑 activity，重试语义不适用 —— 绝不能被翻成 nonIdempotent。
      retry: 'not-applicable',
      heartbeating: false,
      ioResolution: 'await-provides',
    },
    {
      name: 'run_script',
      owner: 'platform',
      kind: 'activity',
      retry: 'default',
      heartbeating: false,
      // I/O 由脚本契约决定 —— 适配层要把它从节点菜单里排除。
      ioResolution: 'script-contract',
      inputs: [{ name: 'script', type: 'string', required: true, always: true }],
    },
  ]
  if (extraAction !== undefined) {
    actions.push({
      name: extraAction,
      owner: 'platform',
      kind: 'activity',
      retry: 'default',
      ioResolution: 'catalog',
      inputs: [],
      outputs: [],
    })
  }
  return actions
}

export function fixtureTriggers (): unknown[] {
  return [
    { name: 'api', summary: 'API 触发', seedKeysOpen: true, seedGuarantee: '作者声明' },
    { name: 'schedule', summary: '定时触发', seedKeys: ['intervalSec'], seedGuarantee: '平台保证' },
    {
      name: 'stream',
      summary: '事件消息触发',
      seedKeys: ['eventId', 'lat', 'lng'],
      seedNotGuaranteed: ['lat', 'lng'],
      matchFields: ['event_id', 'event_type'],
      seedGuarantee: '平台保证形状，但声明了也可能不播',
    },
    {
      name: 'bizNotify',
      summary: '业务通知触发',
      seedKeys: ['taskUuid', 'dockSn'],
      seedNotGuaranteed: ['dockSn'],
      seedKeysOpen: true,
      seedGuarantee: '固定键由平台投影',
    },
    { name: 'job', summary: '插件自己启动', seedKeysOpen: true, seedGuarantee: '插件自己保证' },
  ]
}

export function fixtureLanguage (): Record<string, unknown> {
  return {
    refRoots: [
      { name: 'trigger', syntax: 'trigger.<深路径>', closed: false, summary: '启动时那份事实' },
      { name: 'steps', syntax: 'steps.<id>.<深路径>', closed: true, summary: '前序步骤出参' },
      { name: 'run', syntax: 'run.<键>', closed: true, summary: '解释器种子' },
    ],
    stepStates: ['failed', 'interrupted', 'skipped', 'succeeded', 'timedOut'],
    stateKey: '$state',
    stepKinds: ['activity', 'await_signal'],
    triggerModes: ['allSucceeded', 'allDone'],
    conditionOps: ['blank', 'eq', 'exists', 'in', 'ne', 'present'],
    providedTypes: ['string', 'number', 'bool', 'object', 'array'],
    extraKeysModes: ['reject', 'allow'],
    maxRefDepth: 16,
    pluginActionPrefix: 'plugin.',
    runRoot: [
      { name: 'now', type: 'string', always: true },
      { name: 'idempotencyKey', type: 'string', always: true },
      { name: 'intervalSec', type: 'number', always: true },
    ],
    stepPolicy: { defaultTimeoutSec: 30, defaultMaxAttempts: 5 },
  }
}

export function fixtureHostApi (): Record<string, unknown> {
  return {
    grantableCapabilities: ['cache:read', 'data:read', 'egress:fetch', 'log:write'],
    methods: [
      {
        path: 'connector.fetch',
        summary: '受管出口发一次 HTTP',
        authorization: { mode: 'anyOf', capabilities: ['egress:fetch'] },
        signatureStatus: 'documented',
        returns: { type: 'object', errorMode: 'throw' },
      },
    ],
    cache: { readCapability: 'cache:read', writeCapability: 'cache:write', readMethods: ['get'], writeMethods: ['set'] },
  }
}

/** 造一份知识包目录，knowledge.json 的 files[] 与实际内容严格一致。 */
export async function buildKnowledgePackage (options: FixtureOptions = {}): Promise<FixturePackage> {
  const knowledgeId = options.knowledgeId ?? 'bpk-test'
  const directory = await mkdtemp(join(tmpdir(), 'fh2-kb-src-'))

  const payload = new Map<string, string>([
    ['catalog/actions.json', `${JSON.stringify(fixtureActions(options.extraAction), null, 2)}\n`],
    ['catalog/triggers.json', `${JSON.stringify(fixtureTriggers(), null, 2)}\n`],
    ['catalog/language.json', `${JSON.stringify(fixtureLanguage(), null, 2)}\n`],
    ['catalog/host-api.json', `${JSON.stringify(fixtureHostApi(), null, 2)}\n`],
    ['schemas/plugin.schema.json', '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}\n'],
    ['schemas/workflow.schema.json', '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}\n'],
    ['docs/index.md', '# 测试知识包\n'],
    ['types/workflow-script.d.ts', 'export {}\n'],
    ['skill/SKILL.md', '# skill\n'],
    ['provenance.json', '{"entries":[]}\n'],
    ['verification.json', '{"gates":[]}\n'],
  ])

  const files: { path: string; sha256: string; bytes: number }[] = []
  for (const [path, content] of payload) {
    const absolute = join(directory, path)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content, 'utf8')
    const bytes = Buffer.byteLength(content, 'utf8')
    files.push({ path, sha256: createHash('sha256').update(content).digest('hex'), bytes })
  }
  if (options.injectFileEntry !== undefined) {
    files.push({ path: options.injectFileEntry, sha256: '0'.repeat(64), bytes: 1 })
  }
  files.sort((left, right) => left.path.localeCompare(right.path))

  const manifest = {
    formatVersion: 1,
    knowledgeId,
    workerRevision: '0'.repeat(40),
    ...(options.local === true ? { local: true } : {}),
    contractsVersion: '1.1.0',
    gojaVersion: 'v0.0.0-test',
    toolchainProtocolVersion: 1,
    files,
    checkers: options.withChecker === true
      ? [{
          target: 'darwin-arm64',
          archive: 'checker.tar.gz',
          archiveSha256: '0'.repeat(64),
          binarySha256: '0'.repeat(64),
          protocolVersion: 1,
        }]
      : [],
  }
  await writeFile(join(directory, 'knowledge.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { directory, knowledgeId }
}
