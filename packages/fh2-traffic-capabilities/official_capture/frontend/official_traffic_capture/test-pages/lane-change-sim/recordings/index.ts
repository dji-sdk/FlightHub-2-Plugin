// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
export interface BuiltInReplayRecording {
  id: string;
  name: string;
  fileName: string;
  url: string;
}

/** dev server 由 rsbuild.sim.config.ts 的 publicDir 指向本目录。 */
const RECORDING_BASE_URL = './'

export const BUILT_IN_REPLAY_RECORDINGS: BuiltInReplayRecording[] = [
  {
    id: 'builtin-replay-60m-wide-1x',
    name: '录制·60m俯拍·1倍变焦',
    fileName: '60m俯拍-1倍变焦.ndjson',
    url: `${RECORDING_BASE_URL}/60m俯拍-1倍变焦.ndjson`,
  },
  {
    id: 'builtin-replay-20m-wide-1x',
    name: '录制·20m俯拍·1倍变焦',
    fileName: '20m俯拍-1倍变焦.ndjson',
    url: `${RECORDING_BASE_URL}/20m俯拍-1倍变焦.ndjson`,
  },
  {
    id: 'builtin-replay-20m-zoom-near-2x',
    name: '录制·20m俯拍·接近2倍变焦',
    fileName: '20m俯拍-接近2倍变焦.ndjson',
    url: `${RECORDING_BASE_URL}/20m俯拍-接近2倍变焦.ndjson`,
  },
]
