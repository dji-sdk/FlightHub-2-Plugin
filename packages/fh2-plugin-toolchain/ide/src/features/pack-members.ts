// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { WorkspaceKind } from '../api/types.js'

/**
 * U2 打包范围：从文件树路径推导可打包成员（纯函数，供 runPack 弹窗使用）。
 *
 * 口径与服务端 discovery 一致：成员 = 含 fh2-plugin.json 的目录，id 取目录名。
 * - capability-project：frontend/<id>/fh2-plugin.json 与 backend/<id>/fh2-plugin.json；
 * - industry-capability-workspace：<capabilityId>/frontend/<id>/… 与 <capabilityId>/backend/<id>/…
 *   （限定 id 形如 `<capId>` 或 `<capId>/<memberId>`）。
 * dist/node_modules 等生成目录不出现在树数据（readWorkspaceTree 过滤），推导不受污染。
 */

/**
 * 成员树节点：递归结构，叶子（children 为空数组）的 id 即提交给服务端的限定 id；
 * 分支节点（frontend/backend 侧别组、capability 节点）的 id 仅作展示 key，不参与提交。
 */
export interface PackMemberNode {
  /**
   * 叶子：限定 id（capability 根下为 `<memberId>`，行业工作区下为 `<capabilityId>/<memberId>`）。
   * 分支：展示 key（如 `frontend`、`<capabilityId>/frontend`）。
   */
  readonly id: string;
  readonly label: string;
  readonly children: readonly PackMemberNode[];
}

/**
 * 从工作区全部文件路径推导成员树。
 * 返回 null 表示推导不出任何成员（树为空或结构异常），调用方应回落全量。
 */
export function derivePackMembers (allFiles: readonly string[], kind: WorkspaceKind): readonly PackMemberNode[] | null {
  if (kind === 'capability-project') return deriveCapabilityMembers(allFiles)
  if (kind === 'industry-capability-workspace') return deriveWorkspaceMembers(allFiles)
  return null
}

/**
 * 收集成员树的全部叶子 id（可直接提交的限定 id 集合）。
 * 用于「全选 ⇄ 缺省全量」等价判断与树选项默认展开/勾选。
 */
export function collectPackMemberLeafIds (tree: readonly PackMemberNode[]): string[] {
  return tree.flatMap(node => node.children.length === 0 ? [node.id] : collectPackMemberLeafIds(node.children))
}

/** 每次打开范围选择时读取当前清单名称，仅补充展示文案，不改变成员 id。 */
export async function loadPackMemberNames (
  tree: readonly PackMemberNode[],
  readContent: (path: string) => Promise<string>,
): Promise<readonly PackMemberNode[]> {
  async function visit (node: PackMemberNode, parent?: PackMemberNode): Promise<PackMemberNode> {
    const isGroup = node.id.split('/').at(-1) === 'frontend' || node.id.split('/').at(-1) === 'backend'
    const path = node.children.length === 0 && parent !== undefined
      ? `${parent.id}/${node.id.split('/').at(-1)}/fh2-plugin.json`
      : isGroup ? undefined : `${node.id}/capabilities.json`
    let label = node.label
    if (path !== undefined) {
      try {
        const manifest: unknown = JSON.parse(await readContent(path))
        const name = manifest !== null && typeof manifest === 'object' && 'name' in manifest && typeof manifest.name === 'string' ? manifest.name.trim() : ''
        if (name !== '' && name !== node.label) label = `${name}（${node.label}）`
      } catch {
        // 名称缺失、清单损坏或读取失败时仍可按英文标识选择；校验由打包任务负责。
      }
    }
    return { ...node, label, children: await Promise.all(node.children.map(child => visit(child, node))) }
  }
  return Promise.all(tree.map(node => visit(node)))
}

const FRONTEND_GROUP_LABEL = '前端插件'
const BACKEND_GROUP_LABEL = '后端插件'

/**
 * 侧别分组节点：空侧返回 null（勾选树不出现「后端插件（0）」）。
 * idPrefix 用于行业工作区下保证分支 key 在树内唯一（叶子 id 不受影响）。
 */
function sideGroup (side: 'frontend' | 'backend', ids: readonly string[], idPrefix = ''): PackMemberNode | null {
  if (ids.length === 0) return null
  const label = side === 'frontend' ? FRONTEND_GROUP_LABEL : BACKEND_GROUP_LABEL
  const groupLabel = `${label}（${ids.length}）`
  return {
    id: idPrefix === '' ? side : `${idPrefix}/${side}`,
    label: groupLabel,
    children: ids.map(id => ({ id: idPrefix === '' ? id : `${idPrefix}/${id}`, label: id, children: [] })),
  }
}

function collectMemberDirs (allFiles: readonly string[]): Map<string, Set<string>> {
  /** 父目录 → 成员 id 集合（fh2-plugin.json 所在目录名）。 */
  const byParent = new Map<string, Set<string>>()
  for (const path of allFiles) {
    const segments = path.split('/')
    if (segments.at(-1) !== 'fh2-plugin.json' || segments.length < 2) continue
    const memberId = segments.at(-2)!
    const parent = segments.slice(0, -2).join('/')
    const bucket = byParent.get(parent) ?? new Set<string>()
    bucket.add(memberId)
    byParent.set(parent, bucket)
  }
  return byParent
}

function deriveCapabilityMembers (allFiles: readonly string[]): PackMemberNode[] | null {
  const byParent = collectMemberDirs(allFiles)
  const frontend = [...(byParent.get('frontend') ?? new Set<string>())].sort()
  const backend = [...(byParent.get('backend') ?? new Set<string>())].sort()
  if (frontend.length === 0 && backend.length === 0) return null
  return [sideGroup('frontend', frontend), sideGroup('backend', backend)].filter(node => node !== null)
}

function deriveWorkspaceMembers (allFiles: readonly string[]): PackMemberNode[] | null {
  const byParent = collectMemberDirs(allFiles)
  /** capabilityId → { frontend, backend } 成员 id 集合。 */
  const capabilities = new Map<string, { frontend: Set<string>; backend: Set<string> }>()
  for (const [parent, members] of byParent) {
    const segments = parent.split('/')
    // 期望形态：<capId>/frontend 或 <capId>/backend
    if (segments.length !== 2) continue
    const [capabilityId, side] = segments as [string, 'frontend' | 'backend']
    if (side !== 'frontend' && side !== 'backend') continue
    const entry = capabilities.get(capabilityId) ?? { frontend: new Set<string>(), backend: new Set<string>() }
    for (const id of members) entry[side].add(id)
    capabilities.set(capabilityId, entry)
  }
  if (capabilities.size === 0) return null
  return [...capabilities.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([capabilityId, entry]) => ({
      id: capabilityId,
      label: capabilityId,
      children: [
        // 叶子 id 带上 `<capId>/` 前缀（提交给服务端的限定 id）；空侧不产出分组节点
        sideGroup('frontend', [...entry.frontend].sort(), capabilityId),
        sideGroup('backend', [...entry.backend].sort(), capabilityId),
      ].filter(node => node !== null),
    }))
    .filter(node => node.children.length > 0)
}
