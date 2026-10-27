// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { cliDefault } from '../cli-definitions.js'
import type { CliDefinition, CliOptionDefinition } from '../cli-definitions.js'

export class CliArgumentError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'CliArgumentError'
  }
}

export interface ParsedCommandArguments {
  readonly values: Readonly<Record<string, string>>;
  readonly switches: ReadonlySet<string>;
  readonly multiple: Readonly<Record<string, readonly string[]>>;
  readonly positional: readonly string[];
  value(name: string, context?: Parameters<typeof cliDefault>[2]): string | undefined;
  flag(name: string): boolean;
}

export function parseCommandArguments (
  args: readonly string[],
  definition: CliDefinition,
): ParsedCommandArguments {
  const values: Record<string, string> = {}
  const switches = new Set<string>()
  const multiple: Record<string, string[]> = {}
  const positional: string[] = []
  const known = new Map<string, CliOptionDefinition>()
  for (const option of definition.options) {
    known.set(option.name, option)
    if (option.alias) known.set(option.alias, option)
  }
  const normalized = args.map((argument) => {
    const option = known.get(argument)
    return option?.normalizeAlias ? option.name : argument
  })
  let optionsEnabled = true
  if (definition.syntax.help === 'anywhere' && normalized.some(argument => known.get(argument)?.name === '--help')) {
    switches.add('help')
    return result()
  }

  for (let index = 0; index < normalized.length; index += 1) {
    const argument = normalized[index]!
    if (optionsEnabled && argument === '--') {
      if (definition.syntax.separator === 'ignore') continue
      if (definition.syntax.separator === 'end-options') {
        optionsEnabled = false
        continue
      }
    }
    const separator = definition.syntax.inlineValues ? argument.indexOf('=') : -1
    const rawName = argument.slice(0, separator < 0 ? undefined : separator)
    const option = optionsEnabled ? known.get(rawName) : undefined
    if (!option) {
      if (optionsEnabled && ((argument.startsWith('--') && !(argument === '--' && definition.syntax.separator === 'positional'))
        || (argument.startsWith('-') && definition.syntax.unknownShortOptions === 'reject'))) {
        throw new CliArgumentError(`未知参数：${rawName}`)
      }
      const descriptor = definition.arguments[positional.length] ?? definition.arguments.at(-1)
      if (!descriptor || (positional.length >= definition.arguments.length && !descriptor.repeatable)
        || (descriptor.leadingOnly && index !== 0) || (descriptor.values && !descriptor.values.includes(argument))) {
        throw new CliArgumentError(`不允许位置参数：${argument}`)
      }
      positional.push(argument)
      continue
    }
    const name = option.name.slice(2)
    const inlineValue = separator < 0 ? undefined : argument.slice(separator + 1)
    if (!option.repeatable && option.duplicateBehavior !== 'last-wins' && (Object.hasOwn(values, name) || switches.has(name)))
      throw new CliArgumentError(option.duplicateMessage ?? `参数不能重复：--${name}`)

    if (option.valueType === 'boolean') {
      if (inlineValue !== undefined) throw new CliArgumentError(`参数 --${name} 不接受值`)
      switches.add(name)
      if (name === 'help' && definition.syntax.help === 'immediate') return result()
      continue
    }

    const value = inlineValue ?? normalized[index + 1]
    if (value === undefined || (value === '' && !definition.syntax.allowEmptyValues)
      || (value.startsWith('--') && (inlineValue === undefined || !(option.allowInlineFlagValues ?? definition.syntax.allowInlineFlagValues)))) {
      throw new CliArgumentError(`参数 --${name} 缺少值`)
    }
    values[name] = value
    if (option.repeatable) (multiple[name] ??= []).push(value)
    if (inlineValue === undefined) index += 1
  }

  if (!switches.has('help') || definition.syntax.validateValuesOnHelp) {
    for (const option of definition.options) {
      const name = option.name.slice(2)
      if (Object.hasOwn(values, name)) {
        values[name] = parseCliOptionValue(option, values[name]!)
        if (multiple[name]) multiple[name] = multiple[name]!.map(value => parseCliOptionValue(option, value))
      }
      if ((switches.has(name) || Object.hasOwn(values, name)) && option.conflicts?.some(conflict => switches.has(conflict.slice(2)) || Object.hasOwn(values, conflict.slice(2)))) {
        throw new CliArgumentError(option.conflictMessage ?? `不能同时指定 ${option.name} 与 ${option.conflicts.join(' 或 ')}`)
      }
    }
    for (const [index, argument] of definition.arguments.entries()) {
      if (argument.required && positional[index] === undefined) throw new CliArgumentError(`缺少位置参数：${argument.name}`)
    }
  }
  return result()

  function result (): ParsedCommandArguments {
    return {
      values,
      switches,
      multiple,
      positional,
      value: (name, context) => {
        const value = values[name] ?? cliDefault(definition, name, context)
        return value === undefined ? undefined : String(value)
      },
      flag: name => !definition.options.some(option => option.negates === `--${name}` && switches.has(option.name.slice(2)))
        && (switches.has(name) || cliDefault(definition, name) === true),
    }
  }
}

/** Also used by create's interactive questions, so accepted enums/aliases have one owner. */
export function parseCliOptionValue (option: CliOptionDefinition, value: string): string {
  const canonical = option.valueAliases?.[value] ?? value
  if (option.values && !option.values.includes(canonical)) {
    throw new CliArgumentError(option.invalidValueMessage?.(value) ?? `${option.name} 只支持 ${option.values.join('、')}：${value}`)
  }
  const range = option.numericRange
  if (range && (!Number.isFinite(Number(value)) || (range.integer && !/^\d+$/.test(value)) || Number(value) < range.min || Number(value) > range.max || range.excluded?.includes(Number(value)))) {
    throw new CliArgumentError(range.excluded?.includes(Number(value)) ? `${option.name} 不接受 ${value}` : option.invalidValueMessage?.(value) ?? `${option.name} 超出接受范围：${value}`)
  }
  return canonical
}
