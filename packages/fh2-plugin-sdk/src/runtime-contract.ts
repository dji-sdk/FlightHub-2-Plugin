// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import runtimeContractSource from '../runtime-contract.json' with { type: 'json' }

// A TypeScript binding emits the inferred JSON type, not JSON initializers, in bundled declarations.
export const runtimeContract = runtimeContractSource
