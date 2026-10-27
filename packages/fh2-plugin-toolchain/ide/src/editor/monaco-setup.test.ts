// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import * as monaco from 'monaco-editor'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SchemaEntry } from '../api/types.js'
import { __resetJsonSchemaDefenseForTest, applyJsonSchemas, reassertJsonSchemasOnLanguageActivation } from './monaco-setup.js'

/**
 * DAG-013-01 结构性防御的行为契约：json worker 创建时快照配置，配置更新
 * 依赖 setDiagnosticsOptions 触发的重建链。防御 = apply 之后延迟重申 +
 * json 语言激活时重申，保证任何时序下最新配置都能到达 worker。
 */
describe('applyJsonSchemas 的时序防御（DAG-013-01）', () => {
  let setOptions: ReturnType<typeof vi.fn>
  let languageListeners: Array<() => void>

  beforeEach(() => {
    __resetJsonSchemaDefenseForTest()
    setOptions = vi.fn()
    languageListeners = []
    // 测试环境把 monaco-editor alias 到纯 core（editor.api.js，无语言 contributions）：
    // jsonDefaults / onLanguage 由这里注入/替换桩，产品代码路径保持真实。
    const languages = monaco.languages as unknown as Record<string, unknown>
    const originalJson = languages.json
    const originalOnLanguage = languages.onLanguage
    languages.json = { jsonDefaults: { setDiagnosticsOptions: setOptions } }
    languages.onLanguage = (languageId: string, callback: () => void) => {
      if (languageId === 'json') languageListeners.push(callback)
      return { dispose: () => undefined }
    }
    return () => {
      if (originalJson === undefined) delete languages.json
      else languages.json = originalJson
      languages.onLanguage = originalOnLanguage
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const entry: SchemaEntry = {
    uri: 'fh2://schema/backend-plugin',
    fileMatch: ['/abs/root/fh2-plugin.json'],
    schema: { type: 'object' },
  }

  it('apply 立即设置配置，并在 1s 后重申相同配置（幂等触发 worker 重建链）', async () => {
    vi.useFakeTimers()
    applyJsonSchemas([entry])
    expect(setOptions).toHaveBeenCalledTimes(1)
    expect(setOptions).toHaveBeenLastCalledWith(expect.objectContaining({
      validate: true,
      schemaValidation: 'error',
      schemas: [expect.objectContaining({ uri: 'fh2://schema/backend-plugin', fileMatch: ['/abs/root/fh2-plugin.json'] })],
    }))
    // 1s 后用同一份配置重申：worker 快照竞态的兜底
    vi.advanceTimersByTime(1000)
    expect(setOptions).toHaveBeenCalledTimes(2)
    expect(setOptions).toHaveBeenNthCalledWith(2, setOptions.mock.calls[0]![0])
  })

  it('连续 apply 只排一次重申（不随调用次数放大）', async () => {
    vi.useFakeTimers()
    applyJsonSchemas([entry])
    applyJsonSchemas([entry])
    expect(setOptions).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1000)
    expect(setOptions).toHaveBeenCalledTimes(3)
  })

  it('json 语言激活时重申已应用的配置（onLanguage 消费者就位前的 fire 不再丢失）', async () => {
    reassertJsonSchemasOnLanguageActivation()
    expect(languageListeners).toHaveLength(1)
    // 先 apply（此时 jsonMode/消费者可能尚未加载）再触发语言激活
    applyJsonSchemas([entry])
    expect(setOptions).toHaveBeenCalledTimes(1)
    languageListeners[0]!()
    expect(setOptions).toHaveBeenCalledTimes(2)
    expect(setOptions).toHaveBeenLastCalledWith(expect.objectContaining({
      schemas: [expect.objectContaining({ uri: 'fh2://schema/backend-plugin' })],
    }))
  })

  it('从未 apply 过时语言激活不重申（掩盖根因比缺配置更糟）', async () => {
    reassertJsonSchemasOnLanguageActivation()
    languageListeners[0]!()
    expect(setOptions).not.toHaveBeenCalled()
  })
})
