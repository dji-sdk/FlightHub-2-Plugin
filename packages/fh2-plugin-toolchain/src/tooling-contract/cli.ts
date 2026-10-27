// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * Machine parameter contract projected from the definitions consumed by CLI parsers/help.
 * Contexts, exit codes and operational guides are reviewed manual descriptions exported
 * by execution modules, not machine dispatch rules or approval of public maturity.
 */
import { CLI_DEFINITIONS, renderRootCliUsage } from '../cli-definitions.js'
import type { CliArgumentDefinition, CliBehaviorMetadata, CliDefinition, CliOptionDefinition } from '../cli-definitions.js'
import { CREATE_CLI_METADATA } from '../create/run.js'
import { VALIDATE_CLI_METADATA } from '../commands/validate-command.js'
import { GENERATE_CLI_METADATA } from '../commands/generate-command.js'
import { TYPES_CLI_METADATA } from '../commands/types-command.js'
import { BUILD_CLI_METADATA } from '../commands/build-command.js'
import { PACK_CLI_METADATA } from '../commands/pack-command.js'
import { SIGN_CLI_METADATA } from '../commands/sign-command.js'
import { DEV_CLI_METADATA } from '../commands/dev-command.js'
import { PREVIEW_CLI_METADATA } from '../commands/preview-command.js'
import { KNOWLEDGE_CLI_METADATA } from '../commands/knowledge-command.js'
import { SERVE_CLI_METADATA } from '../commands/serve-command.js'
import { MCP_CLI_METADATA } from '../mcp/main.js'
import { CLI_USAGE } from './usage.js'
import { deepFreeze, serializeContract } from './shared.js'

export type { CliOptionValueType } from '../cli-definitions.js'
export type CliOptionDescriptor = Omit<CliOptionDefinition, 'invalidValueMessage' | 'duplicateMessage' | 'conflictMessage'> & {
  /** Legacy display value, only emitted for literal defaults; use defaultRule for semantics. */
  readonly default?: string;
}
export type CliArgumentDescriptor = CliArgumentDefinition
export type CliExitCodeDescriptor = CliBehaviorMetadata['exitCodes'][number]

/** Human-authored operating guide checked against implementation, not a machine rule. */
export interface CliUsageDescriptor {
  readonly id: string;
  readonly summary: string;
  readonly preconditions: readonly string[];
  readonly steps: readonly string[];
  readonly limits: readonly string[];
  readonly sources: readonly string[];
}

export interface CliCommandDescriptor extends CliBehaviorMetadata {
  readonly name: string;
  readonly summary: string;
  readonly arguments: readonly CliArgumentDescriptor[];
  readonly options: readonly CliOptionDescriptor[];
  readonly syntax: CliDefinition['syntax'];
  readonly parameterSource: string;
  readonly usage?: readonly (CliUsageDescriptor & { readonly kind: 'manual-guide' })[];
}

export const TOOLING_KNOWLEDGE_PROFILE = 'developer-workflows-v1'

export interface CliContract {
  readonly schemaVersion: number;
  readonly knowledgeProfile: typeof TOOLING_KNOWLEDGE_PROFILE;
  readonly commands: readonly CliCommandDescriptor[];
}

const METADATA: Readonly<Record<string, CliBehaviorMetadata>> = {
  create: CREATE_CLI_METADATA,
  validate: VALIDATE_CLI_METADATA,
  generate: GENERATE_CLI_METADATA,
  types: TYPES_CLI_METADATA,
  build: BUILD_CLI_METADATA,
  pack: PACK_CLI_METADATA,
  sign: SIGN_CLI_METADATA,
  dev: DEV_CLI_METADATA,
  preview: PREVIEW_CLI_METADATA,
  knowledge: KNOWLEDGE_CLI_METADATA,
  serve: SERVE_CLI_METADATA,
  mcp: MCP_CLI_METADATA,
}

/** No parallel flag/default/enum inventory: only drop execution-only error formatters. */
export function projectCliCommand (definition: CliDefinition, metadata: CliBehaviorMetadata): CliCommandDescriptor {
  const usage = CLI_USAGE[definition.name]
  return {
    ...metadata,
    name: definition.name,
    summary: definition.summary,
    arguments: definition.arguments,
    options: definition.options.map(({ invalidValueMessage: _invalid, duplicateMessage: _duplicate, conflictMessage: _conflict, ...option }) => ({
      ...option,
      ...(option.defaultRule?.kind === 'literal' ? { default: String(option.defaultRule.value) } : {}),
    })),
    syntax: definition.syntax,
    parameterSource: 'src/cli-definitions.ts#CLI_DEFINITIONS',
    ...(usage ? { usage: usage.map(guide => ({ ...guide, kind: 'manual-guide' as const })) } : {}),
  }
}

export const CLI_CONTRACT: CliContract = deepFreeze({
  schemaVersion: 1,
  knowledgeProfile: TOOLING_KNOWLEDGE_PROFILE,
  commands: CLI_DEFINITIONS.map((definition) => {
    const metadata = METADATA[definition.name]
    if (!metadata) throw new Error(`CLI_CONTRACT 缺少执行说明：${definition.name}`)
    return projectCliCommand(definition, metadata)
  }),
})

export function cliCommandDescriptor (contract: CliContract, name: string): CliCommandDescriptor {
  const descriptor = contract.commands.find(command => command.name === name)
  if (!descriptor) throw new Error(`CLI_CONTRACT 缺少命令：${name}`)
  return descriptor
}

/** Root CLI loads only parameter definitions, not the exporter/execution metadata graph. */
export function renderCliUsage (contract: Pick<CliContract, 'commands'> = { commands: CLI_CONTRACT.commands }): string {
  return renderRootCliUsage(contract.commands)
}

export function serializeCliContract (contract: CliContract = CLI_CONTRACT): string {
  return serializeContract(contract)
}
