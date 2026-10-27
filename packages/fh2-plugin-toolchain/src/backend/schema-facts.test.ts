// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  SchemaFactsError,
  parseSchemaFacts,
  readSchemaFacts,
  renderWorkerEntities,
} from './schema-facts.js'

const trafficSchemaRoot = fileURLToPath(new URL(
  '../../../fh2-traffic-capabilities/official_capture/backend/official_traffic_capture_backend/',
  import.meta.url,
))

describe('schema facts', () => {
  it('reads the official traffic schema into final entities and indexes', () => {
    const facts = readSchemaFacts(trafficSchemaRoot)

    expect(facts.entities.map(entity => entity.name)).toEqual([
      'lane_change_mode',
      'lane_change_event',
      'lane_change_evidence',
      'illegal_road_session',
      'illegal_road_tracking',
      'illegal_road_media',
    ])

    const event = facts.entities.find(entity => entity.name === 'lane_change_event')!
    expect(event.fields.map(field => field.name)).toEqual([
      'event_key',
      'project_id',
      'dock_sn',
      'flight_id',
      'obj_id',
      'region_id',
      'annotation_id',
      'collision_type',
      'post_status',
      'crossed_at_ms',
      'snapshot_json',
      'video_file_id',
      'video_object_key',
      'video_start_ms',
      'video_end_ms',
      'video_create_raw',
      'reject_reason',
      'failure_reason',
      'folder_id',
      'parent_folder_id',
    ])
    expect(event.fields.map(field => field.name)).not.toContain('id')
    expect(event.fields.map(field => field.name)).not.toContain('created_at')
    expect(event.fields.map(field => field.name)).not.toContain('updated_at')
    expect(event.fields.map(field => field.name)).not.toContain('tenant_id')

    const finalEventMatch = facts.indexes.find(index => index.name === 'ix_lane_change_event_match')!
    expect(finalEventMatch.columns).toEqual([
      { name: 'dock_sn', direction: 'ASC' },
      { name: 'flight_id', direction: 'ASC' },
      { name: 'post_status', direction: 'ASC' },
      { name: 'crossed_at_ms', direction: 'ASC' },
    ])

    const folderIndex = facts.indexes.find(index => index.name === 'ix_illegal_road_tracking_folder')!
    expect(folderIndex.predicate).toEqual({ column: 'folder_id', kind: 'is-not-null' })

    const entities = renderWorkerEntities(facts)
    const workerEvent = entities.find(entity => entity.name === 'lane_change_event')!
    expect(workerEvent.fields.event_key).toEqual({ type: 'string', unique: true })
    expect(workerEvent.fields.dock_sn).toEqual({ type: 'string', indexed: true })
    expect(workerEvent.fields.created_at).toBeUndefined()
  })

  it('ignores commented-out DROP statements', () => {
    const facts = parseSchemaFacts([
      'CREATE TABLE plugin_db_note (',
      '  id TEXT PRIMARY KEY,',
      '  created_at TIMESTAMPTZ NOT NULL,',
      '  updated_at TIMESTAMPTZ NOT NULL,',
      '  tenant_id TEXT NULL,',
      '  title TEXT NULL',
      ');',
      'CREATE INDEX ix_note_title ON plugin_db_note (title);',
      '-- DROP INDEX IF EXISTS ix_note_title;',
      '-- DROP TABLE IF EXISTS plugin_db_note;',
    ].join('\n'))

    expect(facts.entities.map(entity => entity.name)).toEqual(['note'])
    expect(facts.indexes.map(index => index.name)).toEqual(['ix_note_title'])
  })

  it('applies ALTER TABLE ADD COLUMN in statement order', () => {
    const facts = parseSchemaFacts([
      'BEGIN;',
      'CREATE TABLE IF NOT EXISTS plugin_db_session (',
      '  id TEXT PRIMARY KEY,',
      '  created_at TIMESTAMPTZ NOT NULL,',
      '  updated_at TIMESTAMPTZ NOT NULL,',
      '  tenant_id TEXT NULL,',
      '  title TEXT NULL',
      ');',
      'ALTER TABLE plugin_db_session ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ NULL;',
      'ALTER TABLE plugin_db_session ADD COLUMN IF NOT EXISTS title TEXT NULL;',
      'COMMIT;',
    ].join('\n'))

    const session = facts.entities[0]!
    expect(session.fields.map(field => field.name)).toEqual(['title', 'opened_at'])
    expect(renderWorkerEntities(facts)[0]!.fields.opened_at).toEqual({ type: 'datetime' })
  })

  it('drops and recreates indexes as the final model', () => {
    const facts = parseSchemaFacts([
      'CREATE TABLE plugin_db_item (',
      '  id TEXT PRIMARY KEY,',
      '  created_at TIMESTAMPTZ NOT NULL,',
      '  updated_at TIMESTAMPTZ NOT NULL,',
      '  tenant_id TEXT NULL,',
      '  first_key TEXT NULL,',
      '  second_key TEXT NULL,',
      '  final_key TEXT NULL',
      ');',
      'CREATE INDEX ix_item_lookup ON plugin_db_item (first_key);',
      'CREATE INDEX ix_item_other ON plugin_db_item (second_key);',
      'DROP INDEX IF EXISTS ix_item_lookup;',
      'CREATE UNIQUE INDEX IF NOT EXISTS ix_item_lookup ON plugin_db_item (final_key);',
    ].join('\n'))

    expect(facts.indexes.map(index => index.name)).toEqual(['ix_item_other', 'ix_item_lookup'])
    expect(facts.indexes[1]).toMatchObject({
      name: 'ix_item_lookup',
      unique: true,
      columns: [{ name: 'final_key', direction: 'ASC' }],
    })

    const fields = renderWorkerEntities(facts)[0]!.fields
    expect(fields.first_key).toEqual({ type: 'string' })
    expect(fields.second_key).toEqual({ type: 'string', indexed: true })
    expect(fields.final_key).toEqual({ type: 'string', unique: true })
  })

  it('accepts column references with ON DELETE CASCADE without emitting foreign-key facts', () => {
    const facts = parseSchemaFacts([
      'CREATE TABLE plugin_db_teach_route (',
      '  id TEXT PRIMARY KEY,',
      '  created_at TIMESTAMPTZ NOT NULL,',
      '  updated_at TIMESTAMPTZ NOT NULL,',
      '  tenant_id TEXT NULL',
      ');',
      'CREATE TABLE plugin_db_teach_waypoint (',
      '  id TEXT PRIMARY KEY,',
      '  created_at TIMESTAMPTZ NOT NULL,',
      '  updated_at TIMESTAMPTZ NOT NULL,',
      '  tenant_id TEXT NULL,',
      '  teach_route_id TEXT NULL REFERENCES plugin_db_teach_route(id) ON DELETE CASCADE',
      ');',
    ].join('\n'))

    expect(renderWorkerEntities(facts)[1]!.fields.teach_route_id).toEqual({ type: 'string' })
  })

  it('fails closed for unsupported statements and SQL types', () => {
    expectSchemaError('DELETE FROM plugin_db_item;', '不支持的 schema.sql 语句')
    expectSchemaError('CREATE TABLE plugin_db_item (title BOOLEAN);', '当前只支持 TEXT 和 TIMESTAMPTZ')
    expectSchemaError(
      'CREATE TABLE plugin_db_item (parent_id TEXT REFERENCES plugin_db_parent(id) ON DELETE RESTRICT);',
      '期望关键字 CASCADE',
    )
  })
})

function expectSchemaError (source: string, expectedMessage: string): void {
  try {
    parseSchemaFacts(source)
    throw new Error('Expected schema parsing to fail.')
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaFactsError)
    const schemaError = error as SchemaFactsError
    expect(schemaError.diagnostics[0]).toMatchObject({
      code: 'FH2_SCHEMA_SQL_INVALID',
      statement: 1,
    })
    expect(schemaError.message).toContain(expectedMessage)
  }
}
