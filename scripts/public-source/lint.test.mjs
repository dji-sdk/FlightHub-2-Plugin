// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'

const root = fileURLToPath(new URL('../../', import.meta.url))
const eslint = new ESLint({ cwd: root, fix: true })

test('公开源码 Node 测试的导入在 lint --fix 后仍使用 node:test', async () => {
  for (const name of ['readme.test.mjs', 'lint.test.mjs']) {
    const filePath = join(root, 'scripts/public-source', name)
    const source = await readFile(filePath, 'utf8')
    assert.match(source, /^import test from 'node:test'/m, name)
    // 使用 CLI --fix 相同的修复器，但不调用 outputFixes、不写回任何源码。
    const [result] = await eslint.lintText(source, { filePath })
    const fixed = result.output ?? source
    assert.equal(result.errorCount, 0, JSON.stringify(result.messages))
    assert.match(fixed, /^import test from 'node:test'/m, name)
    assert.doesNotMatch(fixed, /^import .* from ['"]vitest['"]/m, name)
  }
})

test('node:test 例外仅作用于指定导入，不关闭其他测试的转换规则', async () => {
  for (const path of [
    'scripts/public-source/readme.test.mjs',
    'packages/fh2-plugin-toolchain/src/create/lint-regression.test.ts',
  ]) {
    const config = await eslint.calculateConfigForFile(join(root, path))
    assert.equal(config.rules['test/no-import-node-test'][0], 2, path)
  }
  const source = 'import test from \'node:test\'\ntest(\'回归\', () => {})\n'
  const [result] = await eslint.lintText(source, {
    filePath: join(root, 'packages/fh2-plugin-toolchain/src/create/lint-regression.test.ts'),
  })
  assert.match(result.output ?? source, /^import .* from ['"]vitest['"]/m)
})
