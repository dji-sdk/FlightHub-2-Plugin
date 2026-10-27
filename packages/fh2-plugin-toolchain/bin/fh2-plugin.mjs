#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.

import process from 'node:process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Create uses this internal hint to recognize an npm-linked source checkout.
process.env.FH2_TOOLCHAIN_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

await import('../dist/cli.js')
