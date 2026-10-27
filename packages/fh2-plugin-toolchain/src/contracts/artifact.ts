// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * Artifact 契约（实施计划 §3.4 / 演进计划 §3.3.2）。
 *
 * - 产物使用不可变副本/内容摘要定位，下载按 taskId/artifactId 经鉴权和路径检查读取，
 *   不直接读取随后会被覆盖的 `dist`；
 * - `typechecked` 记录是否执行并通过 Typecheck；
 * - `stale = finalRevision !== initialRevision`，失败/取消任务也保留 revision。
 */
export type ArtifactKind = 'frontend-dist' | 'backend-dist' | 'generated-types' | 'capability-package'

export const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  'frontend-dist',
  'backend-dist',
  'generated-types',
  'capability-package',
]

export interface ArtifactDescriptor {
  readonly id: string;
  readonly kind: ArtifactKind;
  /** 不可变副本路径（工作区相对）或下载端点路径；不指向可被下次构建覆盖的 dist 目录。 */
  readonly path: string;
  /** sha-256 内容摘要 hex。 */
  readonly digest: string;
  readonly size: number;
  readonly sourceRevision: string;
  readonly typechecked: boolean;
  readonly stale: boolean;
}

/** 严格解析回包/事件中的 ArtifactDescriptor。 */
export function parseArtifactDescriptor (value: unknown): ArtifactDescriptor | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id === '') return null
  if (!(ARTIFACT_KINDS as readonly string[]).includes(record.kind as string)) return null
  if (typeof record.path !== 'string' || record.path === '') return null
  if (typeof record.digest !== 'string' || record.digest === '') return null
  if (typeof record.size !== 'number' || !Number.isInteger(record.size) || record.size < 0) return null
  if (typeof record.sourceRevision !== 'string' || record.sourceRevision === '') return null
  if (typeof record.typechecked !== 'boolean') return null
  if (typeof record.stale !== 'boolean') return null
  return {
    id: record.id,
    kind: record.kind as ArtifactKind,
    path: record.path,
    digest: record.digest,
    size: record.size,
    sourceRevision: record.sourceRevision,
    typechecked: record.typechecked,
    stale: record.stale,
  }
}
