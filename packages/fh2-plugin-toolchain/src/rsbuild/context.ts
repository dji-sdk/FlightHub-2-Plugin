// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { RsbuildPlugin, Rspack } from '@rsbuild/core'
import type { PluginManifest } from 'fh2-plugin-sdk'
import type { SdkValidationContext } from '../validate/index.js'

const RAW_DESCRIPTOR = Symbol.for('fh2-plugin-toolchain/private/raw-descriptor/v1')
const INTERNAL_STATE = Symbol.for('fh2-plugin-toolchain/private/execution-context/v1')

export interface Fh2PluginRawDescriptor {
  readonly manifestPath?: string;
  readonly pluginEntry?: string;
  readonly typesOutDir?: string;
}

export interface ResolvedPluginEntries {
  readonly plugin: string;
  readonly views: Readonly<Record<string, string>>;
}

export interface Fh2PluginExecutionContext {
  readonly candidateRoot: string;
  readonly projectRoot: string;
  readonly manifest: PluginManifest;
  readonly sdkContext: SdkValidationContext;
  readonly entries: ResolvedPluginEntries;
  readonly collect: (environmentName: string, stats: Rspack.Stats) => void;
}

type BrandedPlugin = RsbuildPlugin & {
  readonly [RAW_DESCRIPTOR]: Fh2PluginRawDescriptor;
}

interface InternalState {
  readonly executionContexts: WeakMap<RsbuildPlugin, Fh2PluginExecutionContext>;
}

const globalState = globalThis as typeof globalThis & { [INTERNAL_STATE]?: InternalState }
const internalState = globalState[INTERNAL_STATE] ?? { executionContexts: new WeakMap() }
globalState[INTERNAL_STATE] = internalState

export function brandFh2Plugin (
  plugin: RsbuildPlugin,
  descriptor: Fh2PluginRawDescriptor,
): RsbuildPlugin {
  Object.defineProperty(plugin, RAW_DESCRIPTOR, {
    configurable: false,
    enumerable: false,
    value: Object.freeze({ ...descriptor }),
    writable: false,
  })
  return plugin
}

export function getFh2PluginRawDescriptor (plugin: unknown): Fh2PluginRawDescriptor | undefined {
  if (typeof plugin !== 'object' || plugin === null || !(RAW_DESCRIPTOR in plugin)) return undefined
  return (plugin as BrandedPlugin)[RAW_DESCRIPTOR]
}

export function setFh2PluginExecutionContext (
  plugin: RsbuildPlugin,
  context: Fh2PluginExecutionContext,
): void {
  internalState.executionContexts.set(plugin, context)
}

export function clearFh2PluginExecutionContext (plugin: RsbuildPlugin): void {
  internalState.executionContexts.delete(plugin)
}

export function requireFh2PluginExecutionContext (plugin: RsbuildPlugin): Fh2PluginExecutionContext {
  const context = internalState.executionContexts.get(plugin)
  if (context === undefined) {
    throw new Error(
      'fh2Plugin() 只能由 Build Runner 执行。请使用 `fh2-plugin build`，不要直接运行 `rsbuild build`。',
    )
  }
  return context
}
