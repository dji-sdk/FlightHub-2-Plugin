// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readme = join(dirname(fileURLToPath(import.meta.url)), 'README.md')

test('公开分发的 README 保持中文与既定结构', async () => {
  const text = await readFile(readme, 'utf8')
  assert.match(text, /^# FH2 插件开发工具包/m)
  for (const heading of ['## 第一次跑起来', '## 建一个插件', '## 包里有什么', '## 本地界面', '## 版本与升级', '## 继续读']) {
    assert.ok(text.includes(heading), `缺少章节：${heading}`)
  }
  for (const marker of ['**许可**', 'corepack enable', 'UPLOAD_READY']) {
    assert.ok(text.includes(marker), `缺少内容：${marker}`)
  }
  // 回归防线：这份文件曾是英文版，导出时会原样冻结进公开树。
  assert.ok(!/^This curated source distribution/m.test(text), 'README 又变回英文版了')
  assert.ok((text.match(/[\u4E00-\u9FFF]/g) ?? []).length > 200, '中文内容过少，可能被替换成英文')
  assert.ok(text.split('\n').length <= 200, 'README 超过 200 行，请先删减再改')
})

test('公开树里出现英文版 README 时校验直接失败', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { assertPublicReadme } = await import('./check.mjs')
  const dir = await mkdtemp(join(tmpdir(), 'fh2-public-readme-'))
  await writeFile(join(dir, 'README.md'), '# FH2 Plugin Development Toolkit\n\nThis curated source distribution contains...\n')
  assert.throws(() => assertPublicReadme(dir), error => error.code === 'FH2_SOURCE_README_LANGUAGE')
})
