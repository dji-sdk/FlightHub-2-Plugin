// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRsbuild } from '@rsbuild/core'
import type { loadConfig } from '@rsbuild/core'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { PluginManifest } from 'fh2-plugin-sdk'
import { writeGeneratedTypes } from '../generate/write-generated-types.js'
import { fh2Plugin } from '../rsbuild/plugin.js'
import { validateSourceManifestSnapshot } from '../validate/index.js'
import { resolveBuildDescriptor } from './paths.js'
import { createPluginBuildRunner, executeBuildRound } from './runner.js'
import type { BuildRunnerDependencies } from './runner.js'
import { PluginBuildError } from './types.js'
import type { PluginBuildEvent } from './types.js'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
// fixture 放在 Toolchain 包内：Rsbuild 的模块解析沿目录向上找到 Toolchain node_modules
// （vue/@rsbuild 由 Toolchain devDependencies 提供），不再依赖 examples 下的真实插件工程。
const fixtureParent = resolve(repositoryRoot, 'packages/fh2-plugin-toolchain/.fh2-real-build-fixtures')
const directories: string[] = []
const { watchers } = vi.hoisted(() => ({ watchers: [] as import('chokidar').FSWatcher[] }))

vi.mock('chokidar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('chokidar')>()
  const watch: typeof actual.watch = (paths, options) => {
    const watcher = actual.watch(paths, options)
    watchers.push(watcher)
    return watcher
  }
  return { ...actual, watch }
})

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  watchers.splice(0)
})

describe('真实 Rsbuild fixture', () => {
  it('minimal: Generate 先于 compiler，Plugin 静态/动态 import 收敛为单一 hashed ESM', async () => {
    const root = fixtureRoot('minimal')
    writeManifest(root, sourceManifest('exp_real_minimal'))
    write(root, 'src/helper.ts', `export const helper = 'helper'\n`)
    write(root, 'shared-outside-src.ts', `export const outside = 'outside-src'\n`)
    write(root, 'src/lazy.ts', `export const lazy = 'lazy'\n`)
    write(root, 'src/plugin.ts', `
import { helper } from './helper'
import { outside } from '../shared-outside-src'
export default {
  activate: async () => helper + outside + (await import('./lazy')).lazy,
}
`)

    let generatedExistedAtCompilerStart = false
    const result = await runRealRound(root, () => {
      generatedExistedAtCompilerStart = existsSync(join(root, 'src/generated/plugin-types.ts'))
    })
    expect(generatedExistedAtCompilerStart).toBe(true)
    expect(result.manifest.entry).toMatch(/^\.\/plugin\.[a-f0-9]+\.js$/)
    const files = walkFiles(join(root, 'dist'))
    expect(files.filter(file => file.endsWith('.js'))).toEqual([result.manifest.entry.slice(2)])
    const pluginSource = readFileSync(join(root, 'dist', result.manifest.entry.slice(2)), 'utf8')
    expect(pluginSource).toContain('export {')
    expect(pluginSource).not.toMatch(/^\s*import\s/m)
    expect(result.watchDependencies.some(path => path.endsWith('/shared-outside-src.ts'))).toBe(true)
  })

  it('multi-view: Vue/shared chunks、CSS、小/大资源与动态 import', async () => {
    const root = fixtureRoot('multi')
    writeManifest(root, {
      ...sourceManifest('exp_real_multi'),
      views: {
        alpha: { entry: './views/alpha.js' },
        beta: { entry: './views/beta.js' },
      },
      contributes: { icons: [{ id: 'fixture-icon', src: './icons/fixture.svg' }] },
    })
    write(root, 'src/plugin.ts', `export default { activate: () => undefined }\n`)
    write(root, 'src/views/shared.ts', `export const sharedLabel = 'shared-view-module'\n`)
    write(root, 'src/lazy.ts', `export const lazyLabel = 'lazy-view-module'\n`)
    write(root, 'src/assets/small.svg', `<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>\n`)
    write(root, 'src/assets/large.svg', `<svg xmlns="http://www.w3.org/2000/svg"><path d="${'M0 0 '.repeat(4 * 1024)}"/></svg>\n`)
    write(root, 'src/assets/large.bin', 'x'.repeat(16 * 1024))
    write(root, 'src/views/alpha/index.ts', viewSource('alpha', true))
    write(root, 'src/views/beta/index.ts', viewSource('beta', false))
    write(root, 'src/views/alpha/style.css', viewCss('alpha'))
    write(root, 'src/views/beta/style.css', viewCss('beta'))
    write(root, 'public/icons/fixture.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>\n')

    const result = await runRealRound(root)
    const manifest = result.manifest
    expect(Object.keys(manifest.views ?? {})).toEqual(['alpha', 'beta'])
    for (const view of Object.values(manifest.views ?? {})) {
      expect(view.entry).toMatch(/^\.\/views\/(?:alpha|beta)\.[a-f0-9]+\.js$/)
      expect(view.styles).toHaveLength(1)
      expect(existsSync(join(root, 'dist', view.entry.slice(2)))).toBe(true)
    }

    const files = walkFiles(join(root, 'dist'))
    const viewEntries = new Set(Object.values(manifest.views ?? {}).map(view => view.entry.slice(2)))
    const sharedChunks = files.filter(file => file.endsWith('.js')
      && file !== manifest.entry.slice(2)
      && !viewEntries.has(file))
    expect(sharedChunks.length).toBeGreaterThanOrEqual(1)
    expect(sharedChunks.every(file => /\.[a-f0-9]+\.js$/.test(file))).toBe(true)
    expect(sharedChunks.some(file => statSync(join(root, 'dist', file)).size > 100_000)).toBe(true)
    expect(files.some(file => file.endsWith('.bin'))).toBe(true)
    expect(files).toContain('icons/fixture.svg')
    const css = Object.values(manifest.views ?? {})
      .flatMap(view => view.styles ?? [])
      .map(path => readFileSync(join(root, 'dist', path.slice(2)), 'utf8'))
      .join('\n')
    expect(css).toContain('data:image/svg+xml')
    expect(css).toMatch(/static\/assets\/large\.[a-f0-9]+\.bin/)
    const viewSources = [...viewEntries]
      .map(path => readFileSync(join(root, 'dist', path), 'utf8'))
      .join('\n')
    expect(viewSources).toMatch(/__webpack_require__\.p \+ "static\/(?:assets|svg)\/large\.[a-f0-9]+\.svg"/)
    expect(viewSources).not.toContain('__webpack_require__.p = "./"')
    expect(result.watchDependencies.some(path => /\/node_modules\/(?:@vue\/[^/]+|vue)\//.test(path))).toBe(true)
  })

  it('compiler 失败时保留旧 dist 并清理 candidate，generated types 可以保留', async () => {
    const root = fixtureRoot('failure')
    writeManifest(root, sourceManifest('exp_real_failure'))
    write(root, 'src/plugin.ts', 'export default { broken: }\n')
    write(root, 'dist/marker.txt', 'last-success')

    await expect(runRealRound(root)).rejects.toBeInstanceOf(PluginBuildError)
    expect(readFileSync(join(root, 'dist/marker.txt'), 'utf8')).toBe('last-success')
    expect(existsSync(join(root, 'src/generated/plugin-types.ts'))).toBe(true)
    expect(readdirSync(root).some(file => file.includes('.fh2-next-'))).toBe(false)
  })

  it('延迟提交时保留候选 dist，旧 dist 不被替换', async () => {
    const root = fixtureRoot('defer-commit')
    writeManifest(root, sourceManifest('exp_real_defer_commit'))
    write(root, 'src/plugin.ts', `export default { activate: () => undefined }\n`)
    write(root, 'dist/marker.txt', 'last-success')

    const result = await runRealRound(root, { deferCommit: true })

    expect(result.candidateRoot).toBeDefined()
    expect(readFileSync(join(root, 'dist/marker.txt'), 'utf8')).toBe('last-success')
    expect(existsSync(join(result.candidateRoot!, 'fh2-plugin.json'))).toBe(true)
    rmSync(result.candidateRoot!, { recursive: true, force: true })
  })

  it('buildResult 在 commit 前关闭，close 失败保留旧 dist', async () => {
    const root = fixtureRoot('close-order')
    writeManifest(root, sourceManifest('exp_real_close_order'))
    write(root, 'src/plugin.ts', `export default { activate: () => undefined }\n`)
    write(root, 'dist/marker.txt', 'last-success')
    let committedAtClose = false
    const build = runRealRound(root, {
      onClose: () => {
        committedAtClose = existsSync(join(root, 'dist/fh2-plugin.json'))
      },
      failClose: true,
    })
    await expect(build).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'FH2_BUILD_RESULT_CLOSE_FAILED' })],
    })
    expect(readFileSync(join(root, 'dist/marker.txt'), 'utf8')).toBe('last-success')
    expect(committedAtClose).toBe(false)
    expect(existsSync(join(root, 'dist/fh2-plugin.json'))).toBe(false)
  })

  it('close hook 篡改 candidate 后 final verify 失败，旧 dist 保留且不发 success', async () => {
    const root = fixtureRoot('close-mutation')
    writeManifest(root, sourceManifest('exp_real_close_mutation'))
    write(root, 'src/plugin.ts', `export default { activate: () => undefined }\n`)
    write(root, 'dist/marker.txt', 'last-success')
    const adapterModule = pathToFileURL(resolve(
      repositoryRoot,
      'packages/fh2-plugin-toolchain/src/rsbuild/index.ts',
    )).href
    write(root, 'rsbuild.config.ts', `
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fh2Plugin } from ${JSON.stringify(adapterModule)}
const projectRoot = ${JSON.stringify(root)}
const mutateOnClose = {
  name: 'mutate-on-close',
  setup(api) {
    api.onCloseBuild(() => {
      const candidate = readdirSync(projectRoot).find(name => name.startsWith('.dist.fh2-next-'))
      if (candidate) {
        const manifestPath = join(projectRoot, candidate, 'fh2-plugin.json')
        if (existsSync(manifestPath)) rmSync(manifestPath)
      }
    })
  },
}
export default {
  logLevel: 'silent',
  performance: { printFileSize: false },
  plugins: [mutateOnClose, fh2Plugin()],
}
`)
    const events: PluginBuildEvent[] = []
    const session = await createPluginBuildRunner({
      cwd: root,
      configPath: './rsbuild.config.ts',
      watch: false,
      onEvent: event => events.push(event),
    })
    onTestFinished(() => session.close())
    await expect(session.firstBuild).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'FH2_DIST_MANIFEST_READ_FAILED' })],
    })
    await expect(session.done).resolves.toEqual({ reason: 'closed' })
    expect(events.some(event => event.type === 'success')).toBe(false)
    expect(readFileSync(join(root, 'dist/marker.txt'), 'utf8')).toBe('last-success')
  })

  it('createPluginBuildRunner 真实加载 config，并隔离顶层 source.entry', async () => {
    const root = fixtureRoot('real-config')
    writeManifest(root, sourceManifest('exp_real_config'))
    write(root, 'src/plugin.ts', `export default { activate: () => undefined }\n`)
    write(root, 'src/rogue.ts', `export default { broken: }\n`)
    const adapterModule = pathToFileURL(resolve(
      repositoryRoot,
      'packages/fh2-plugin-toolchain/src/rsbuild/index.ts',
    )).href
    write(root, 'rsbuild.config.ts', `
import { fh2Plugin } from ${JSON.stringify(adapterModule)}
export default {
  logLevel: 'silent',
  source: { entry: { rogue: './src/rogue.ts' } },
  performance: { printFileSize: false },
  plugins: [fh2Plugin()],
}
`)

    const session = await createPluginBuildRunner({
      cwd: root,
      configPath: './rsbuild.config.ts',
      watch: false,
    })
    await session.firstBuild
    await expect(session.done).resolves.toEqual({ reason: 'closed' })
    const files = walkFiles(join(root, 'dist'))
    expect(files.some(file => /^plugin\.[a-f0-9]+\.js$/.test(file))).toBe(true)
    expect(files.some(file => file.startsWith('rogue.'))).toBe(false)
  })

  it('真实 watch 从无 dist 首建，经历 success/failure/recovery 后可完整关闭', async () => {
    const root = fixtureRoot('real-watch')
    const sharedDependency = join(root, 'shared-watch.ts')
    writeManifest(root, sourceManifest('exp_real_watch'))
    write(root, 'shared-watch.ts', `export const value = 'first'\n`)
    write(root, 'src/build-status.ts', `export const status = ''\n`)
    write(root, 'src/plugin.ts', `
import { value } from '../shared-watch'
import { status } from './build-status'
export default { activate: () => value + status }
`)
    const adapterModule = pathToFileURL(resolve(
      repositoryRoot,
      'packages/fh2-plugin-toolchain/src/rsbuild/index.ts',
    )).href
    write(root, 'rsbuild.config.ts', `
import { fh2Plugin } from ${JSON.stringify(adapterModule)}
export default {
  logLevel: 'silent',
  performance: { printFileSize: false },
  plugins: [fh2Plugin()],
}
`)
    const events: PluginBuildEvent[] = []
    expect(existsSync(join(root, 'dist'))).toBe(false)
    const session = await createPluginBuildRunner({
      cwd: root,
      configPath: './rsbuild.config.ts',
      watch: true,
      onEvent: event => events.push(event),
    })
    try {
      await session.firstBuild
      const firstManifest = JSON.parse(readFileSync(join(root, 'dist/fh2-plugin.json'), 'utf8')) as PluginManifest
      expect(readFileSync(join(root, 'dist', firstManifest.entry.slice(2)), 'utf8')).toContain('first')
      expect(events.some(event => event.type === 'success' && event.watchDependencies?.includes(sharedDependency))).toBe(true)
      expect(watchers).toHaveLength(1)
      // Chokidar add() scans asynchronously; ready only covers its initial paths, not this discovered dependency.
      await vi.waitFor(() => {
        expect(watchers[0]!.getWatched()[dirname(sharedDependency)]).toContain(basename(sharedDependency))
      }, { timeout: 20_000, interval: 50 })
      // Watch events can queue extra rounds; match a new success to the committed entry and source value.
      const successBaseline = events.at(-1)!.buildId
      writeFileSync(sharedDependency, `export const value = 'second'\n`)
      const secondManifest = await vi.waitFor(() => {
        const manifest = JSON.parse(readFileSync(join(root, 'dist/fh2-plugin.json'), 'utf8')) as PluginManifest
        expect(manifest.entry).not.toBe(firstManifest.entry)
        expect(events.some(event => event.type === 'success'
          && event.buildId > successBaseline
          && event.distManifest?.entry === manifest.entry)).toBe(true)
        expect(readFileSync(join(root, 'dist', manifest.entry.slice(2)), 'utf8')).toContain('second')
        return manifest
      }, { timeout: 20_000, interval: 50 })
      expect(secondManifest.entry).not.toBe(firstManifest.entry)
      const secondSource = readFileSync(join(root, 'dist', secondManifest.entry.slice(2)), 'utf8')

      // Use distinct saved paths: build completion does not flush Chokidar's per-path change throttle.
      const failureBaseline = events.at(-1)!.buildId
      writeFileSync(join(root, 'src/build-status.ts'), `export const status =
`)
      await vi.waitFor(
        () => expect(events.some(event => event.type === 'failure'
          && event.buildId > failureBaseline
          && event.diagnostics.some(diagnostic => diagnostic.code === 'FH2_RSPACK_COMPILE_ERROR'))).toBe(true),
        { timeout: 20_000, interval: 50 },
      )
      const failedManifest = JSON.parse(readFileSync(join(root, 'dist/fh2-plugin.json'), 'utf8')) as PluginManifest
      expect(failedManifest.entry).toBe(secondManifest.entry)
      expect(readFileSync(join(root, 'dist', failedManifest.entry.slice(2)), 'utf8')).toBe(secondSource)

      const recoveryBaseline = events.at(-1)!.buildId
      writeFileSync(join(root, 'src/plugin.ts'), `
import { value } from '../shared-watch'
export default { activate: () => value + '-recovered' }
`)
      const recoveredManifest = await vi.waitFor(() => {
        const manifest = JSON.parse(readFileSync(join(root, 'dist/fh2-plugin.json'), 'utf8')) as PluginManifest
        expect(manifest.entry).not.toBe(secondManifest.entry)
        expect(events.some(event => event.type === 'success'
          && event.buildId > recoveryBaseline
          && event.distManifest?.entry === manifest.entry)).toBe(true)
        const source = readFileSync(join(root, 'dist', manifest.entry.slice(2)), 'utf8')
        expect(source).toContain('recovered')
        expect(source).toContain('second')
        return manifest
      }, { timeout: 20_000, interval: 50 })
      expect(recoveredManifest.entry).not.toBe(secondManifest.entry)
    } finally {
      await session.close()
    }
    await expect(session.done).resolves.toEqual({ reason: 'closed' })
    expect(watchers[0]!.closed).toBe(true)
  }, 60_000)
})

async function runRealRound (
  root: string,
  hooks: (() => void) | {
    readonly beforeCompiler?: () => void;
    readonly onClose?: () => void;
    readonly failClose?: boolean;
    readonly deferCommit?: boolean;
  } = {},
): ReturnType<typeof executeBuildRound> {
  const normalizedHooks = typeof hooks === 'function' ? { beforeCompiler: hooks } : hooks
  const adapter = fh2Plugin()
  const prepared = {
    config: {
      plugins: [adapter],
      logLevel: 'silent' as const,
      performance: { printFileSize: false },
    },
    adapter,
    descriptor: resolveBuildDescriptor(root, {}),
    ...(normalizedHooks.deferCommit === true ? { deferCommit: true } : {}),
  }
  const dependencies: BuildRunnerDependencies = {
    loadConfig: vi.fn() as unknown as typeof loadConfig,
    createRsbuild: async (options) => {
      normalizedHooks.beforeCompiler?.()
      const instance = await createRsbuild(options)
      if (normalizedHooks.onClose === undefined && normalizedHooks.failClose !== true) return instance
      return {
        ...instance,
        build: async (buildOptions) => {
          const result = await instance.build(buildOptions)
          return {
            ...result,
            close: async () => {
              await result.close()
              normalizedHooks.onClose?.()
              if (normalizedHooks.failClose === true) throw new Error('injected close failure')
            },
          }
        },
      }
    },
    watch: vi.fn() as never,
    executeRound: executeBuildRound,
    validate: validateSourceManifestSnapshot,
    generate: writeGeneratedTypes,
  }
  return executeBuildRound(prepared, 1, dependencies)
}

function fixtureRoot (name: string): string {
  mkdirSync(fixtureParent, { recursive: true })
  const root = mkdtempSync(join(fixtureParent, `.fh2-build-${name}-`))
  directories.push(root)
  return root
}

function sourceManifest (id: string): PluginManifest {
  return {
    id,
    name: '真实构建 Fixture',
    version: '1.0.0',
    entry: './plugin.js',
    extensions: [],
  }
}

function writeManifest (root: string, manifest: PluginManifest): void {
  write(root, 'fh2-plugin.json', `${JSON.stringify(manifest, null, 2)}\n`)
}

function viewSource (name: string, dynamic: boolean): string {
  return `
import { defineComponent, h } from 'vue'
import { sharedLabel } from '../shared'
import largeAsset from '../../assets/large.svg'
import './style.css'
${dynamic ? `const loadLazy = () => import('../../lazy')` : ''}
export default defineComponent({
  name: '${name}-fixture',
  setup: () => () => h('section', { class: '${name}', 'data-large-asset': largeAsset }, sharedLabel${dynamic ? ' + String(loadLazy)' : ''}),
})
`
}

function viewCss (name: string): string {
  return `.${name} {
  background-image: url('../../assets/small.svg');
  border-image-source: url('../../assets/large.bin');
}\n`
}

function write (root: string, relativePath: string, source: string): void {
  const path = join(root, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source)
}

function walkFiles (root: string, prefix = ''): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) files.push(...walkFiles(path, relativePath))
    else if (statSync(path).isFile()) files.push(relativePath)
  }
  return files.sort()
}
