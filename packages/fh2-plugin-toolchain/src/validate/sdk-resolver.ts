// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

interface PackageJson {
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}

export class SdkResolutionError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'SdkResolutionError'
  }
}

export class SdkRuntimeContractError extends SdkResolutionError {
  constructor (message: string) {
    super(message)
    this.name = 'SdkRuntimeContractError'
  }
}

export interface SdkRuntimeContract {
  readonly schemaVersion: 1;
  readonly manifestVersion: number;
  readonly platformVersion: string;
  readonly platformRange: string;
}

export interface ProjectSdkContext {
  readonly projectSdkVersion: string;
  readonly runtimeContract: SdkRuntimeContract;
}

export const TOOLCHAIN_SDK_VERSION = readToolchainSdkVersion()

export function resolveProjectSdkVersion (projectRoot: string): string {
  return resolveProjectSdkContext(projectRoot).projectSdkVersion
}

export function resolveProjectSdkContext (projectRoot: string): ProjectSdkContext {
  const require = createRequire(join(projectRoot, 'package.json'))
  try {
    const packagePath = require.resolve('fh2-plugin-sdk/package.json')
    const packageJson = readPackageJson(packagePath)
    if (typeof packageJson.version !== 'string' || packageJson.version === '')
      throw new SdkResolutionError(`项目 SDK package.json 缺少有效 version：${packagePath}`)
    let contractPath: string
    try {
      contractPath = require.resolve('fh2-plugin-sdk/runtime-contract.json')
    } catch {
      throw new SdkRuntimeContractError(`无法从项目根解析 fh2-plugin-sdk/runtime-contract.json：${projectRoot}`)
    }
    const runtimeContract = readRuntimeContract(contractPath)
    return { projectSdkVersion: packageJson.version, runtimeContract }
  } catch (error) {
    if (error instanceof SdkResolutionError) throw error
    throw new SdkResolutionError(`无法从项目根解析 fh2-plugin-sdk/package.json：${projectRoot}`)
  }
}

/**
 * Toolchain 实际支持的 SDK 版本：从 Toolchain 包位置解析到的 SDK package.json version。
 *
 * 不读取依赖声明字符串——仓库源码内依赖是 `workspace:*`（发布 tarball 由 pnpm pack
 * 转成精确版本），两种形态下解析到的真实 version 才是 Toolchain 的支持基线。
 */
function readToolchainSdkVersion (): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [resolve(here, '..', 'package.json'), resolve(here, '../..', 'package.json')]
  const packagePath = candidates.find(candidate => existsSync(candidate))
  if (packagePath === undefined) throw new Error('无法定位 fh2-plugin-toolchain/package.json')
  const require = createRequire(packagePath)
  let sdkPackagePath: string
  try {
    sdkPackagePath = require.resolve('fh2-plugin-sdk/package.json')
  } catch {
    throw new Error('无法从 Toolchain 解析 fh2-plugin-sdk：请确认依赖已安装')
  }
  const sdkPackage = readPackageJson(sdkPackagePath)
  if (typeof sdkPackage.version !== 'string' || sdkPackage.version === '')
    throw new Error(`Toolchain 依赖的 fh2-plugin-sdk 缺少有效 version：${sdkPackagePath}`)
  return sdkPackage.version
}

function readPackageJson (path: string): PackageJson {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageJson
}

function readRuntimeContract (path: string): SdkRuntimeContract {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new SdkRuntimeContractError(`无法读取项目 SDK runtime-contract metadata：${error instanceof Error ? error.message : String(error)}`)
  }
  if (isRecord(value) && value.platformVersion === undefined) {
    throw new SdkRuntimeContractError(
      `项目 SDK runtime-contract 缺少 platformVersion（该 SDK 早于协议版本独立改造，请升级 fh2-plugin-sdk）：${path}`,
    )
  }
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !Number.isInteger(value.manifestVersion)
    || (value.manifestVersion as number) < 1
    || typeof value.platformVersion !== 'string'
    || semver.valid(value.platformVersion) === null
    || typeof value.platformRange !== 'string'
    || semver.validRange(value.platformRange) === null) {
    throw new SdkRuntimeContractError(`项目 SDK runtime-contract metadata 格式无效：${path}`)
  }
  const platformRange = value.platformRange
  const platformVersion = value.platformVersion
  const hasUpperBound = new semver.Range(platformRange).set.some(comparators =>
    comparators.some(comparator => comparator.operator === '<' || comparator.operator === '<='))
  if (!hasUpperBound)
    throw new SdkRuntimeContractError(`项目 SDK runtime-contract platformRange 必须带上界（锁到下一个 major）：${path}`)
  if (!semver.satisfies(platformVersion, platformRange, { includePrerelease: true }))
    throw new SdkRuntimeContractError(`项目 SDK runtime-contract platformVersion ${platformVersion} 不在 platformRange "${platformRange}" 内：${path}`)
  return Object.freeze({
    schemaVersion: 1,
    manifestVersion: value.manifestVersion as number,
    platformVersion,
    platformRange,
  })
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
