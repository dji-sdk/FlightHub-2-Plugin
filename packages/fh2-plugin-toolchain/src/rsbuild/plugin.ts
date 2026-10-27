// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EnvironmentConfig, RsbuildConfig, RsbuildPlugin } from '@rsbuild/core'
import { FRONTEND_OUTPUT_POLICY } from '../build/policy.js'
import { PROJECT_PATHS } from '../project-policy.js'
import {
  brandFh2Plugin,
  requireFh2PluginExecutionContext,
} from './context.js'

export interface Fh2PluginOptions {
  readonly manifestPath?: string;
  readonly pluginEntry?: string;
  readonly typesOutDir?: string;
  /** @deprecated 标准构建始终校验；false 将报错。 */
  readonly validateOnBuild?: true;
}

export const FH2_PLUGIN_DUTIES = [
  '读取并严格校验 Manifest，config schema 自身合法（default 落在 min/max 内，enum 非空且含 default）',
  '把 src/plugin.ts 构建到 Manifest 顶层 entry（强制单文件：all-in-one + asyncChunks:false，任意 import 写法收敛为自包含 ESM）',
  '把每个唯一 View entry 构建为独立 bundle（多文件 + 共享 chunk，Vue 3 自带）',
  '允许 Plugin Entry 的动态 import，构建时经 asyncChunks:false 内联进单文件（不生成 Host chunks）',
  '以 View entry 为边界收集 CSS，不注入 document.head',
  '写入 View JS/CSS 规范化路径（带内容 hash）、manifestVersion、engines.platform 与 buildInfo',
  '生成 Extension / Point 契约 / View / Config / Permission 类型与 Host Context 别名',
  '检查必需贡献的注册覆盖和跨 Host Capability 误用',
] as const

export function fh2Plugin (options: Fh2PluginOptions = {}): RsbuildPlugin {
  if ((options as { validateOnBuild?: boolean }).validateOnBuild === false)
    throw new Error('fh2Plugin({ validateOnBuild: false }) 不受支持；标准构建始终执行 Validate。')

  const plugin: RsbuildPlugin = {
    name: 'fh2-plugin',
    setup (api) {
      const context = requireFh2PluginExecutionContext(plugin)
      const pluginEntryName = outputPathToEntryName(context.manifest.entry)
      const viewEntries = Object.fromEntries(
        Object.entries(context.entries.views).map(([viewId, entry]) => [`views/${viewId}`, entry]),
      )
      const baseOutput = {
        target: 'web' as const,
        filenameHash: true,
        filename: FRONTEND_OUTPUT_POLICY.filename,
        minify: false,
        sourceMap: false,
        legalComments: 'none' as const,
        injectStyles: FRONTEND_OUTPUT_POLICY.injectStyles,
        // View 由宿主页动态 import；auto 让 JS 中的图片/字体相对实际 bundle URL 解析，
        // 不能固定为相对宿主页的 "./"。
        assetPrefix: 'auto',
        distPath: { root: context.candidateRoot, js: '', css: '' },
        cleanDistPath: false,
      }
      const environments: Record<string, EnvironmentConfig> = {
        plugin: {
          source: { entry: { [pluginEntryName]: context.entries.plugin } },
          output: { ...baseOutput, module: true },
          performance: { chunkSplit: { strategy: FRONTEND_OUTPUT_POLICY.chunkStrategy } },
          tools: {
            htmlPlugin: false,
            rspack: (config) => {
              config.output = {
                ...config.output,
                asyncChunks: FRONTEND_OUTPUT_POLICY.asyncChunks,
                chunkFilename: FRONTEND_OUTPUT_POLICY.filename.js,
                library: { type: 'module' },
              }
              return config
            },
          },
        },
      }
      if (Object.keys(viewEntries).length > 0) {
        environments.views = {
          source: { entry: viewEntries },
          output: { ...baseOutput, module: true },
          tools: {
            htmlPlugin: false,
            rspack: (config) => {
              config.output = {
                ...config.output,
                asyncChunks: FRONTEND_OUTPUT_POLICY.asyncChunks,
                chunkFilename: FRONTEND_OUTPUT_POLICY.filename.js,
                library: { type: 'module' },
              }
              return config
            },
          },
        }
      }

      api.modifyRsbuildConfig((config): RsbuildConfig => {
        const source = { ...config.source }
        delete source.entry
        return {
          ...config,
          mode: 'production',
          source,
          server: {
            ...config.server,
            publicDir: existsSync(resolve(context.projectRoot, PROJECT_PATHS.public))
              ? { name: resolve(context.projectRoot, PROJECT_PATHS.public), copyOnBuild: true }
              : false,
          },
          environments,
        }
      })
      api.onAfterEnvironmentCompile(({ environment, stats }) => {
        if (stats !== undefined) context.collect(environment.name, stats)
      })
    },
  }

  return brandFh2Plugin(plugin, {
    ...(options.manifestPath === undefined ? {} : { manifestPath: options.manifestPath }),
    ...(options.pluginEntry === undefined ? {} : { pluginEntry: options.pluginEntry }),
    ...(options.typesOutDir === undefined ? {} : { typesOutDir: options.typesOutDir }),
  })
}

function outputPathToEntryName (outputPath: string): string {
  return outputPath.replace(/^\.\//, '').replace(/\.js$/, '')
}
