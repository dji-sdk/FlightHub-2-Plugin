// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readmeUrl = new URL('../../README.md', import.meta.url)
const readme = readFileSync(readmeUrl, 'utf8')
const preview = readme.split('### 真实环境预览（仅 HTTP）\n')[1]!.split('\n## ')[0]!

describe('package README preview documentation', () => {
  it('documents HTTP-only manual setup and local readiness without claiming host execution', () => {
    expect(preview).toContain('仅支持 HTTP 目标')
    expect(preview).toContain('不支持 HTTPS 目标；无需本地证书')
    expect(preview).toContain('当前参数和默认值请运行 `fh2-plugin preview --help`')
    expect(preview).toMatch(/先在同一 HTTP Origin.*登录并进入目标项目[\s\S]*实际项目页.*保留项目路径和页面路由/)
    expect(preview).toMatch(/不要只用站点根地址.*重定向可能丢失调试参数/)
    expect(preview.match(/^\d+\. /gm)).toHaveLength(5)
    expect(preview).toMatch(/1\. .*PAC 地址[\s\S]*2\. .*已登录.*目标项目[\s\S]*调试面板地址/)
    expect(preview).toMatch(/仅添加 `fh2-plugin-debug=1`，不预填 source 或 session/)
    expect(preview).toMatch(/3\. .*手动填写.*插件来源URL.*本次会话的资源根 URL/)
    expect(preview).toMatch(/不是 Entry JS.*Manifest URL.*不是调试面板地址或 PAC 地址/)
    expect(preview).toMatch(/4\. .*宿主校验.*清单.*权限[\s\S]*勾选临时运行同意[\s\S]*确认.*重载/)
    expect(preview).toContain('工具链不代登录、代确认、授予权限或改变宿主调试规则')
    expect(preview).toMatch(/5\. .*Ctrl\+C.*禁用本地预览.*关闭临时 PAC、恢复原代理设置/)
    expect(preview).toMatch(/phase `ready`.*仅表示本地前端构建和 HTTP 代理已就绪.*不代表目标宿主已加载插件/)
    expect(preview).toContain('后端使用目标环境已安装的版本，不运行本地后端，也不是 Mock Workbench')
    expect(preview).toContain('本地文档测试不证明真实宿主登录、插件激活或生产加载')
  })

  it('provides one quoted HTTP project-page example and identifies the source without a missing package link', () => {
    const examples = [...preview.matchAll(/^fh2-plugin preview --root \. --fh2-url '([^']+)' --no-open$/gm)]
    expect(examples).toHaveLength(1)
    const target = new URL(examples[0]![1]!)
    expect(target.protocol).toBe('http:')
    expect(target.pathname).toMatch(/^\/organization\/[^/]+\/project\/[^/]+$/)
    expect(target.hash).toBe('#/team')
    expect(target.username).toBe('')
    expect(target.password).toBe('')
    expect(preview).toContain('将下例占位 URL 替换为浏览器中实际项目页的完整 HTTP 地址')

    expect(preview).toContain('源码 `src/tooling-contract/usage.ts` 中的 `CLI_USAGE.preview`')
    expect(preview).not.toMatch(/\]\(\.\/src\//)
  })
})
