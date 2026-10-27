// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  'packages/fh2-plugin-sdk/vitest.config.ts',
  'packages/fh2-plugin-toolchain/ide/vitest.config.ts',
  'packages/fh2-plugin-toolchain/vitest.config.ts',
  'packages/fh2-traffic-capabilities/official_accident/frontend/official_accident_response/vitest.config.ts',
  'packages/fh2-traffic-capabilities/official_accident/frontend/official_alert_dispatch/vitest.config.ts',
  'packages/fh2-traffic-capabilities/official_capture/frontend/official_traffic_capture/vitest.config.ts',
  'packages/fh2-traffic-capabilities/official_parking/frontend/official_parking_patrol/vitest.config.ts',
  'packages/fh2-traffic-capabilities/official_parking/frontend/official_wayline_teach/vitest.config.ts',
  'packages/fh2-traffic-capabilities/vitest.config.ts',
  'skills/fh2-plugin-dev/tests/vitest.config.ts',
])
