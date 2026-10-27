// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'
import {
  readBackendPluginManifest,
} from '../backend/manifest.js'
import type {
  BackendEntityDeclaration,
  BackendPluginManifest,
} from '../backend/manifest.js'

const SCRIPT_TIMEOUT_MS = 2_000
const SYSTEM_FIELDS = new Set(['id', 'tenant_id', 'created_at', 'updated_at'])

export interface BackendInvokeRequest {
  readonly pluginId: string;
  readonly handler: string;
  readonly input?: unknown;
}

export interface BackendEventRequest {
  readonly pluginId?: string;
  readonly id?: string;
  readonly type: string;
  readonly occurredAt?: string;
  readonly data?: unknown;
}

export interface BackendRuntimeSnapshot {
  readonly pluginId: string;
  readonly version: string;
  readonly entities: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  readonly plugins?: readonly BackendRuntimeSnapshot[];
}

export interface BackendDevRuntime {
  invoke(request: BackendInvokeRequest, idempotencyKey?: string): Promise<unknown>;
  dispatchEvent(request: BackendEventRequest): Promise<unknown>;
  snapshot(): BackendRuntimeSnapshot;
  reset(): BackendRuntimeSnapshot;
  reload(pluginId: string): void;
  close(): void;
}

export class BackendRuntimeError extends Error {
  constructor (
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'BackendRuntimeError'
  }
}

export class LocalBackendRuntime implements BackendDevRuntime {
  private manifest?: BackendPluginManifest
  private manifestMtime = -1
  private schemaSignature = ''
  private store?: LocalDataStore
  private readonly idempotencyResults = new Map<string, unknown>()
  private readonly eventResults = new Map<string, unknown>()
  private closed = false

  constructor (
    private readonly projectRoot: string,
    private readonly distRoot = resolve(projectRoot, 'dist'),
  ) {}

  async invoke (request: BackendInvokeRequest, idempotencyKey = ''): Promise<unknown> {
    const manifest = this.ensureLoaded()
    if (request.pluginId !== manifest.pluginId)
      throw new BackendRuntimeError('PLUGIN_NOT_FOUND', `本地后端未加载插件 ${request.pluginId}。`, 404)
    const declaration = manifest.handlers.find(handler => handler.name === request.handler)
    if (declaration === undefined)
      throw new BackendRuntimeError('HANDLER_NOT_FOUND', `Handler 不存在：${request.handler}`, 404)
    const cacheKey = idempotencyKey === '' ? '' : `${request.pluginId}:${request.handler}:${idempotencyKey}`
    if (cacheKey !== '' && this.idempotencyResults.has(cacheKey)) return clone(this.idempotencyResults.get(cacheKey))
    const result = await this.executeScript({
      path: declaration.path,
      entry: declaration.entry ?? 'handle',
      allowlist: declaration.allowlist ?? [],
      input: isRecord(request.input) ? request.input : {},
      idempotencyKey,
      scriptId: declaration.name,
    })
    if (cacheKey !== '') this.idempotencyResults.set(cacheKey, clone(result))
    return result
  }

  async dispatchEvent (request: BackendEventRequest): Promise<unknown> {
    const manifest = this.ensureLoaded()
    const declaration = manifest.events?.find(event => event.type === request.type)
    if (declaration === undefined)
      throw new BackendRuntimeError('EVENT_HANDLER_NOT_FOUND', `Event Handler 不存在：${request.type}`, 404)
    const id = request.id ?? randomUUID()
    const cacheKey = `${request.type}:${id}`
    if (this.eventResults.has(cacheKey)) return clone(this.eventResults.get(cacheKey))
    const result = await this.executeScript({
      path: declaration.handler,
      entry: declaration.entry ?? 'handle',
      allowlist: declaration.allowlist ?? [],
      input: {
        id,
        type: request.type,
        occurredAt: request.occurredAt ?? new Date().toISOString(),
        data: isRecord(request.data) ? request.data : {},
      },
      idempotencyKey: id,
      scriptId: request.type,
    })
    this.eventResults.set(cacheKey, clone(result))
    return result
  }

  snapshot (): BackendRuntimeSnapshot {
    const manifest = this.ensureLoaded()
    return {
      pluginId: manifest.pluginId,
      version: manifest.version,
      entities: this.store!.snapshot(),
    }
  }

  reset (): BackendRuntimeSnapshot {
    const manifest = this.ensureLoaded()
    this.store = new LocalDataStore(manifest.entities ?? [], this.readFixture())
    this.idempotencyResults.clear()
    this.eventResults.clear()
    return this.snapshot()
  }

  reload (_pluginId: string): void {
    // 单插件 Runtime：manifest mtime 变化时 ensureLoaded 自动重载。
  }

  close (): void {
    this.closed = true
    this.idempotencyResults.clear()
    this.eventResults.clear()
  }

  private ensureLoaded (): BackendPluginManifest {
    if (this.closed) throw new BackendRuntimeError('RUNTIME_CLOSED', '本地后端 Runtime 已关闭。', 503)
    const manifestPath = resolve(this.distRoot, 'backend/plugin.json')
    if (!existsSync(manifestPath))
      throw new BackendRuntimeError('BACKEND_DIST_MISSING', '后端构建产物不存在，请先完成 build。', 503)
    const mtime = statSync(manifestPath).mtimeMs
    if (this.manifest !== undefined && this.manifestMtime === mtime) return this.manifest
    const manifest = readBackendPluginManifest(manifestPath)
    const nextSignature = JSON.stringify(manifest.entities ?? [])
    if (this.store === undefined || nextSignature !== this.schemaSignature) {
      this.store = new LocalDataStore(manifest.entities ?? [], this.readFixture())
      this.idempotencyResults.clear()
      this.eventResults.clear()
    }
    this.manifest = manifest
    this.manifestMtime = mtime
    this.schemaSignature = nextSignature
    return manifest
  }

  private readFixture (): Readonly<Record<string, readonly Record<string, unknown>[]>> {
    const path = resolve(this.projectRoot, 'mock/fixtures/default.json')
    if (!existsSync(path)) return {}
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (!isRecord(value) || !isRecord(value.entities))
        throw new Error('fixture 必须包含 entities 对象')
      return value.entities as Readonly<Record<string, readonly Record<string, unknown>[]>>
    } catch (error) {
      throw new BackendRuntimeError('MOCK_FIXTURE_INVALID', `无法读取默认 fixture：${message(error)}`)
    }
  }

  private async executeScript (options: {
    readonly path: string;
    readonly entry: string;
    readonly allowlist: readonly string[];
    readonly input: Record<string, unknown>;
    readonly idempotencyKey: string;
    readonly scriptId: string;
  }): Promise<unknown> {
    const scriptPath = resolve(this.distRoot, 'backend', options.path)
    const source = readFileSync(scriptPath, 'utf8')
    const contextValue = this.createScriptContext(options.allowlist, options.idempotencyKey, options.scriptId)
    const sandbox: Record<string, unknown> = {
      __input: clone(options.input),
      __ctx: contextValue,
      __result: undefined,
    }
    const context = createContext(sandbox, { codeGeneration: { strings: false, wasm: false } })
    let result: unknown
    try {
      const script = new Script(
        `${source}\n;if (typeof ${options.entry} !== "function") throw new Error("入口函数不存在: ${options.entry}");`
        + `\n__result = ${options.entry}(__input, __ctx);`,
        { filename: scriptPath },
      )
      script.runInContext(context, { timeout: SCRIPT_TIMEOUT_MS })
      result = sandbox.__result
      if (isPromiseLike(result)) result = await withTimeout(result, SCRIPT_TIMEOUT_MS)
    } catch (error) {
      if (isRecord(error) && typeof error.code === 'string') {
        throw new BackendRuntimeError(error.code, typeof error.message === 'string' ? error.message : error.code)
      }
      throw new BackendRuntimeError('SCRIPT_EXECUTION_FAILED', `${options.scriptId} 执行失败：${message(error)}`, 500)
    }
    if (result === undefined) return {}
    assertJsonValue(result)
    return clone(result)
  }

  private createScriptContext (allowlist: readonly string[], idempotencyKey: string, scriptId: string): Record<string, unknown> {
    const store = this.store!
    const canRead = allowlist.includes('data:read')
    const canWrite = allowlist.includes('data:write')
    const dataStore = {
      put: (entity: string, record: unknown, options?: unknown) => canWrite
        ? store.put(entity, record, options)
        : failure('PERMISSION_DENIED', '当前入口未声明 data:write。'),
      get: (entity: string, id: string) => canRead
        ? store.get(entity, id)
        : failure('PERMISSION_DENIED', '当前入口未声明 data:read。'),
      query: (entity: string, query: unknown) => canRead
        ? store.query(entity, query)
        : failure('PERMISSION_DENIED', '当前入口未声明 data:read。'),
      delete: (entity: string, id: string, options?: unknown) => canWrite
        ? store.delete(entity, id, options)
        : failure('PERMISSION_DENIED', '当前入口未声明 data:write。'),
    }
    return Object.freeze({
      now: new Date().toISOString(),
      requestId: randomUUID(),
      idempotencyKey,
      pluginVersion: this.manifest!.version,
      scriptId,
      stableId: (scope: string) => {
        if (idempotencyKey === '') throw new BackendRuntimeError('IDEMPOTENCY_KEY_REQUIRED', 'stableId 需要 Idempotency-Key。')
        return createHash('sha256').update(`${idempotencyKey}\0${scope}`).digest('hex').slice(0, 32)
      },
      hostCapability: (name: string) => name === 'data-store' ? dataStore : undefined,
    })
  }
}

class LocalDataStore {
  private readonly declarations = new Map<string, BackendEntityDeclaration>()
  private readonly records = new Map<string, Map<string, Record<string, unknown>>>()

  constructor (
    declarations: readonly BackendEntityDeclaration[],
    fixture: Readonly<Record<string, readonly Record<string, unknown>[]>>,
  ) {
    for (const declaration of declarations) {
      this.declarations.set(declaration.name, declaration)
      const records = new Map<string, Record<string, unknown>>()
      for (const item of fixture[declaration.name] ?? []) {
        const id = typeof item.id === 'string' ? item.id : randomUUID()
        const now = new Date().toISOString()
        records.set(id, this.validateRecord(declaration, {
          ...clone(item),
          id,
          tenant_id: 'mock-tenant',
          created_at: item.created_at ?? now,
          updated_at: item.updated_at ?? now,
        }))
      }
      this.records.set(declaration.name, records)
    }
  }

  put (entityName: string, value: unknown, options: unknown): unknown {
    const declaration = this.declarations.get(entityName)
    if (declaration === undefined) return failure('UNKNOWN_ENTITY', `Entity 未声明：${entityName}`)
    if (!isRecord(value)) return failure('TYPE_MISMATCH', 'record 必须是对象。')
    const records = this.records.get(entityName)!
    const id = typeof value.id === 'string' && value.id !== '' ? value.id : randomUUID()
    const existing = records.get(id)
    if (isRecord(options) && options.upsert === false && existing !== undefined)
      return failure('DUPLICATE', `记录已存在：${id}`)
    const now = new Date().toISOString()
    let record: Record<string, unknown>
    try {
      record = this.validateRecord(declaration, {
        ...(existing ?? {}),
        ...clone(value),
        id,
        tenant_id: 'mock-tenant',
        created_at: existing?.created_at ?? now,
        updated_at: now,
      })
    } catch (error) {
      return failure(error instanceof BackendRuntimeError ? error.code : 'TYPE_MISMATCH', message(error))
    }
    records.set(id, record)
    return success(clone(record))
  }

  get (entityName: string, id: string): unknown {
    const records = this.records.get(entityName)
    if (records === undefined) return failure('UNKNOWN_ENTITY', `Entity 未声明：${entityName}`)
    const record = records.get(id)
    return record === undefined ? failure('NOT_FOUND', `记录不存在：${id}`) : success(clone(record))
  }

  query (entityName: string, value: unknown): unknown {
    const records = this.records.get(entityName)
    if (records === undefined) return failure('UNKNOWN_ENTITY', `Entity 未声明：${entityName}`)
    const query = isRecord(value) ? value : {}
    const limit = integerInRange(query.limit, 100, 1, 1000)
    const offset = integerInRange(query.offset, 0, 0, Number.MAX_SAFE_INTEGER)
    const list = [...records.values()].filter(record => matchesFilter(record, query.filter))
    if (isRecord(query.orderBy)) {
      const [field, direction] = Object.entries(query.orderBy)[0] ?? []
      if (field !== undefined) list.sort((left, right) => compare(left[field], right[field]) * (direction === 'desc' ? -1 : 1))
    }
    return success({ list: clone(list.slice(offset, offset + limit)), total: list.length, limit, offset })
  }

  delete (entityName: string, id: string, options: unknown): unknown {
    const records = this.records.get(entityName)
    if (records === undefined) return failure('UNKNOWN_ENTITY', `Entity 未声明：${entityName}`)
    const deleted = records.delete(id)
    if (!deleted && !(isRecord(options) && options.ignoreMissing === true))
      return failure('NOT_FOUND', `记录不存在：${id}`)
    return success({ deleted })
  }

  snapshot (): Readonly<Record<string, readonly Record<string, unknown>[]>> {
    return Object.fromEntries([...this.records].map(([name, records]) => [name, clone([...records.values()])]))
  }

  private validateRecord (declaration: BackendEntityDeclaration, value: Record<string, unknown>): Record<string, unknown> {
    const fields = new Map(declaration.fields.map(field => [field.name, field]))
    for (const key of Object.keys(value)) {
      if (!SYSTEM_FIELDS.has(key) && !fields.has(key))
        throw new BackendRuntimeError('UNKNOWN_FIELD', `Entity ${declaration.name} 未声明字段 ${key}。`)
    }
    for (const field of declaration.fields) {
      const fieldValue = value[field.name]
      if (field.required && (fieldValue === undefined || fieldValue === null))
        throw new BackendRuntimeError('TYPE_MISMATCH', `字段 ${field.name} 必填。`)
      if (fieldValue !== undefined && fieldValue !== null && !matchesType(field.type, fieldValue))
        throw new BackendRuntimeError('TYPE_MISMATCH', `字段 ${field.name} 期望 ${field.type}。`)
    }
    return value
  }
}

function matchesFilter (record: Record<string, unknown>, value: unknown): boolean {
  if (!isRecord(value)) return true
  return Object.entries(value).every(([field, condition]) => {
    if (!isRecord(condition)) return false
    return Object.entries(condition).every(([operator, expected]) => {
      const actual = record[field]
      switch (operator) {
        case 'eq': return actual === expected
        case 'neq': return actual !== expected
        case 'gt': return compare(actual, expected) > 0
        case 'gte': return compare(actual, expected) >= 0
        case 'lt': return compare(actual, expected) < 0
        case 'lte': return compare(actual, expected) <= 0
        case 'in': return Array.isArray(expected) && expected.includes(actual)
        case 'nin': return Array.isArray(expected) && !expected.includes(actual)
        case 'contains': return typeof actual === 'string' && actual.includes(String(expected))
        case 'startsWith': return typeof actual === 'string' && actual.startsWith(String(expected))
        case 'endsWith': return typeof actual === 'string' && actual.endsWith(String(expected))
        case 'isNull': return expected === true ? actual == null : actual != null
        case 'isNotNull': return expected === true ? actual != null : actual == null
        default: return false
      }
    })
  })
}

function compare (left: unknown, right: unknown): number {
  if (left === right) return 0
  if (typeof left === 'number' && typeof right === 'number') return left - right
  return String(left ?? '').localeCompare(String(right ?? ''))
}

function matchesType (type: BackendEntityDeclaration['fields'][number]['type'], value: unknown): boolean {
  if (type === 'string' || type === 'datetime') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'boolean') return typeof value === 'boolean'
  return value === null || typeof value === 'string' || typeof value === 'number'
    || typeof value === 'boolean' || Array.isArray(value) || isRecord(value)
}

function integerInRange (value: unknown, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : fallback
}

function success (data: unknown): { readonly ok: true; readonly data: unknown } {
  return { ok: true, data }
}

function failure (code: string, messageValue: string): { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  return { ok: false, error: { code, message: messageValue } }
}

function isRecord (value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPromiseLike (value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === 'function'
}

async function withTimeout (value: PromiseLike<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(value),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`脚本执行超过 ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function assertJsonValue (value: unknown): void {
  try {
    JSON.stringify(value)
  } catch {
    throw new BackendRuntimeError('SCRIPT_RESULT_INVALID', '脚本返回值必须是 JSON 可序列化对象。', 500)
  }
}

function clone<T> (value: T): T {
  return value === undefined ? value : structuredClone(value)
}

function message (error: unknown): string {
  if (isRecord(error) && typeof error.message === 'string') return error.message
  return error instanceof Error ? error.message : String(error)
}
