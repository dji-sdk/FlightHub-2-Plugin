// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import {
  addScriptEntry,
  defaultScriptPath,
  defaultScriptSource,
  findScriptEntry,
  parseManifest,
  serializeManifest,
  setScriptAllowlist,
  setScriptIo,
} from './script-manifest.js'
import type { ManifestDocument } from './script-manifest.js'

/**
 * 画布里「新建脚本」必须同时做到：建文件、登记清单、接到步骤。
 * 这组用例守的是中间那件事 —— 登记进 plugin.json 而**不破坏这份手写清单**。
 */

const SOURCE = `{
  "pluginId": "demo_backend",
  "name": "演示后端",
  "version": "0.1.0",
  "futureField": "平台还不认识这个字段",
  "scripts": [
    {
      "name": "existing",
      "path": "adapters/existing.js",
      "entry": "handle",
      "allowlist": ["track:read"],
      "io": {
        "inputs": [{ "name": "a", "type": "string", "required": true }],
        "outputs": [{ "name": "b", "type": "bool" }]
      }
    }
  ]
}
`

function load (text = SOURCE): ManifestDocument {
  const parsed = parseManifest(text, 'backend/plugin.json')
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.document
}

describe('parseManifest', () => {
  it('解析并判定可无损复现', () => {
    const document = load()
    expect(document.lossless).toBe(true)
    expect(serializeManifest(document)).toBe(SOURCE)
  })

  it('半截 JSON 回错而不是抛', () => {
    const parsed = parseManifest('{ "scripts": [', 'plugin.json')
    expect(parsed.ok).toBe(false)
  })

  it('顶层不是对象时回错', () => {
    expect(parseManifest('[]', 'plugin.json').ok).toBe(false)
  })
})

describe('addScriptEntry', () => {
  it('登记一份新脚本', () => {
    const document = load()
    const added = addScriptEntry(document, {
      name: 'fresh',
      path: 'adapters/fresh.js',
      entry: 'handle',
      allowlist: ['data:read'],
      inputs: [{ name: 'x', type: 'string', required: true }],
      outputs: [{ name: 'y', type: 'number' }],
    })
    expect(added).toBe(true)
    const entry = findScriptEntry(document, 'fresh')
    expect(entry).toMatchObject({ name: 'fresh', path: 'adapters/fresh.js', entry: 'handle' })
  })

  it('required 只在为 true 时写出（false 是噪音）', () => {
    const document = load()
    addScriptEntry(document, {
      name: 'fresh',
      path: 'a.js',
      entry: 'handle',
      allowlist: [],
      inputs: [{ name: 'opt', type: 'string' }],
      outputs: [],
    })
    const text = serializeManifest(document)
    expect(text).toContain('"opt"')
    expect(text).not.toContain('"required": false')
  })

  it('同名脚本拒绝登记（寻址键必须唯一）', () => {
    const document = load()
    const added = addScriptEntry(document, {
      name: 'existing',
      path: 'adapters/other.js',
      entry: 'handle',
      allowlist: [],
      inputs: [],
      outputs: [],
    })
    expect(added).toBe(false)
  })

  it('空名字或空路径拒绝', () => {
    const document = load()
    const base = { entry: 'handle', allowlist: [], inputs: [], outputs: [] } as const
    expect(addScriptEntry(document, { ...base, name: '  ', path: 'a.js' })).toBe(false)
    expect(addScriptEntry(document, { ...base, name: 'ok', path: '  ' })).toBe(false)
  })

  it('清单原本没有 scripts[] 时建出来', () => {
    const document = load('{\n  "pluginId": "x"\n}\n')
    expect(addScriptEntry(document, {
      name: 's',
      path: 'a.js',
      entry: 'handle',
      allowlist: [],
      inputs: [],
      outputs: [],
    })).toBe(true)
    expect(serializeManifest(document)).toContain('"scripts"')
  })

  it('不动未知字段与既有条目', () => {
    const document = load()
    addScriptEntry(document, {
      name: 'fresh',
      path: 'a.js',
      entry: 'handle',
      allowlist: [],
      inputs: [],
      outputs: [],
    })
    const text = serializeManifest(document)
    expect(text).toContain('"futureField": "平台还不认识这个字段"')
    expect(text).toContain('"existing"')
    expect(text).toContain('"pluginId": "demo_backend"')
  })
})

describe('setScriptIo / setScriptAllowlist', () => {
  it('改 io 契约', () => {
    const document = load()
    expect(setScriptIo(document, 'existing', {
      inputs: [{ name: 'changed', type: 'number', required: true }],
      outputs: [],
    })).toBe(true)
    expect(serializeManifest(document)).toContain('"changed"')
  })

  it('值没变时回 false（不制造假 diff）', () => {
    const document = load()
    expect(setScriptIo(document, 'existing', {
      inputs: [{ name: 'a', type: 'string', required: true }],
      outputs: [{ name: 'b', type: 'bool' }],
    })).toBe(false)
  })

  it('改 allowlist', () => {
    const document = load()
    expect(setScriptAllowlist(document, 'existing', ['video:process'])).toBe(true)
    expect(serializeManifest(document)).toContain('video:process')
  })

  it('脚本不存在时回 false', () => {
    expect(setScriptAllowlist(load(), 'ghost', [])).toBe(false)
  })
})

describe('defaultScriptSource', () => {
  it('入口函数名与 entry 一致（对不上就是「入口函数不存在」）', () => {
    expect(defaultScriptSource('onPhoto')).toContain('function onPhoto (input, ctx)')
  })

  it('默认源码是 ES5，不含 goja 不支持的语法', () => {
    // 只看代码部分：注释里会提到「没有 Promise / async」，那是正文不是语法
    const code = defaultScriptSource('handle')
      .split('\n')
      .filter(line => !line.trimStart().startsWith('//'))
      .join('\n')
    expect(code).not.toContain('=>')
    expect(code).not.toContain('async ')
    expect(code).not.toContain('Promise')
    expect(code).not.toContain('const ')
  })
})

describe('defaultScriptPath', () => {
  it('由脚本名派生路径', () => {
    expect(defaultScriptPath('lane-change')).toBe('adapters/lane-change.js')
  })

  it('把不安全字符换掉（路径要能安全落盘）', () => {
    expect(defaultScriptPath('a/b c')).toBe('adapters/a-b-c.js')
    // 关键：`..` 必须被收掉，带它的路径正是契约 §0 要拦的逃逸形状
    expect(defaultScriptPath('../escape')).toBe('adapters/escape.js')
    expect(defaultScriptPath('..')).toBe('adapters/script.js')
  })

  it('空名字有兜底', () => {
    expect(defaultScriptPath('   ')).toBe('adapters/script.js')
  })
})
