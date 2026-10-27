// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { AppCockpitContext } from '../../generated/plugin-types'
import { registerHelloExample } from './hello-example'
import { registerIssueExample } from './issue-example'

export async function activate (ctx: AppCockpitContext): Promise<void> {
  await registerHelloExample(ctx)
  await registerIssueExample(ctx)
}
