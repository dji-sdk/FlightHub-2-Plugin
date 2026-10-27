// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { defineConfig } from 'vitest/config'
import { workspaceAliases } from './vitest.workspace-aliases'

export default defineConfig({ resolve: { alias: workspaceAliases } })
