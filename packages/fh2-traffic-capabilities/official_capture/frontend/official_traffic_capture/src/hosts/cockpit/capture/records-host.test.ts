// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createViewState } from 'fh2-plugin-sdk'
import { describe, expect, it, vi } from 'vitest'
import type { LaneChangeRecordItemDto } from '../../../views/capture-records/lane-change/contract'
import type { PersonRoadRecordItemDto } from '../../../views/capture-records/person-road/contract'
import type { TrafficCaptureContext } from '../context'
import type { LaneChangeModule } from '../lane-change/module'
import type { PersonRoadModule } from '../person-road/module'
import type { CapturePreviewHost } from './preview-host'
import { createCaptureRecordsHost } from './records-host'

const captured = vi.hoisted(() => ({ methods: undefined as undefined | {
  selectLaneChangeRecord(input: { eventKey: string }): Promise<void>;
  selectPersonRoadRecord(input: { trackingId: string }): Promise<void>;
} }))

vi.mock('../../../views/capture-records/contract', () => ({
  captureRecordsView: {
    handle: vi.fn(async (_ctx: unknown, provider: { methods: NonNullable<typeof captured.methods> }) => {
      captured.methods = provider.methods
    }),
    get: vi.fn(() => ({})),
  },
}))

describe('capture records host', () => {
  it('forwards identifiers without reading record properties', async () => {
    const opaqueLaneRecord = new Proxy({}, {
      get: () => {
        throw new Error('record inspected')
      },
    }) as LaneChangeRecordItemDto
    const opaquePersonRecord = new Proxy({}, {
      get: () => {
        throw new Error('record inspected')
      },
    }) as PersonRoadRecordItemDto
    const laneChange = {
      recordsState: createViewState({ records: [opaqueLaneRecord], selectedEventKey: '' }),
      selectRecord: vi.fn(),
    } as unknown as LaneChangeModule
    const personRoad = {
      recordsState: createViewState({ records: [opaquePersonRecord], selectedTrackingId: '' }),
      selectRecord: vi.fn(),
    } as unknown as PersonRoadModule
    const preview = {
      showLaneChange: vi.fn(async () => {}),
      showPersonRoad: vi.fn(async () => {}),
      clearSelection: vi.fn(),
    } as unknown as CapturePreviewHost
    const reveal = vi.fn(async () => {})
    const ctx = {
      extensions: { contribute: vi.fn(async () => ({ reveal })) },
    } as unknown as TrafficCaptureContext

    const host = await createCaptureRecordsHost({ ctx, laneChange, personRoad, preview })
    await captured.methods!.selectLaneChangeRecord({ eventKey: 'event-key-1' })
    expect(laneChange.selectRecord).toHaveBeenCalledWith('event-key-1')
    expect(preview.showLaneChange).toHaveBeenCalledWith()

    await captured.methods!.selectPersonRoadRecord({ trackingId: 'tracking-1' })
    expect(personRoad.selectRecord).toHaveBeenCalledWith('tracking-1')
    expect(preview.showPersonRoad).toHaveBeenCalledWith()

    host.dispose()
  })
})
