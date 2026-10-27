// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computeSourceRevision } from './source-revision.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('computeSourceRevision（S5）', () => {
  it('源码内容变化 → hash 变化', async () => {
    const root = await createProjectRoot()
    await writeFile(join(root, 'src/main.ts'), 'export const value = 1\n')
    const before = computeSourceRevision(root)

    await writeFile(join(root, 'src/main.ts'), 'export const value = 2\n')
    const after = computeSourceRevision(root)

    expect(after).not.toBe(before)
  })

  it('写 build report / 构建缓存 / dist 不改变 hash', async () => {
    const root = await createProjectRoot()
    await writeFile(join(root, 'src/main.ts'), 'export const value = 1\n')
    const before = computeSourceRevision(root)

    await mkdir(join(root, '.fh2'), { recursive: true })
    await writeFile(join(root, '.fh2/build-report.json'), '{"capabilityId":"x"}')
    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(join(root, 'dist/bundle.js'), 'built output')
    await mkdir(join(root, '.dist.fh2-next-abc'), { recursive: true })
    await writeFile(join(root, '.dist.fh2-next-abc/bundle.js'), 'candidate')

    expect(computeSourceRevision(root)).toBe(before)
  })

  it('node_modules 与 .git 不计入，项目自有 .d.ts 属于源码输入', async () => {
    const root = await createProjectRoot()
    await writeFile(join(root, 'src/main.ts'), 'export const value = 1\n')
    await writeFile(join(root, 'src/shims.d.ts'), 'declare module "*.vue"\n')
    const before = computeSourceRevision(root)

    await mkdir(join(root, 'node_modules/pkg'), { recursive: true })
    await writeFile(join(root, 'node_modules/pkg/index.js'), 'ignored')
    await mkdir(join(root, '.git'), { recursive: true })
    await writeFile(join(root, '.git/HEAD'), 'ref: refs/heads/main')

    expect(computeSourceRevision(root)).toBe(before)

    await writeFile(join(root, 'src/shims.d.ts'), 'declare module "*.vue"\ndeclare module "*.css"\n')
    expect(computeSourceRevision(root)).not.toBe(before)
  })
})

async function createProjectRoot (): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-source-revision-'))
  roots.push(root)
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({ id: 'exp_revision' }))
  return root
}
