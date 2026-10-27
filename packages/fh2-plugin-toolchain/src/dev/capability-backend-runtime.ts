// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'
import { readBackendPluginContract } from '../backend/contract.js'
import type { WorkerBackendEntity, WorkerBackendPluginManifest } from '../backend/contract.js'
import { discoverBackendHandlerFiles } from '../backend/discovery.js'
import { aliasesForHandlerEntry } from '../backend/handler-names.js'
import { readSchemaFacts } from '../backend/schema-facts.js'
import { loadDeveloperRuntime } from '../developer-runtime/loader.js'
import { PROJECT_PATHS } from '../project-policy.js'
import type { BackendPluginProject } from '../capability/types.js'
import { BackendRuntimeError } from './backend-runtime.js'
import type { BackendDevRuntime, BackendEventRequest, BackendInvokeRequest, BackendRuntimeSnapshot } from './backend-runtime.js'

const SCRIPT_TIMEOUT_MS = 2_000
const SYSTEM_FIELDS = new Set(['id', 'tenant_id', 'created_at', 'updated_at'])
const QUERY_PLATFORM_FIELDS = new Set(['id', 'createdAt', 'updatedAt'])
const QUERY_OPTION_FIELDS = new Set(['limit', 'offset', 'orderBy'])
const SCRIPT_BRIDGE_PRELUDE = `
(function () {
const __bridge = __fh2Bridge;
const __meta = JSON.parse(__fh2Meta);
globalThis.__input = JSON.parse(__fh2Input);
delete globalThis.__fh2Bridge;
delete globalThis.__fh2Meta;
delete globalThis.__fh2Input;
const __decode = (value) => {
  const result = JSON.parse(value);
  if (!result.ok) throw { code: result.error.code, message: result.error.message };
  return result.data;
};
const __store = Object.freeze({
  put: (entity, record, options) => __decode(__bridge.dataPut(entity, record, options)),
  get: (entity, id) => __decode(__bridge.dataGet(entity, id)),
  query: (entity, query) => __decode(__bridge.dataQuery(entity, query)),
  delete: (entity, id, options) => __decode(__bridge.dataDelete(entity, id, options)),
});
// Worker 形状的全局 store：六方法 + {ok, data}/{ok, error} 信封，由 Handler 自行解包。
// Bundle 后的 ESM Handler（如 handlers/state/*.js）依赖这组入口。
globalThis.store = Object.freeze({
  query: (entity, filter, opts) => JSON.parse(__bridge.workerStoreQuery(entity, filter, opts)),
  count: (entity, filter) => JSON.parse(__bridge.workerStoreCount(entity, filter)),
  insert: (entity, record) => JSON.parse(__bridge.workerStoreInsert(entity, record)),
  createIfAbsent: (entity, record, uniqueBy) => JSON.parse(__bridge.workerStoreCreateIfAbsent(entity, record, uniqueBy)),
  update: (entity, filter, patch) => JSON.parse(__bridge.workerStoreUpdate(entity, filter, patch)),
  delete: (entity, filter) => JSON.parse(__bridge.workerStoreDelete(entity, filter)),
});
const __connection = Object.freeze({ get: (id) => __decode(__bridge.connectionGet(id)) });
const __provider = Object.freeze({ get: (id) => __decode(__bridge.providerGet(id)) });
globalThis.__ctx = Object.freeze({
  now: __meta.now,
  requestId: __meta.requestId,
  idempotencyKey: __meta.idempotencyKey,
  pluginVersion: __meta.pluginVersion,
  scriptId: __meta.scriptId,
  stableId: (scope) => __decode(__bridge.stableId(String(scope))),
  hostCapability: (name) => name === 'data-store' ? __store : name === 'connection' ? __connection : name === 'provider' ? __provider : undefined,
});
globalThis.__result = undefined;
})();
`

export class CapabilityBackendRuntime implements BackendDevRuntime {
  private readonly plugins = new Map<string, WorkerPluginRuntime>()
  private closed = false
  private readonly mockRoot: string

  constructor (
    private readonly capabilityRoot: string,
    projects: readonly BackendPluginProject[],
    options: { readonly mockRoot?: string } = {},
  ) {
    this.mockRoot = options.mockRoot ?? capabilityRoot
    const mocks = loadCapabilityMocks(this.mockRoot)
    for (const project of projects) {
      const runtime = new WorkerPluginRuntime(project.id, project.root, mocks)
      runtime.reload()
      this.plugins.set(project.id, runtime)
    }
  }

  async invoke (request: BackendInvokeRequest, idempotencyKey = ''): Promise<unknown> {
    this.assertOpen()
    const runtime = this.plugins.get(request.pluginId)
    if (runtime === undefined) {
      throw new BackendRuntimeError('PLUGIN_NOT_FOUND', `本地后端未加载插件 ${request.pluginId}。`, 404)
    }
    return await runtime.invoke(request, idempotencyKey)
  }

  async dispatchEvent (request: BackendEventRequest): Promise<unknown> {
    this.assertOpen()
    const runtimes = request.pluginId === undefined
      ? [...this.plugins.values()]
      : [this.requirePlugin(request.pluginId)]
    const results: unknown[] = []
    for (const runtime of runtimes) {
      const result = await runtime.dispatchEvent(request)
      if (result !== undefined) results.push(result)
    }
    if (results.length === 0) {
      throw new BackendRuntimeError('EVENT_HANDLER_NOT_FOUND', `Event Handler 不存在：${request.type}`, 404)
    }
    return results.length === 1 ? results[0] : { results }
  }

  snapshot (): BackendRuntimeSnapshot {
    this.assertOpen()
    const plugins = [...this.plugins.values()].map(runtime => runtime.snapshot())
    const entities: Record<string, readonly Record<string, unknown>[]> = {}
    for (const plugin of plugins) {
      for (const [entity, records] of Object.entries(plugin.entities)) {
        entities[`${plugin.pluginId}:${entity}`] = records
      }
    }
    return { pluginId: 'capability', version: 'local', entities, plugins }
  }

  reset (): BackendRuntimeSnapshot {
    this.assertOpen()
    for (const runtime of this.plugins.values()) runtime.reset()
    return this.snapshot()
  }

  reload (pluginId: string): void {
    this.assertOpen()
    this.requirePlugin(pluginId).reload()
  }

  async dispatchMockEvents (): Promise<void> {
    this.assertOpen()
    for (const event of loadCapabilityMocks(this.mockRoot).events) {
      if (event.pluginId !== undefined && !this.plugins.has(event.pluginId)) continue
      try {
        await this.dispatchEvent(event)
      } catch (error) {
        if (error instanceof BackendRuntimeError && error.code === 'EVENT_HANDLER_NOT_FOUND') continue
        throw error
      }
    }
  }

  close (): void {
    if (this.closed) return
    this.closed = true
    for (const runtime of this.plugins.values()) runtime.close()
  }

  private requirePlugin (pluginId: string): WorkerPluginRuntime {
    const runtime = this.plugins.get(pluginId)
    if (runtime === undefined) {
      throw new BackendRuntimeError('PLUGIN_NOT_FOUND', `本地后端未加载插件 ${pluginId}。`, 404)
    }
    return runtime
  }

  private assertOpen (): void {
    if (this.closed) throw new BackendRuntimeError('RUNTIME_CLOSED', '本地后端 Runtime 已关闭。', 503)
  }
}

class WorkerPluginRuntime {
  private manifest: WorkerBackendPluginManifest | undefined
  private manifestMtime = -1
  private schemaSignature = ''
  private uniqueIndexes: WorkerUniqueIndexes = new Map()
  private store?: WorkerDataStore
  private readonly idempotencyResults = new Map<string, unknown>()
  private readonly eventResults = new Map<string, unknown>()
  private closed = false

  constructor (
    readonly pluginId: string,
    private readonly projectRoot: string,
    private readonly mocks: CapabilityMockInputs,
    private readonly distRoot = resolve(projectRoot, 'dist'),
  ) {}

  async invoke (request: BackendInvokeRequest, idempotencyKey: string): Promise<unknown> {
    const manifest = this.ensureLoaded()
    if (request.pluginId !== manifest.pluginId) {
      throw new BackendRuntimeError('PLUGIN_NOT_FOUND', `本地后端未加载插件 ${request.pluginId}。`, 404)
    }
    const handler = this.resolveHandler(request.handler)
    if (handler === undefined) {
      throw new BackendRuntimeError('HANDLER_NOT_FOUND', `Handler 不存在：${request.handler}`, 404)
    }
    const cacheKey = idempotencyKey === '' ? '' : `${request.pluginId}:${request.handler}:${idempotencyKey}`
    if (cacheKey !== '' && this.idempotencyResults.has(cacheKey)) return clone(this.idempotencyResults.get(cacheKey))
    const result = await this.executeScript({
      ...handler,
      input: isRecord(request.input) ? request.input : {},
      idempotencyKey,
      scriptId: request.handler,
    })
    if (cacheKey !== '') this.idempotencyResults.set(cacheKey, clone(result))
    return result
  }

  async dispatchEvent (request: BackendEventRequest): Promise<unknown | undefined> {
    const manifest = this.ensureLoaded()
    const matching = (manifest.events ?? []).filter(event => event.type === request.type && eventMatches(event.match, request))
    if (matching.length === 0) return undefined
    const id = request.id ?? randomUUID()
    const cacheKey = `${request.type}:${id}`
    if (this.eventResults.has(cacheKey)) return clone(this.eventResults.get(cacheKey))
    const results: unknown[] = []
    for (const event of matching) {
      for (const consumer of event.consumer) {
        const entry = consumer.entry ?? 'handle'
        const path = this.resolveDeclaredScript(consumer.handler, entry)
        const result = await this.executeScript({
          path,
          entry,
          allowlist: manifest.allowlist ?? [],
          input: {
            id,
            type: request.type,
            occurredAt: request.occurredAt ?? new Date().toISOString(),
            data: isRecord(request.data) ? request.data : {},
          },
          idempotencyKey: id,
          scriptId: `${request.type}:${entry}`,
        })
        results.push(result)
      }
    }
    const value = results.length === 1 ? results[0] : { results }
    this.eventResults.set(cacheKey, clone(value))
    return value
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
    this.store = new WorkerDataStore(manifest.entities ?? [], this.mocks.fixture, this.uniqueIndexes)
    this.idempotencyResults.clear()
    this.eventResults.clear()
    return this.snapshot()
  }

  reload (): void {
    this.manifest = undefined
    this.manifestMtime = -1
    this.ensureLoaded()
  }

  close (): void {
    this.closed = true
    this.idempotencyResults.clear()
    this.eventResults.clear()
  }

  private ensureLoaded (): WorkerBackendPluginManifest {
    if (this.closed) throw new BackendRuntimeError('RUNTIME_CLOSED', '本地后端 Runtime 已关闭。', 503)
    const manifestPath = resolve(this.distRoot, 'plugin.json')
    if (!existsSync(manifestPath)) {
      throw new BackendRuntimeError('BACKEND_DIST_MISSING', `后端构建产物不存在：${this.pluginId}`, 503)
    }
    const mtime = statSync(manifestPath).mtimeMs
    if (this.manifest !== undefined && this.manifestMtime === mtime) return this.manifest
    const manifest = readBackendPluginContract(this.distRoot)
    if (manifest.pluginId !== this.pluginId) {
      throw new BackendRuntimeError('PLUGIN_ID_MISMATCH', `后端目录 ${this.pluginId} 与 plugin.json.pluginId ${manifest.pluginId} 不一致。`, 500)
    }
    const nextUniqueIndexes = readWorkerUniqueIndexes(this.distRoot, manifest.entities ?? [])
    const nextSignature = JSON.stringify({
      entities: manifest.entities ?? [],
      uniqueIndexes: [...nextUniqueIndexes].map(([entity, indexes]) => [
        entity,
        indexes.map(index => [...index].sort()),
      ]),
    })
    if (this.store === undefined || nextSignature !== this.schemaSignature) {
      this.uniqueIndexes = nextUniqueIndexes
      this.store = new WorkerDataStore(manifest.entities ?? [], this.mocks.fixture, nextUniqueIndexes)
      this.idempotencyResults.clear()
      this.eventResults.clear()
    }
    this.manifest = manifest
    this.manifestMtime = mtime
    this.schemaSignature = nextSignature
    return manifest
  }

  private resolveHandler (handler: string): ScriptTarget | undefined {
    const manifest = this.ensureLoaded()
    const claimedEntries = new Set<string>()
    for (const script of manifest.scripts ?? []) {
      if (script.entry !== undefined) claimedEntries.add(script.entry)
    }
    for (const event of manifest.events ?? []) {
      for (const consumer of event.consumer) {
        if (consumer.entry !== undefined) claimedEntries.add(consumer.entry)
      }
    }
    for (const file of discoverBackendHandlerFiles(this.distRoot)) {
      const source = this.readScript(file.path)
      const entries = topLevelFunctionNames(source).filter(name => name.startsWith('h_'))
      if (entries.length > 0) {
        const entry = entries.find(name => name === handler || aliasesForHandlerEntry(name).includes(handler))
        if (entry !== undefined && !claimedEntries.has(entry)) {
          return { path: file.path, entry, allowlist: manifest.allowlist ?? [] }
        }
        continue
      }
      if (file.kind === 'source' && file.name === handler) {
        return { path: file.path, entry: 'handle', allowlist: manifest.allowlist ?? [] }
      }
    }
    return undefined
  }

  private resolveDeclaredScript (declaredPath: string | undefined, entry: string): string {
    if (declaredPath !== undefined && existsSync(resolve(this.distRoot, declaredPath))) return declaredPath
    for (const file of discoverBackendHandlerFiles(this.distRoot)) {
      if (file.kind === 'packed' && topLevelFunctionNames(this.readScript(file.path)).includes(entry)) return file.path
    }
    throw new BackendRuntimeError('SCRIPT_NOT_FOUND', `脚本入口不存在：${entry}`, 404)
  }

  private readScript (path: string): string {
    try {
      return readFileSync(resolve(this.distRoot, path), 'utf8')
    } catch (error) {
      throw new BackendRuntimeError('SCRIPT_NOT_FOUND', `脚本不存在：${path}（${message(error)}）`, 404)
    }
  }

  private async executeScript (options: ScriptTarget & {
    readonly input: Record<string, unknown>;
    readonly idempotencyKey: string;
    readonly scriptId: string;
  }): Promise<unknown> {
    const source = this.readScript(options.path)
    const sandbox: Record<string, unknown> = {
      __fh2Bridge: this.createScriptBridge(options.allowlist, options.idempotencyKey),
      __fh2Meta: JSON.stringify({
        now: new Date().toISOString(),
        requestId: randomUUID(),
        idempotencyKey: options.idempotencyKey,
        pluginVersion: this.manifest!.version,
        scriptId: options.scriptId,
      }),
      __fh2Input: JSON.stringify(options.input),
      __done: false,
      __error: undefined,
    }
    const context = createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
      microtaskMode: 'afterEvaluate',
    })
    let result: unknown
    try {
      new Script(SCRIPT_BRIDGE_PRELUDE, { filename: `${resolve(this.distRoot, options.path)}:bridge` }).runInContext(context, { timeout: SCRIPT_TIMEOUT_MS })
      const script = new Script(
        `${source}\n;if (typeof ${options.entry} !== "function") throw new Error("入口函数不存在: ${options.entry}");`
        + `\n__result = ${options.entry}(__input, __ctx);`
        + `\nif (__result && typeof __result.then === "function") {`
        + `\n  Promise.resolve(__result).then(value => { __result = value; __done = true; }, error => { __error = error; __done = true; });`
        + `\n} else { __done = true; }`,
        { filename: resolve(this.distRoot, options.path) },
      )
      script.runInContext(context, { timeout: SCRIPT_TIMEOUT_MS })
      await settleAsyncResult(context, sandbox)
      if (sandbox.__error !== undefined) throw sandbox.__error
      result = sandbox.__result
    } catch (error) {
      if (isRecord(error) && typeof error.code === 'string') {
        throw new BackendRuntimeError(
          error.code,
          typeof error.message === 'string' ? error.message : error.code,
          httpStatusForBusinessCode(error.code),
        )
      }
      throw new BackendRuntimeError('SCRIPT_EXECUTION_FAILED', `${options.scriptId} 执行失败：${message(error)}`, 500)
    }
    if (result === undefined) return {}
    assertJsonValue(result)
    return clone(result)
  }

  private createScriptBridge (allowlist: readonly string[], idempotencyKey: string): Record<string, unknown> {
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
    const readDenied = () => {
      throw new BackendRuntimeError('PERMISSION_DENIED', '当前入口未声明 data:read。')
    }
    const writeDenied = () => {
      throw new BackendRuntimeError('PERMISSION_DENIED', '当前入口未声明 data:write。')
    }
    return Object.freeze({
      dataPut: (entity: string, record: unknown, options: unknown) => bridgeResult(() => canWrite
        ? dataStore.put(entity, clone(record), clone(options))
        : failure('PERMISSION_DENIED', '当前入口未声明 data:write。')),
      dataGet: (entity: string, id: string) => bridgeResult(() => canRead
        ? dataStore.get(entity, id)
        : failure('PERMISSION_DENIED', '当前入口未声明 data:read。')),
      dataQuery: (entity: string, query: unknown) => bridgeResult(() => canRead
        ? dataStore.query(entity, clone(query))
        : failure('PERMISSION_DENIED', '当前入口未声明 data:read。')),
      dataDelete: (entity: string, id: string, options: unknown) => bridgeResult(() => canWrite
        ? dataStore.delete(entity, id, clone(options))
        : failure('PERMISSION_DENIED', '当前入口未声明 data:write。')),
      workerStoreQuery: (entity: string, filter: unknown, opts: unknown) => bridgeResult(() => canRead
        ? store.workerQuery(entity, clone(filter), clone(opts))
        : readDenied()),
      workerStoreCount: (entity: string, filter: unknown) => bridgeResult(() => canRead
        ? store.workerCount(entity, clone(filter))
        : readDenied()),
      workerStoreInsert: (entity: string, record: unknown) => bridgeResult(() => canWrite
        ? store.workerInsert(entity, clone(record))
        : writeDenied()),
      workerStoreCreateIfAbsent: (entity: string, record: unknown, uniqueBy: unknown) => bridgeResult(() => canWrite
        ? store.workerCreateIfAbsent(entity, clone(record), clone(uniqueBy))
        : writeDenied()),
      workerStoreUpdate: (entity: string, filter: unknown, patch: unknown) => bridgeResult(() => canWrite
        ? store.workerUpdate(entity, clone(filter), clone(patch))
        : writeDenied()),
      workerStoreDelete: (entity: string, filter: unknown) => bridgeResult(() => canWrite
        ? store.workerDelete(entity, clone(filter))
        : writeDenied()),
      connectionGet: (id: string) => bridgeResult(() => clone(this.mocks.connections[id]) ?? null),
      providerGet: (id: string) => bridgeResult(() => clone(this.mocks.providers[id]) ?? null),
      stableId: (scope: string) => bridgeResult(() => {
        if (idempotencyKey === '') throw new BackendRuntimeError('IDEMPOTENCY_KEY_REQUIRED', 'stableId 需要 Idempotency-Key。')
        return createHash('sha256').update(`${idempotencyKey}\0${scope}`).digest('hex').slice(0, 32)
      }),
    })
  }
}

interface ScriptTarget {
  readonly path: string;
  readonly entry: string;
  readonly allowlist: readonly string[];
}

interface CapabilityMockInputs {
  readonly fixture: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  readonly connections: Readonly<Record<string, unknown>>;
  readonly providers: Readonly<Record<string, unknown>>;
  readonly events: readonly BackendEventRequest[];
}

function loadCapabilityMocks (capabilityRoot: string): CapabilityMockInputs {
  const fixturePath = resolve(capabilityRoot, 'mock/fixtures/default.json')
  const connectionPath = resolve(capabilityRoot, 'mock/connections.json')
  const fixture = readMockRecord(fixturePath, 'MOCK_FIXTURE_INVALID')
  const connectionDocument = readMockRecord(connectionPath, 'MOCK_CONNECTIONS_INVALID')
  const providers = readMockDirectory(resolve(capabilityRoot, 'mock/providers'), 'MOCK_PROVIDERS_INVALID')
  const events = readMockEvents(resolve(capabilityRoot, 'mock/events'))
  return Object.freeze({
    fixture: isRecord(fixture.entities)
      ? fixture.entities as Readonly<Record<string, readonly Record<string, unknown>[]>>
      : {},
    connections: isRecord(connectionDocument.connections)
      ? connectionDocument.connections
      : {},
    providers,
    events,
  })
}

function readMockRecord (path: string, code: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!isRecord(value)) throw new Error('文件必须是 JSON 对象')
    return value
  } catch (error) {
    throw new BackendRuntimeError(code, `无法读取 Mock 文件：${message(error)}`)
  }
}

function readMockDirectory (directory: string, code: string): Readonly<Record<string, unknown>> {
  if (!existsSync(directory)) return {}
  const providers: Record<string, unknown> = {}
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const name = entry.name.slice(0, -'.json'.length)
    providers[name] = readMockRecord(resolve(directory, entry.name), code)
  }
  return providers
}

function readMockEvents (directory: string): readonly BackendEventRequest[] {
  if (!existsSync(directory)) return []
  const events: BackendEventRequest[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const value = readMockRecord(resolve(directory, entry.name), 'MOCK_EVENTS_INVALID')
    if (typeof value.type !== 'string' || value.type === '') {
      throw new BackendRuntimeError('MOCK_EVENTS_INVALID', `Mock Event 缺少 type：${entry.name}`)
    }
    events.push({
      ...(typeof value.pluginId === 'string' ? { pluginId: value.pluginId } : {}),
      ...(typeof value.id === 'string' ? { id: value.id } : {}),
      type: value.type,
      ...(typeof value.occurredAt === 'string' ? { occurredAt: value.occurredAt } : {}),
      ...(isRecord(value.data) ? { data: value.data } : {}),
    })
  }
  return events
}

class WorkerDataStore {
  private readonly declarations = new Map<string, WorkerBackendEntity>()
  private readonly records = new Map<string, Map<string, Record<string, unknown>>>()
  private readonly policy: StoreRuntimePolicy
  private readonly uniqueIndexes: WorkerUniqueIndexes

  constructor (
    declarations: readonly WorkerBackendEntity[],
    fixture: Readonly<Record<string, readonly Record<string, unknown>[]>>,
    uniqueIndexes: WorkerUniqueIndexes = manifestUniqueIndexes(declarations),
  ) {
    // 模拟器只消费随工具链交付的同版 runtime policy，不在本地复制 3/32 这类限额。
    const hostApi = loadDeveloperRuntime().resources.files['backend/catalog/host-api.json'] as {
      store: StoreRuntimePolicy;
    }
    this.policy = hostApi.store
    this.uniqueIndexes = uniqueIndexes
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
    try {
      const record = this.validateRecord(declaration, {
        ...(existing ?? {}),
        ...clone(value),
        id,
        tenant_id: 'mock-tenant',
        created_at: existing?.created_at ?? now,
        updated_at: now,
      })
      records.set(id, record)
      return success(clone(record))
    } catch (error) {
      return failure(error instanceof BackendRuntimeError ? error.code : 'TYPE_MISMATCH', message(error))
    }
  }

  get (entityName: string, id: string): unknown {
    const record = this.records.get(entityName)?.get(id)
    return record === undefined
      ? failure('NOT_FOUND', `记录不存在：${id}`)
      : success(clone(record))
  }

  query (entityName: string, value: unknown): unknown {
    const records = this.records.get(entityName)
    if (records === undefined) return failure('UNKNOWN_ENTITY', `Entity 未声明：${entityName}`)
    const query = isRecord(value) ? value : {}
    const limit = integerInRange(query.limit, 100, 1, 1000)
    const offset = integerInRange(query.offset, 0, 0, Number.MAX_SAFE_INTEGER)
    const list = [...records.values()].filter(record => matchesFilter(record, query.filter))
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

  // ── Worker 形状（六方法，与真实 Worker store 契约一致）──────────────────
  // 注意：这里返回裸数据、错误直接 throw；{ok,data}/{ok,error} 信封由 bridgeResult 统一包裹。

  workerQuery (entityName: string, filter: unknown, opts: unknown): { list: Record<string, unknown>[]; total: number; limit: number; offset: number } {
    const records = this.requireRecords(entityName)
    const declaration = this.requireDeclaration(entityName)
    if (opts !== undefined && !isRecord(opts)) throw new BackendRuntimeError('INVALID_FILTER', 'options 必须是对象。')
    const options = isRecord(opts) ? opts : {}
    assertWorkerFilter(filter, declaration, this.policy)
    assertWorkerQueryOptions(options, this.policy)
    const limit = options.limit ?? this.policy.driver.defaultQueryLimit
    const offset = options.offset ?? 0
    const list = [...records.values()].map(workerRecordView).filter(record => matchesFilter(record, filter))
    applyWorkerOrderBy(list, options.orderBy, declaration, this.policy)
    return { list: clone(list.slice(Number(offset), Number(offset) + Number(limit))), total: list.length, limit: Number(limit), offset: Number(offset) }
  }

  workerCount (entityName: string, filter: unknown): { count: number } {
    const records = this.requireRecords(entityName)
    assertWorkerFilter(filter, this.requireDeclaration(entityName), this.policy)
    return { count: [...records.values()].filter(record => matchesFilter(workerRecordView(record), filter)).length }
  }

  workerInsert (entityName: string, value: unknown): Record<string, unknown> {
    const { record, id } = this.prepareWorkerInsert(entityName, value)
    if (this.records.get(entityName)!.has(id)) throw new BackendRuntimeError('DUPLICATE', `记录已存在：${id}`)
    this.records.get(entityName)!.set(id, record)
    return workerRecordView(record)
  }

  private prepareWorkerInsert (entityName: string, value: unknown): {
    readonly record: Record<string, unknown>;
    readonly id: string;
  } {
    const declaration = this.requireDeclaration(entityName)
    if (!isRecord(value) || Object.keys(value).length === 0) throw new BackendRuntimeError('TYPE_MISMATCH', 'record 必须是非空对象。')
    const now = new Date().toISOString()
    const id = typeof value.id === 'string' && value.id !== '' ? value.id : randomUUID()
    const record = this.validateRecord(declaration, {
      ...clone(value),
      id,
      tenant_id: 'mock-tenant',
      created_at: now,
      updated_at: now,
    })
    return { record, id }
  }

  workerCreateIfAbsent (entityName: string, value: unknown, uniqueBy: unknown): { created: boolean; record: Record<string, unknown> } {
    const declaration = this.requireDeclaration(entityName)
    const prepared = this.prepareWorkerInsert(entityName, value)
    if (uniqueBy === undefined || uniqueBy === null) {
      throw new BackendRuntimeError('EMPTY_FILTER', 'createIfAbsent 需要唯一索引字段数组。')
    }
    if (!Array.isArray(uniqueBy)) throw new BackendRuntimeError('INVALID_FILTER', 'uniqueBy 必须是字符串数组。')
    if (uniqueBy.length === 0) throw new BackendRuntimeError('EMPTY_FILTER', 'createIfAbsent 需要唯一索引字段数组。')
    if (uniqueBy.some(field => typeof field !== 'string' || field === '')) {
      throw new BackendRuntimeError('INVALID_FILTER', 'uniqueBy 必须是非空字符串数组。')
    }
    if (uniqueBy.length > this.policy.facade.maxUniqueByFields) {
      throw new BackendRuntimeError('LIMIT_EXCEEDED', 'uniqueBy 字段数超过契约限额。')
    }
    const fields = uniqueBy as readonly string[]
    const seen = new Set<string>()
    for (const field of fields) {
      if (!(field in declaration.fields) || seen.has(field)) {
        throw new BackendRuntimeError('UNKNOWN_FIELD', `uniqueBy 字段未声明或重复：${field}`)
      }
      seen.add(field)
      if (prepared.record[field] === undefined || prepared.record[field] === null) {
        throw new BackendRuntimeError('INVALID_FILTER', `uniqueBy 字段 ${field} 不能为空。`)
      }
    }
    const physicalFields = fields.map(physicalFieldName).sort()
    const indexes = this.uniqueIndexes.get(entityName) ?? []
    if (!indexes.some(index => index.length === physicalFields.length && [...index].sort().every((column, position) => column === physicalFields[position]))) {
      throw new BackendRuntimeError('STORAGE_ERROR', 'uniqueBy 未匹配 schema.sql 中的唯一索引。', 500)
    }
    const records = this.records.get(entityName)!
    for (const existing of records.values()) {
      if (fields.every(field => existing[field] === prepared.record[field])) {
        return { created: false, record: workerRecordView(existing) }
      }
    }
    // 主键冲突不在 ON CONFLICT (<uniqueBy>) 的仲裁索引里：不同 unique 值复用已有 id
    // 仍按 Insert 撞主键处理，不能被 createIfAbsent 吞掉。
    if (records.has(prepared.id)) throw new BackendRuntimeError('DUPLICATE', `记录已存在：${prepared.id}`)
    records.set(prepared.id, prepared.record)
    return { created: true, record: workerRecordView(prepared.record) }
  }

  /** 条件更新：状态/版本判据进 filter，affected 计数返回。 */
  workerUpdate (entityName: string, filter: unknown, patch: unknown): { affected: number } {
    const declaration = this.requireDeclaration(entityName)
    const patchRecord = this.validateWorkerPatch(declaration, patch)
    assertWorkerFilter(filter, declaration, this.policy, true)
    const records = this.records.get(entityName)!
    let affected = 0
    const now = new Date().toISOString()
    for (const [key, record] of records) {
      if (!matchesFilter(workerRecordView(record), filter)) continue
      records.set(key, this.validateRecord(declaration, {
        ...record,
        ...clone(patchRecord),
        id: record.id,
        tenant_id: record.tenant_id,
        created_at: record.created_at,
        updated_at: now,
      }))
      affected += 1
    }
    return { affected }
  }

  /** 条件删除：删除数量返回。 */
  workerDelete (entityName: string, filter: unknown): { deleted: number } {
    const records = this.requireRecords(entityName)
    assertWorkerFilter(filter, this.requireDeclaration(entityName), this.policy, true)
    let deleted = 0
    for (const [key, record] of records) {
      if (!matchesFilter(workerRecordView(record), filter)) continue
      records.delete(key)
      deleted += 1
    }
    return { deleted }
  }

  private requireRecords (entityName: string): Map<string, Record<string, unknown>> {
    const records = this.records.get(entityName)
    if (records === undefined) {
      throw new BackendRuntimeError('UNKNOWN_ENTITY', `Entity 未声明：${entityName}`)
    }
    return records
  }

  private requireDeclaration (entityName: string): WorkerBackendEntity {
    const declaration = this.declarations.get(entityName)
    if (declaration === undefined) {
      throw new BackendRuntimeError('UNKNOWN_ENTITY', `Entity 未声明：${entityName}`)
    }
    return declaration
  }

  snapshot (): Readonly<Record<string, readonly Record<string, unknown>[]>> {
    return Object.fromEntries([...this.records].map(([name, records]) => [name, clone([...records.values()])]))
  }

  private validateRecord (declaration: WorkerBackendEntity, value: Record<string, unknown>): Record<string, unknown> {
    for (const key of Object.keys(value)) {
      if (!SYSTEM_FIELDS.has(key) && !(key in declaration.fields))
        throw new BackendRuntimeError('UNKNOWN_FIELD', `Entity ${declaration.name} 未声明字段 ${key}。`)
    }
    for (const [name, field] of Object.entries(declaration.fields)) {
      const fieldValue = value[name]
      if (fieldValue !== undefined && fieldValue !== null && !matchesType(field.type, fieldValue))
        throw new BackendRuntimeError('TYPE_MISMATCH', `字段 ${name} 期望 ${field.type}。`)
    }
    return value
  }

  private validateWorkerPatch (declaration: WorkerBackendEntity, patch: unknown): Record<string, unknown> {
    if (!isRecord(patch) || Object.keys(patch).length === 0) {
      throw new BackendRuntimeError('TYPE_MISMATCH', 'patch 必须是非空对象。')
    }
    if (Object.keys(patch).some(field => SYSTEM_FIELDS.has(field) || ['createdAt', 'updatedAt'].includes(field))) {
      throw new BackendRuntimeError('UNKNOWN_FIELD', '不能修改平台维护的字段。')
    }
    return this.validateRecord(declaration, clone(patch))
  }
}

interface StoreRuntimePolicy {
  readonly driver: {
    readonly defaultQueryLimit: number;
    readonly maxQueryLimit: number;
    readonly maxQueryOffset: number;
    readonly maxOrderByFields: number;
    readonly maxFilterItems: number;
    readonly maxFilterArguments: number;
  };
  readonly facade: {
    readonly filterOperators: readonly string[];
    readonly maxUniqueByFields: number;
    readonly maxFilterConditions: number;
  };
}

type WorkerUniqueIndexes = ReadonlyMap<string, readonly string[][]>

function eventMatches (match: Readonly<Record<string, string>> | undefined, request: BackendEventRequest): boolean {
  if (match === undefined) return true
  const data = isRecord(request.data) ? request.data : {}
  const event: Record<string, unknown> = {
    id: request.id ?? '',
    type: request.type,
    occurredAt: request.occurredAt ?? '',
    ...data,
  }
  return Object.entries(match).every(([key, value]) => String(event[key] ?? '') === value)
}

/** 与 Worker recordView 一致：业务字段加公开平台列，不暴露存储内部列。 */
function workerRecordView (record: Record<string, unknown>): Record<string, unknown> {
  const { tenant_id: _tenant, created_at: createdAt, updated_at: updatedAt, ...fields } = record
  return clone({ ...fields, createdAt, updatedAt })
}

function assertWorkerFilter (
  filter: unknown,
  declaration: WorkerBackendEntity,
  policy: StoreRuntimePolicy,
  required = false,
): void {
  if (filter === undefined && !required) return
  if (!isRecord(filter)) throw new BackendRuntimeError('INVALID_FILTER', 'filter 必须是对象。')
  if (required && Object.keys(filter).length === 0) throw new BackendRuntimeError('EMPTY_FILTER', '写操作不能使用空 filter。')
  const conditionCounts = new Map<string, number>()
  let conditionCount = 0
  let argumentCount = 0
  for (const [field, condition] of Object.entries(filter)) {
    const fieldDeclared = field in declaration.fields || QUERY_PLATFORM_FIELDS.has(field)
    const conditions = Array.isArray(condition) ? condition : [condition]
    if (conditions.length === 0) throw new BackendRuntimeError('INVALID_FILTER', '筛选条件不能为空。')
    for (const item of conditions) {
      if (!isRecord(item) || Object.keys(item).length === 0) {
        throw new BackendRuntimeError('INVALID_FILTER', '筛选条件必须是算子对象。')
      }
      if (Array.isArray(condition) && Object.keys(item).length !== 1) {
        throw new BackendRuntimeError('INVALID_FILTER', '数组筛选条件每项只能有一个算子。')
      }
      for (const [operator, expected] of Object.entries(item)) {
        if (!policy.facade.filterOperators.includes(operator)) {
          throw new BackendRuntimeError('INVALID_FILTER', `不支持的筛选算子：${operator}`)
        }
        conditionCount += 1
        if (conditionCount > policy.facade.maxFilterConditions) {
          throw new BackendRuntimeError('LIMIT_EXCEEDED', '筛选条件数超过契约限额。')
        }
        const conditionKey = `${field}\0${operator}`
        conditionCounts.set(conditionKey, (conditionCounts.get(conditionKey) ?? 0) + 1)
        if (operator === 'isNull' || operator === 'isNotNull') continue
        if (expected === undefined || expected === null) {
          throw new BackendRuntimeError('INVALID_FILTER', `${operator} 条件不能为空。`)
        }
        if (operator === 'contains' || operator === 'startsWith' || operator === 'endsWith') {
          if (typeof expected !== 'string') throw new BackendRuntimeError('TYPE_MISMATCH', `${operator} 条件必须是字符串。`)
          argumentCount += 1
          continue
        }
        if (operator === 'in' || operator === 'nin') {
          if (!Array.isArray(expected) || expected.length === 0 || expected.length > policy.driver.maxFilterItems) {
            throw new BackendRuntimeError('INVALID_FILTER', `${operator} 条件必须是非空数组且不超过契约限额。`)
          }
          if (expected.some(value => value === undefined || value === null)) {
            throw new BackendRuntimeError('INVALID_FILTER', `${operator} 条件不能包含空值。`)
          }
          argumentCount += expected.length
        } else {
          argumentCount += 1
        }
        if (argumentCount > policy.driver.maxFilterArguments) {
          throw new BackendRuntimeError('LIMIT_EXCEEDED', '筛选参数数量超过契约限额。')
        }
      }
    }
    if (!fieldDeclared) throw new BackendRuntimeError('UNKNOWN_FIELD', `筛选字段未声明：${field}`)
  }
  for (const [conditionKey, count] of conditionCounts) {
    if (count > 1) {
      const [field, operator] = conditionKey.split('\0')
      throw new BackendRuntimeError('INVALID_FILTER', `筛选条件重复：${field} ${operator}`)
    }
  }
}

function assertWorkerQueryOptions (options: Record<string, unknown>, policy: StoreRuntimePolicy): void {
  for (const key of Object.keys(options)) {
    if (!QUERY_OPTION_FIELDS.has(key)) throw new BackendRuntimeError('INVALID_FILTER', `不支持的查询选项：${key}`)
  }
  const limit = options.limit ?? policy.driver.defaultQueryLimit
  const offset = options.offset ?? 0
  if (!Number.isInteger(limit) || Number(limit) < 1) throw new BackendRuntimeError('INVALID_FILTER', 'limit 必须是正整数。')
  if (Number(limit) > policy.driver.maxQueryLimit) throw new BackendRuntimeError('LIMIT_EXCEEDED', '查询条数超过契约限额。')
  if (!Number.isInteger(offset) || Number(offset) < 0 || Number(offset) > policy.driver.maxQueryOffset) {
    throw new BackendRuntimeError('INVALID_FILTER', 'offset 不合法。')
  }
}

/** SDK 支持 field/dir 和 keyed 两种对象式排序；最后用 id 保持同值记录顺序。 */
function applyWorkerOrderBy (
  list: Record<string, unknown>[],
  orderBy: unknown,
  declaration: WorkerBackendEntity,
  policy: StoreRuntimePolicy,
): void {
  if (orderBy !== undefined && !Array.isArray(orderBy)) {
    throw new BackendRuntimeError('INVALID_FILTER', 'orderBy 必须是对象数组。')
  }
  const orders: Array<{ field: string; direction: 'asc' | 'desc' }> = []
  const seenFields = new Set<string>()
  for (const rule of orderBy ?? []) {
    if (!isRecord(rule)) throw new BackendRuntimeError('INVALID_FILTER', 'orderBy 只接受对象式排序。')
    let entries: readonly (readonly [string, unknown])[]
    if (Object.hasOwn(rule, 'field')) {
      if (typeof rule.field !== 'string' || rule.field === '') {
        throw new BackendRuntimeError('INVALID_FILTER', 'orderBy.field 必须是非空字符串。')
      }
      if (rule.dir !== undefined && typeof rule.dir !== 'string') {
        throw new BackendRuntimeError('INVALID_FILTER', 'orderBy.dir 必须是字符串。')
      }
      entries = [[rule.field, rule.dir]]
    } else {
      entries = Object.entries(rule)
      if (entries.length !== 1) throw new BackendRuntimeError('INVALID_FILTER', 'keyed orderBy 只能包含一个字段。')
    }
    for (const [field, rawDirection] of entries) {
      if (!(field in declaration.fields) && !QUERY_PLATFORM_FIELDS.has(field)) {
        throw new BackendRuntimeError('UNKNOWN_FIELD', `排序字段未声明：${field}`)
      }
      if (seenFields.has(field)) throw new BackendRuntimeError('INVALID_FILTER', `排序字段重复：${field}`)
      seenFields.add(field)
      const direction = typeof rawDirection === 'string' ? rawDirection.trim().toLowerCase() : rawDirection
      if (direction !== undefined && direction !== '' && direction !== 'asc' && direction !== 'desc') {
        throw new BackendRuntimeError('INVALID_FILTER', '排序方向只能是 asc 或 desc。')
      }
      orders.push({ field, direction: direction === undefined || direction === '' ? 'asc' : direction })
    }
  }
  if (orders.length > policy.driver.maxOrderByFields) {
    throw new BackendRuntimeError('INVALID_FILTER', '排序字段数超过契约限额。')
  }
  if (!orders.some(order => order.field === 'id')) orders.push({ field: 'id', direction: 'asc' })
  list.sort((left, right) => {
    for (const { field, direction } of orders) {
      const a = left[field]
      const b = right[field]
      const compared = typeof a === 'number' && typeof b === 'number'
        ? a - b
        : String(a ?? '').localeCompare(String(b ?? ''))
      if (compared !== 0) return direction === 'desc' ? -compared : compared
    }
    return 0
  })
}

function readWorkerUniqueIndexes (distRoot: string, declarations: readonly WorkerBackendEntity[]): WorkerUniqueIndexes {
  if (!existsSync(resolve(distRoot, PROJECT_PATHS.schemaSql))) return manifestUniqueIndexes(declarations)
  const facts = readSchemaFacts(distRoot)
  const entitiesByName = new Map(facts.entities.map(entity => [entity.name, entity]))
  const indexes = new Map<string, string[][]>()
  for (const declaration of declarations) {
    const entity = entitiesByName.get(declaration.name)
    if (entity === undefined) continue
    const fields = new Set(entity.fields.map(field => field.name))
    const entityIndexes: string[][] = []
    for (const field of entity.fields) {
      if (field.unique) entityIndexes.push([field.name])
    }
    for (const index of facts.indexes) {
      if (!index.unique || index.predicate !== undefined || index.tableName !== entity.tableName) continue
      const columns = index.columns.map(column => column.name)
      if (columns.length > 0 && columns.every(column => fields.has(column))) entityIndexes.push(columns)
    }
    indexes.set(declaration.name, entityIndexes)
  }
  return indexes
}

function manifestUniqueIndexes (declarations: readonly WorkerBackendEntity[]): WorkerUniqueIndexes {
  const indexes = new Map<string, string[][]>()
  for (const declaration of declarations) {
    const entityIndexes: string[][] = []
    for (const [field, definition] of Object.entries(declaration.fields)) {
      if (definition.unique) entityIndexes.push([physicalFieldName(field)])
    }
    indexes.set(declaration.name, entityIndexes)
  }
  return indexes
}

function physicalFieldName (field: string): string {
  return field.replaceAll(/[A-Z]/g, (letter, index) => {
    const previous = field[index - 1]
    const next = field[index + 1]
    const needsSeparator = (previous !== undefined && /[a-z0-9]/.test(previous))
      || (next !== undefined && /[a-z]/.test(next))
    return `${needsSeparator ? '_' : ''}${letter.toLowerCase()}`
  })
}

function topLevelFunctionNames (source: string): readonly string[] {
  const clean = stripJavaScriptNoise(source)
  const names = new Set<string>()
  const pattern = /\bfunction\s+([A-Za-z0-9_$]+)\s*\(/g
  for (const match of clean.matchAll(pattern)) {
    if (braceDepthAt(clean, match.index ?? 0) === 0) names.add(match[1]!)
  }
  return [...names]
}

function stripJavaScriptNoise (source: string): string {
  const output = source.split('')
  const blank = (index: number): void => {
    if (output[index] !== '\n') output[index] = ' '
  }
  for (let index = 0; index < output.length; index += 1) {
    const character = output[index]
    if (character === '"' || character === '\'' || character === '`') {
      const quote = character
      blank(index)
      for (index += 1; index < output.length; index += 1) {
        if (output[index] === '\\') {
          blank(index)
          if (index + 1 < output.length) {
            index += 1
            blank(index)
          }
          continue
        }
        const done = output[index] === quote
        blank(index)
        if (done) break
      }
      continue
    }
    if (character !== '/' || index + 1 >= output.length) continue
    if (output[index + 1] === '/') {
      for (; index < output.length && output[index] !== '\n'; index += 1) blank(index)
      continue
    }
    if (output[index + 1] === '*') {
      blank(index)
      index += 1
      blank(index)
      for (index += 1; index < output.length; index += 1) {
        if (output[index] === '*' && index + 1 < output.length && output[index + 1] === '/') {
          blank(index)
          index += 1
          blank(index)
          break
        }
        blank(index)
      }
    }
  }
  return output.join('')
}

function braceDepthAt (source: string, position: number): number {
  let depth = 0
  for (let index = 0; index < position && index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}' && depth > 0) depth -= 1
  }
  return depth
}

function matchesFilter (record: Record<string, unknown>, value: unknown): boolean {
  if (!isRecord(value)) return true
  return Object.entries(value).every(([field, condition]) => {
    const conditions = Array.isArray(condition) ? condition : [condition]
    return conditions.every(item => isRecord(item) && Object.entries(item).every(([operator, expected]) => {
      const actual = record[field]
      switch (operator) {
        case 'eq': return actual === expected
        case 'neq': return actual !== expected
        case 'in': return Array.isArray(expected) && expected.includes(actual)
        case 'nin': return Array.isArray(expected) && !expected.includes(actual)
        case 'gt': return actual !== null && actual !== undefined && actual > expected
        case 'gte': return actual !== null && actual !== undefined && actual >= expected
        case 'lt': return actual !== null && actual !== undefined && actual < expected
        case 'lte': return actual !== null && actual !== undefined && actual <= expected
        case 'contains': return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected)
        case 'startsWith': return typeof actual === 'string' && typeof expected === 'string' && actual.startsWith(expected)
        case 'endsWith': return typeof actual === 'string' && typeof expected === 'string' && actual.endsWith(expected)
        case 'isNull': return actual === null || actual === undefined
        case 'isNotNull': return actual !== null && actual !== undefined
        default: return false
      }
    }))
  })
}

function matchesType (type: WorkerBackendEntity['fields'][string]['type'], value: unknown): boolean {
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

function bridgeResult (operation: () => unknown): string {
  try {
    return JSON.stringify({ ok: true, data: operation() })
  } catch (error) {
    return JSON.stringify({
      ok: false,
      error: {
        code: error instanceof BackendRuntimeError ? error.code : 'BRIDGE_FAILED',
        message: message(error),
      },
    })
  }
}

/** Worker 业务错误码 → HTTP 状态（对齐线上 Gateway：CONFLICT=409、NOT_FOUND=404）。 */
function httpStatusForBusinessCode (code: string): number {
  if (code === 'CONFLICT') return 409
  if (code === 'NOT_FOUND') return 404
  if (code === 'PERMISSION_DENIED' || code === 'FORBIDDEN') return 403
  if (code === 'UNAUTHORIZED') return 401
  return 400
}

function isRecord (value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function settleAsyncResult (context: ReturnType<typeof createContext>, sandbox: Record<string, unknown>): Promise<void> {
  const deadline = Date.now() + SCRIPT_TIMEOUT_MS
  while (sandbox.__done !== true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`脚本执行超过 ${SCRIPT_TIMEOUT_MS}ms`)
    await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 0))
    new Script('0').runInContext(context, { timeout: remaining })
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
