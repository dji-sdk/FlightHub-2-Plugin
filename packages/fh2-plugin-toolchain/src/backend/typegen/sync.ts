// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generatePluginTypes } from './plugin-types.js'

/** 仅清理由本命令拥有的固定产物，绝不删除作者自行放入 types/ 的文件。 */
export const GENERATED_BACKEND_TYPE_FILES = new Set([
  'entities.d.ts',
  'storage.ts',
  'shared-all.d.ts',
  'shared-call.d.ts',
  'shared-adapter.d.ts',
  'call.d.ts',
  'handler.d.ts',
  'event.d.ts',
  'adapter.d.ts',
])

/** 将当前 Host Contract、allowlist 与源码世界同步到 types/。 */
export function syncPluginTypes (pluginRoot: string): ReturnType<typeof generatePluginTypes> {
  const result = generatePluginTypes(pluginRoot)
  const typesDir = join(pluginRoot, 'types')
  mkdirSync(typesDir, { recursive: true })
  for (const [file, source] of result.files) {
    writeFileSync(join(typesDir, file), source, 'utf8')
  }
  for (const file of GENERATED_BACKEND_TYPE_FILES) {
    if (result.files.has(file)) continue
    rmSync(join(typesDir, file), { force: true })
  }
  return result
}
