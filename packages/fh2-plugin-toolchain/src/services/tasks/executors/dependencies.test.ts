// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectPackageManager, ensureDependenciesInstalled, installSpawnShell, resolveInstallRoots, runPackageManagerInstall, stopInstallChild } from './dependencies.js'
import type { InstallChildProcess, InstallRunOptions, PackageManagerName } from './dependencies.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempRoot (): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-deps-'))
  roots.push(root)
  return root
}

/** 最小后端插件工程（discovery 按 fh2-plugin.json.pluginId 识别）。 */
async function createBackendPlugin (parent: string, id: string): Promise<string> {
  const root = join(parent, id)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({
    pluginId: id,
    name: id,
    version: '0.1.0',
    contractsRange: '>=1.0.0 <2.0.0',
  }))
  return root
}

describe('resolveInstallRoots', () => {
  it('后端插件根缺 node_modules → 装自身；已装 → 空', async () => {
    const parent = await tempRoot()
    const plugin = await createBackendPlugin(parent, 'exp_deps_backend')
    await writeFile(join(plugin, 'package.json'), '{"name":"x","dependencies":{}}')

    expect(resolveInstallRoots(plugin)).toEqual([plugin])

    await mkdir(join(plugin, 'node_modules'))
    expect(resolveInstallRoots(plugin)).toEqual([])
  })

  it('无 package.json 的根不触发安装', async () => {
    const parent = await tempRoot()
    const plugin = await createBackendPlugin(parent, 'exp_deps_backend')
    expect(resolveInstallRoots(plugin)).toEqual([])
  })

  it('capability 根：根 + backend 成员各自独立检测', async () => {
    const root = await tempRoot()
    // capability 结构：capabilities.json + backend/<id>/fh2-plugin.json
    await writeFile(join(root, 'capabilities.json'), JSON.stringify({ name: 'c', description: 'd' }))
    const backendRoot = join(root, 'backend', 'exp_deps_backend')
    await mkdir(backendRoot, { recursive: true })
    await writeFile(join(backendRoot, 'fh2-plugin.json'), JSON.stringify({ pluginId: 'exp_deps_backend', name: 'b', version: '0.1.0', contractsRange: '>=1.0.0 <2.0.0' }))
    await writeFile(join(backendRoot, 'package.json'), '{"name":"b","dependencies":{}}')
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['frontend/*'] }))

    const rootsToInstall = resolveInstallRoots(root)
    expect(rootsToInstall).toHaveLength(2)
    expect(rootsToInstall).toContain(root)
    expect(rootsToInstall).toContain(backendRoot)

    // 根已装、backend 未装 → 只剩 backend
    await mkdir(join(root, 'node_modules'))
    expect(resolveInstallRoots(root)).toEqual([backendRoot])
  })
})

describe('detectPackageManager', () => {
  it('lockfile 优先于 UA，UA 优先于默认 npm', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'package.json'), '{"name":"x"}')
    expect(detectPackageManager(root, 'pnpm/10 node/v20')).toBe('pnpm')

    await writeFile(join(root, 'pnpm-lock.yaml'), '')
    expect(detectPackageManager(root, 'npm/11 node/v20')).toBe('pnpm')

    const root2 = await tempRoot()
    await writeFile(join(root2, 'package.json'), '{"name":"x"}')
    expect(detectPackageManager(root2, 'yarn/1.22 node/v20')).toBe('yarn')
    expect(detectPackageManager(root2, undefined)).toBe('npm')

    const root3 = await tempRoot()
    await writeFile(join(root3, 'package-lock.json'), '')
    expect(detectPackageManager(root3, undefined)).toBe('npm')
  })
})

describe('ensureDependenciesInstalled / runPackageManagerInstall', () => {
  /** 可编程子进程桩：记录调用并按脚本触发事件（脚本在注册完 listener 后的微任务里跑）。 */
  function stubChild (script: (child: StubChild) => void): { readonly spawn: NonNullable<InstallRunOptions['spawnInstall']>; readonly calls: Array<{ manager: PackageManagerName; cwd: string }> } {
    const calls: Array<{ manager: PackageManagerName; cwd: string }> = []
    return {
      calls,
      spawn: (manager, cwd) => {
        calls.push({ manager, cwd })
        const stub = new StubChild()
        // onExit/onData 注册发生在 spawn() 返回之后，脚本必须异步触发
        void Promise.resolve().then(() => script(stub))
        return stub
      },
    }
  }

  class StubChild implements InstallChildProcess {
    dataListeners = new Map<'stdout' | 'stderr', Array<(chunk: Buffer) => void>>()
    exitListeners: Array<(code: number | null) => void> = []
    errorListeners: Array<(error: Error) => void> = []
    killed: string[] = []
    killHooks: Array<() => void> = []

    onData (stream: 'stdout' | 'stderr', listener: (chunk: Buffer) => void): void {
      this.dataListeners.set(stream, [...(this.dataListeners.get(stream) ?? []), listener])
    }

    onExit (listener: (code: number | null) => void): void {
      this.exitListeners.push(listener)
    }

    onError (listener: (error: Error) => void): void {
      this.errorListeners.push(listener)
    }

    kill (signal: NodeJS.Signals): void {
      this.killed.push(signal)
      for (const hook of this.killHooks) hook()
    }

    /** 真实进程被 kill 会退出：注册 exit-on-kill 行为。 */
    onKill (hook: () => void): void {
      this.killHooks.push(hook)
    }

    emitData (stream: 'stdout' | 'stderr', text: string): void {
      for (const listener of this.dataListeners.get(stream) ?? []) listener(Buffer.from(text))
    }

    exit (code: number | null): void {
      for (const listener of this.exitListeners) listener(code)
    }
  }

  function options (spawnInstall: NonNullable<InstallRunOptions['spawnInstall']>): InstallRunOptions & { readonly logs: string[] } {
    const logs: string[] = []
    return {
      emitLog: (stream, line) => {
        logs.push(`${stream}:${line}`)
      },
      signal: new AbortController().signal,
      spawnInstall,
      logs,
    }
  }

  it('全部已安装时 no-op（不 spawn）', async () => {
    const parent = await tempRoot()
    const plugin = await createBackendPlugin(parent, 'exp_deps_backend')
    await writeFile(join(plugin, 'package.json'), '{"name":"x"}')
    await mkdir(join(plugin, 'node_modules'))

    const stub = stubChild(() => undefined)
    const opts = options(stub.spawn)
    await ensureDependenciesInstalled(plugin, opts)
    expect(stub.calls).toHaveLength(0)
  })

  it('缺依赖时逐根串行 install，stdout/stderr 逐行转发', async () => {
    const parent = await tempRoot()
    const plugin = await createBackendPlugin(parent, 'exp_deps_backend')
    await writeFile(join(plugin, 'package.json'), '{"name":"x"}')
    // 检测顺序是 lockfile → npm_config_user_agent → npm；用 pnpm 跑测试时 UA 是
    // pnpm，固定成 npm UA 才能确定性地断言 install 命令与日志文案。
    vi.stubEnv('npm_config_user_agent', 'npm/10.8.2')

    try {
      const stub = stubChild((child) => {
        child.emitData('stdout', 'added 42 packages\n')
        child.emitData('stderr', 'warn something\n')
        child.exit(0)
      })
      const opts = options(stub.spawn)
      await ensureDependenciesInstalled(plugin, opts)
      expect(stub.calls).toEqual([{ manager: 'npm', cwd: plugin }])
      expect(opts.logs.some(log => log.includes('自动执行 npm install'))).toBe(true)
      expect(opts.logs).toContain('stdout:added 42 packages')
      expect(opts.logs).toContain('stderr:warn something')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('退出码非 0 抛安装失败错误', async () => {
    const parent = await tempRoot()
    const plugin = await createBackendPlugin(parent, 'exp_deps_backend')
    await writeFile(join(plugin, 'package.json'), '{"name":"x"}')

    const stub = stubChild(child => child.exit(1))
    await expect(ensureDependenciesInstalled(plugin, options(stub.spawn)))
      .rejects.toThrow('依赖安装失败')
  })

  it('abort：SIGTERM → 宽限 SIGKILL，抛取消错误', async () => {
    const controller = new AbortController()
    const child = new StubChild()
    const logs: string[] = []
    // 真实进程被 kill 会退出：stub 在收到终止信号时模拟 exit(被信号中断)
    child.onKill(() => child.exit(null))
    const pending = runPackageManagerInstall('npm', '/tmp/x', {
      emitLog: (stream, line) => logs.push(`${stream}:${line}`),
      signal: controller.signal,
      spawnInstall: () => child,
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort()
    await expect(pending).rejects.toThrow('取消')
    expect(child.killed).toContain('SIGTERM')
  })
})

describe('windows spawn 兼容（installSpawnShell / stopInstallChild）', () => {
  it('installSpawnShell：win32 经 cmd.exe 解析 .cmd shim，POSIX 直启', () => {
    expect(installSpawnShell('win32')).toBe(true)
    expect(installSpawnShell('darwin')).toBe(false)
    expect(installSpawnShell('linux')).toBe(false)
  })

  it('win32 终止：先 taskkill /T 树杀（shell:true 的 child 是 cmd.exe 壳，kill 杀不到包管理器孙进程），再 kill 壳本身', () => {
    const treeKillPids: number[] = []
    const kills: string[] = []
    stopInstallChild({ pid: 4321, kill: signal => kills.push(signal) }, 'SIGTERM', 'win32', pid => treeKillPids.push(pid))
    expect(treeKillPids).toEqual([4321])
    expect(kills).toEqual(['SIGTERM'])
  })

  it('posix 终止：直接 kill，不做树杀', () => {
    const treeKillPids: number[] = []
    const kills: string[] = []
    stopInstallChild({ pid: 4321, kill: signal => kills.push(signal) }, 'SIGTERM', 'darwin', pid => treeKillPids.push(pid))
    expect(treeKillPids).toEqual([])
    expect(kills).toEqual(['SIGTERM'])
  })

  it('win32 下 pid 缺失（spawn 失败）只 kill 不树杀', () => {
    const treeKillPids: number[] = []
    const kills: string[] = []
    stopInstallChild({ pid: undefined, kill: signal => kills.push(signal) }, 'SIGKILL', 'win32', pid => treeKillPids.push(pid))
    expect(treeKillPids).toEqual([])
    expect(kills).toEqual(['SIGKILL'])
  })
})
