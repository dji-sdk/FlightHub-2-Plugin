// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// @vitest-environment happy-dom
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as monaco from 'monaco-editor'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ideApi, setWorkspaceSession } from '../../ide/src/api/client.js'
import { createDocumentService } from '../../ide/src/editor/document-service.js'
import { SaveCoordinator } from '../../ide/src/editor/save-coordinator.js'
import type { SaveResponse } from '../../ide/src/editor/save-coordinator.js'
import { useDocumentsStore } from '../../ide/src/stores/documents.js'
import { startIdeServer } from '../serve/ide-server.js'
import type { IdeServer } from '../serve/ide-server.js'
import { CLI_CONTRACT } from './cli.js'

describe('known IDE save limitations (local model/API regression, not browser validation)', () => {
  let root: string
  let webRoot: string
  let server: IdeServer
  let documents: ReturnType<typeof useDocumentsStore>
  let service: ReturnType<typeof createDocumentService>
  let saver: SaveCoordinator
  let receipt: SaveResponse | undefined

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fh2-ide-save-limit-'))
    webRoot = await mkdtemp(join(tmpdir(), 'fh2-ide-save-page-'))
    await mkdir(join(root, 'adapters'))
    await writeFile(join(root, 'adapters/existing.ts'), 'export const value = 1\n')
    await writeFile(join(root, 'fh2-plugin.json'), '{"pluginId":"exp_save_limit","scripts":[]}')
    await writeFile(join(webRoot, 'index.html'), '<html><head></head><body>local API fixture</body></html>')
    server = await startIdeServer({ root, webRoot, port: 0, watch: false })
    ;(window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`${server.url}/`)
    window.__FH2_IDE_BASE__ = server.url
    window.__FH2_IDE_TOKEN__ = server.token
    setWorkspaceSession(null)
    setActivePinia(createPinia())
    documents = useDocumentsStore()
    documents.setWorkspaceRoot(root)
    service = createDocumentService(documents, () => 'local-test-session')
    receipt = undefined
    saver = new SaveCoordinator({
      documents: service,
      save: async (items) => {
        receipt = await ideApi.save(items)
        return receipt
      },
      readFile: path => ideApi.readFile(path),
    })
  })

  afterEach(async () => {
    documents?.reset()
    for (const model of monaco.editor.getModels()) model.dispose()
    await server?.close()
    delete window.__FH2_IDE_BASE__
    delete window.__FH2_IDE_TOKEN__
    await Promise.all([root, webRoot].filter(Boolean).map(path => rm(path, { recursive: true, force: true })))
  })

  function createVirtualFile (): string {
    const path = 'adapters/new.ts'
    expect(documents.applyPrepared({
      kind: 'UsageLimitTest',
      label: 'Create a virtual source file',
      expected: { workspaceEpoch: documents.workspaceEpoch(), documents: [] },
      edits: [{ path, kind: 'create', content: 'export const value = 1\n' }],
    }).ok).toBe(true)
    return path
  }

  function declaredLimit (id: string): void {
    for (const usage of CLI_CONTRACT.commands.find(command => command.name === 'serve')!.usage!) {
      expect(usage.limits.some(limit => limit.includes(id)), `${usage.id}/${id}`).toBe(true)
    }
  }

  it('ide_save_detached_script: the production facade can omit an Inspector-only script', async () => {
    declaredLimit('IDE_SAVE_DETACHED_SCRIPT')
    const path = 'adapters/existing.ts'
    const disk = await service.readDetached(path)
    documents.applyEdit(path, `${disk}// unsaved edit\n`, documents.modelVersion(path)!)
    expect(documents.dirtyPaths).toContain(path)
    expect(service.openPaths).not.toContain(path)
    expect(saver.buildPlan([path]).items).toEqual([])
    expect(await saver.save([path])).toMatchObject({ nothingToSave: true, saved: [] })
    expect(documents.isDirty(path)).toBe(true)
    expect(await readFile(join(root, path), 'utf8')).toBe(disk)
  })

  it('ide_save_new_file_state: a saved virtual file is persisted and further edits update in place', async () => {
    declaredLimit('IDE_SAVE_NEW_FILE_STATE')
    const path = createVirtualFile()
    expect((await saver.save([path])).ok).toBe(true)
    // 保存成功即落盘：文档状态从 create 转为已存在的 update 对象。
    expect(documents.snapshot([path])[0]).toMatchObject({ existsOnDisk: true, dirty: false })
    expect(await readFile(join(root, path), 'utf8')).toBe('export const value = 1\n')
    documents.applyEdit(path, 'export const value = 2\n', documents.modelVersion(path)!)
    expect(saver.buildPlan([path]).items[0]?.kind).toBe('write')
    const result = await saver.save([path])
    expect(result.ok).toBe(true)
    expect(await readFile(join(root, path), 'utf8')).toBe('export const value = 2\n')
    expect(documents.isDirty(path)).toBe(false)
  })

  it('ide_save_task_barrier: generic SaveAll reads a new file before create and does not flush DAG drafts', async () => {
    declaredLimit('IDE_SAVE_TASK_BARRIER')
    await service.open('fh2-plugin.json')
    const original = documents.contentOf('fh2-plugin.json')!
    const path = createVirtualFile()
    let flushed = 0
    saver.registerDraftFlush(() => {
      flushed += 1
      documents.applyEdit('fh2-plugin.json', `${original}\n`, documents.modelVersion('fh2-plugin.json')!)
    })
    await expect(service.saveAll()).rejects.toMatchObject({ code: 'FH2_IDE_NOT_FOUND', httpStatus: 404 })
    expect(flushed).toBe(0)
    expect(existsSync(join(root, path))).toBe(false)
    expect(await readFile(join(root, 'fh2-plugin.json'), 'utf8')).toBe(original)
    expect((await saver.save()).ok).toBe(true)
    expect(flushed).toBe(1)
    expect(existsSync(join(root, path))).toBe(true)
  })

  it('ide_save_skipped_receipt: server-skipped items are classified as failed rather than pending', async () => {
    declaredLimit('IDE_SAVE_SKIPPED_RECEIPT')
    await service.open('adapters/existing.ts')
    await service.open('fh2-plugin.json')
    const originalManifest = documents.contentOf('fh2-plugin.json')!
    documents.applyEdit('adapters/existing.ts', 'export const value = 2\n', documents.modelVersion('adapters/existing.ts')!)
    documents.applyEdit('fh2-plugin.json', `${originalManifest}\n`, documents.modelVersion('fh2-plugin.json')!)
    await writeFile(join(root, 'adapters/existing.ts'), 'export const value = 3\n')
    const result = await saver.save()
    expect(receipt?.items.map(item => item.errorCode)).toEqual(['FH2_FILE_CONFLICT', 'FH2_IDE_SAVE_SKIPPED'])
    // IDE-009-03 修复后：SKIPPED 项（被前序失败挡住、没有失败原因）归 pending 未执行段，不再算 failed。
    expect(result.failed.map(item => item.path)).toEqual(['adapters/existing.ts'])
    expect(result.pending).toEqual(['fh2-plugin.json'])
    expect(await readFile(join(root, 'fh2-plugin.json'), 'utf8')).toBe(originalManifest)
  })
})
