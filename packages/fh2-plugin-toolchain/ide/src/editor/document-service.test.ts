// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import * as monaco from 'monaco-editor'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ideApi } from '../api/client.js'
import { useDocumentsStore } from '../stores/documents.js'
import { bindWorkflowDocument } from '../features/workflow/document-binding.js'
import { createDocumentService } from './document-service.js'
import { pathToUri } from './document-store.js'

vi.mock('../api/client.js', async importOriginal => ({ ...await importOriginal<object>(), ideApi: { readFile: vi.fn(), writeFile: vi.fn() } }))
beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})
afterEach(() => {
  for (const model of monaco.editor.getModels()) model.dispose()
})

function deferred<T> () {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('统一文档服务', () => {
  it('并发读取同一文件只请求一次，晚回包不覆盖用户修改', async () => {
    const documents = useDocumentsStore()
    const service = createDocumentService(documents, () => 's1')
    const response = deferred<Awaited<ReturnType<typeof ideApi.readFile>>>()
    vi.mocked(ideApi.readFile).mockReturnValue(response.promise)
    const first = service.readDetached('a.ts')
    const second = service.readDetached('a.ts')
    documents.open('a.ts', 'base', 'r1')
    documents.applyEdit('a.ts', 'user edit', documents.modelVersion('a.ts')!)
    response.resolve({ path: 'a.ts', content: 'stale', revision: 'r0' } as never)
    expect(await first).toBe('user edit')
    expect(await second).toBe('user edit')
    expect(ideApi.readFile).toHaveBeenCalledOnce()
  })

  it('关闭再打开同路径时迟到的保存回包不能推进新文档基线', async () => {
    const documents = useDocumentsStore()
    const service = createDocumentService(documents, () => 's1')
    documents.open('a.ts', 'base', 'r1')
    documents.applyEdit('a.ts', 'edited', documents.modelVersion('a.ts')!)
    const response = deferred<Awaited<ReturnType<typeof ideApi.writeFile>>>()
    vi.mocked(ideApi.writeFile).mockReturnValue(response.promise)
    const saving = service.save('a.ts')
    await vi.waitFor(() => expect(ideApi.writeFile).toHaveBeenCalledOnce())
    documents.close('a.ts')
    documents.open('a.ts', 'fresh', 'fresh-hash')
    response.resolve({ path: 'a.ts', revision: 'old-hash' } as never)
    expect(await saving).toBe(false)
    expect(documents.expectedRevision('a.ts')).toBe('fresh-hash')
    expect(documents.isDirty('a.ts')).toBe(false)
  })
  it('保存期间的后续编辑不被清脏，同一路径按新 revision 串行保存', async () => {
    const documents = useDocumentsStore()
    documents.open('a.txt', 'old', 'r0')
    const service = createDocumentService(documents, () => 's1')
    documents.applyEdit('a.txt', 'one', documents.modelVersion('a.txt')!)
    const first = deferred<Awaited<ReturnType<typeof ideApi.writeFile>>>()
    vi.mocked(ideApi.writeFile).mockReturnValueOnce(first.promise).mockResolvedValueOnce({ path: 'a.txt', revision: 'r2' } as never)
    const saved1 = service.save('a.txt')
    await vi.waitFor(() => expect(ideApi.writeFile).toHaveBeenCalledOnce())
    documents.applyEdit('a.txt', 'two', documents.modelVersion('a.txt')!)
    const saved2 = service.save('a.txt')
    first.resolve({ path: 'a.txt', revision: 'r1' } as never)
    expect(await saved1).toBe(false)
    expect(await saved2).toBe(true)
    expect(ideApi.writeFile).toHaveBeenNthCalledWith(2, 'a.txt', 'two', 'r1')
    expect(documents.contentOf('a.txt')).toBe('two')
    expect(documents.isDirty('a.txt')).toBe(false)
  })
  it('切换后迟到的读取不创建旧 model；未知 revision 不自动覆盖磁盘', async () => {
    const documents = useDocumentsStore()
    let session = 's1'
    const service = createDocumentService(documents, () => session)
    const reading = deferred<Awaited<ReturnType<typeof ideApi.readFile>>>()
    vi.mocked(ideApi.readFile).mockReturnValueOnce(reading.promise)
    const opening = service.open('old.txt')
    session = 's2'
    reading.resolve({ path: 'old.txt', content: 'old', revision: 'r1' } as never)
    await expect(opening).rejects.toThrow('工作区已切换')
    expect(documents.has('old.txt')).toBe(false)
    documents.open('renamed.txt', '')
    documents.applyEdit('renamed.txt', 'local', documents.modelVersion('renamed.txt')!)
    vi.mocked(ideApi.readFile).mockResolvedValue({ path: 'renamed.txt', content: 'disk', revision: 'r2' } as never)
    expect(await service.save('renamed.txt')).toBe(false)
    expect(documents.conflictOf('renamed.txt')?.diskContent).toBe('disk')
    expect(ideApi.writeFile).not.toHaveBeenCalled()
  })
  it('画布与源码共用 model 和 undo；过期画布版本、冲突不得覆盖源码', async () => {
    const documents = useDocumentsStore()
    const source = '{"name":"flow","trigger":{},"steps":[]}'
    documents.open('workflows/a.json', source, 'r0')
    const service = createDocumentService(documents, () => 's1')
    let projected = ''
    const binding = bindWorkflowDocument(service, (result) => {
      if (result.ok) projected = String(result.document.raw.name)
    })
    await binding.open('workflows/a.json')
    const model = monaco.editor.getModel(pathToUri('workflows/a.json'))!
    const initial = documents.modelVersion('workflows/a.json')!
    expect(projected).toBe('flow')
    service.applyEdit('workflows/a.json', source.replace('flow', 'changed'), initial)
    expect(projected).toBe('changed')
    expect(service.applyEdit('workflows/a.json', source, initial)).toBe(false)
    await (model as unknown as { undo: () => Promise<void> }).undo()
    expect(projected).toBe('flow')
    expect(documents.isDirty('workflows/a.json')).toBe(false)
    documents.enterConflict('workflows/a.json', { diskContent: '{}', diskRevision: 'r1' })
    expect(service.applyEdit('workflows/a.json', '{}', documents.modelVersion('workflows/a.json')!)).toBe(false)
    binding.dispose()
  })
})

it('关闭标签页保留 Workflow 引用及脏内容；释放引用不能丢失未保存编辑', () => {
  const documents = useDocumentsStore()
  documents.open('shared.txt', 'initial', 'r0')
  const acquired = documents.acquireModel('shared.txt', 'ignored')
  documents.applyEdit('shared.txt', 'edited', documents.modelVersion('shared.txt')!)
  documents.close('shared.txt')
  expect(acquired.model.isDisposed()).toBe(false)
  expect(documents.openPaths).not.toContain('shared.txt')
  expect(documents.dirtyPaths).toContain('shared.txt')
  acquired.release()
  expect(documents.contentOf('shared.txt')).toBe('edited')
  expect(documents.hasDirty).toBe(true)
  documents.open('shared.txt', 'stale disk', 'r0')
  expect(documents.contentOf('shared.txt')).toBe('edited')
})
