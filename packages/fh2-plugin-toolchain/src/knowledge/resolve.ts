// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 项目锁 → 本地安装的知识包，以及从那份知识包读出平台 Catalog。
 *
 * ★★ 本模块是整条消费链上**唯一**决定「这次编辑用哪份知识」的地方。
 * 它有两种结果，界面必须能区分：
 *   ① 解析成功 → Catalog 来自知识包，与 worker 某个 revision 绑定
 *   ② 解析失败/未固定 → 调用方回退到内建手抄快照，且 `source.kind` 必须说出来
 *
 * ⚠️ 回退**不是**降级容错，是显式状态。把两种来源显示成一个样子，就等于把
 * 「可能已过期的手抄」冒充成事实 —— 那正是本方案要消灭的失败模式。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  InstalledKnowledge,
  KnowledgeAction,
  KnowledgeContents,
  KnowledgeHostApi,
  KnowledgeLanguage,
  KnowledgeStatus,
  KnowledgeTriggerAxis,
  PlatformCatalog,
} from '../contracts/knowledge.js'
import { findInstalled, listInstalled } from './install.js'
import { KnowledgeLockError, readLock } from './lock.js'

/** 解析结果。`problems` 非空时 `knowledge` 必为 undefined —— 半通过状态不存在。 */
export interface ResolvedKnowledge {
  readonly knowledge?: InstalledKnowledge;
  readonly locked: boolean;
  readonly problems: readonly string[];
}

/**
 * 按项目锁解析出要用的那份知识包。
 *
 * 三种「用不上」的情形各有各的话要说，不合并成一句「知识不可用」：
 * 用户要能据此知道下一步是 `knowledge import` 还是 `knowledge use`。
 */
export async function resolveProjectKnowledge (projectRoot: string): Promise<ResolvedKnowledge> {
  let lock
  try {
    lock = readLock(projectRoot)
  } catch (error) {
    if (error instanceof KnowledgeLockError) return { locked: true, problems: [error.message] }
    throw error
  }
  if (lock === undefined) {
    return {
      locked: false,
      problems: [],
    }
  }

  const installed = await findInstalled(lock.knowledgeId)
  if (installed === undefined) {
    const available = (await listInstalled()).map(item => item.knowledgeId)
    return {
      locked: true,
      problems: [
        `项目固定了知识 ${lock.knowledgeId}，但本机缓存里没有它。${
          available.length === 0
            ? '先用 `fh2-plugin knowledge import <知识包目录>` 安装。'
            : `已安装的是：${available.join(' / ')}。`}`,
      ],
    }
  }
  if (installed.bundleDigest !== lock.bundleDigest) {
    return {
      locked: true,
      problems: [
        `知识 ${lock.knowledgeId} 的内容与项目锁不符：\n`
        + `  锁要求 ${lock.bundleDigest}\n`
        + `  已装是 ${installed.bundleDigest}\n`
        + '  同一个 ID 对应了两份内容（其中至少一份出自脏工作区）。重新 import 正确的那份，或用 `knowledge use` 改锁。',
      ],
    }
  }
  return { knowledge: installed, locked: true, problems: [] }
}

function readJson (directory: string, path: string): unknown {
  const file = join(directory, path)
  if (!existsSync(file)) throw new Error(`知识包缺少 ${path}`)
  return JSON.parse(readFileSync(file, 'utf8')) as unknown
}

/**
 * 从知识包读出平台 Catalog。
 *
 * ⚠️ 这里**不做形状兜底**：读不出来就抛。知识包是安装期逐文件对过摘要的，
 * 到这一步 catalog 缺字段只有一种解释 —— 生产侧口径变了而消费侧没跟上。
 * 那种情况下「兜底成空数组」的表现是画布静默少一批节点，比报错坏得多。
 */
export function loadPlatformCatalog (knowledge: InstalledKnowledge): PlatformCatalog {
  const actions = readJson(knowledge.directory, 'catalog/actions.json')
  const triggers = readJson(knowledge.directory, 'catalog/triggers.json')
  const language = readJson(knowledge.directory, 'catalog/language.json')
  const hostApi = readJson(knowledge.directory, 'catalog/host-api.json')

  if (!Array.isArray(actions) || actions.length === 0) throw new Error('catalog/actions.json 不是非空数组')
  if (!Array.isArray(triggers) || triggers.length === 0) throw new Error('catalog/triggers.json 不是非空数组')
  if (typeof language !== 'object' || language === null) throw new Error('catalog/language.json 不是对象')
  if (typeof hostApi !== 'object' || hostApi === null) throw new Error('catalog/host-api.json 不是对象')

  return {
    actions: actions as KnowledgeAction[],
    triggers: triggers as KnowledgeTriggerAxis[],
    language: language as KnowledgeLanguage,
    hostApi: hostApi as KnowledgeHostApi,
    source: { kind: 'knowledge', revision: knowledge.knowledgeId },
  }
}

/** 从知识包读一份 Schema 的原文（`GET /api/schemas` 用）。 */
export function readKnowledgeSchema (knowledge: InstalledKnowledge, name: 'plugin' | 'workflow'): string | undefined {
  const file = join(knowledge.directory, 'schemas', `${name}.schema.json`)
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

/** 按前缀归类载荷清单，给界面说明「这份知识带了什么」。 */
export function describeContents (knowledge: InstalledKnowledge): KnowledgeContents {
  const paths = knowledge.manifest.files.map(entry => entry.path)
  const under = (prefix: string): string[] => paths.filter(path => path.startsWith(prefix)).sort()
  return {
    docs: under('docs/'),
    catalogs: under('catalog/'),
    schemas: under('schemas/'),
    types: under('types/'),
    examples: under('examples/'),
    hasSkill: paths.some(path => path.startsWith('skill/')),
    hasProvenance: paths.includes('provenance.json'),
    hasVerification: paths.includes('verification.json'),
  }
}

/** 组装 `GET /api/knowledge` 的回包。 */
export async function resolveKnowledgeStatus (projectRoot: string): Promise<KnowledgeStatus> {
  const resolved = await resolveProjectKnowledge(projectRoot)
  const installed = (await listInstalled()).map(item => ({
    knowledgeId: item.knowledgeId,
    bundleDigest: item.bundleDigest,
    workerRevision: item.manifest.workerRevision,
    local: item.manifest.local === true,
  }))

  const problems = [...resolved.problems]
  let active: KnowledgeStatus['active']
  if (resolved.knowledge !== undefined) {
    try {
      active = {
        knowledgeId: resolved.knowledge.knowledgeId,
        bundleDigest: resolved.knowledge.bundleDigest,
        workerRevision: resolved.knowledge.manifest.workerRevision,
        contractsVersion: resolved.knowledge.manifest.contractsVersion,
        gojaVersion: resolved.knowledge.manifest.gojaVersion,
        local: resolved.knowledge.manifest.local === true,
        contents: describeContents(resolved.knowledge),
      }
      // 试着真读一遍 Catalog：装得上但 catalog 读不出来时，
      // 界面显示「已固定」而画布拿不到节点菜单，那种不一致最难查。
      loadPlatformCatalog(resolved.knowledge)
    } catch (error) {
      active = undefined
      problems.push(`知识 ${resolved.knowledge.knowledgeId} 装上了但 Catalog 读不出来：${(error as Error).message}`)
    }
  }

  return {
    ...(active === undefined ? {} : { active }),
    installed,
    locked: resolved.locked,
    // 本轮没有任何平台的 checker 制品（计划 §1.2）。这个 false 是硬编码的事实，
    // 不是「还没查到」：knowledge.json 的 checkers 恒为空数组。
    checkerAvailable: false,
    problems,
  }
}
