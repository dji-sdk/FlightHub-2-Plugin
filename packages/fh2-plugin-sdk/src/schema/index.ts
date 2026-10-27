// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import manifestSchemaSource from './manifest.schema.json' with { type: 'json' }

export const MANIFEST_SCHEMA_ID = 'https://dji.com/schemas/fh2-plugin/manifest.schema.json'

// A TypeScript binding emits the inferred JSON type, not JSON initializers, in bundled declarations.
export const manifestSchema = manifestSchemaSource
