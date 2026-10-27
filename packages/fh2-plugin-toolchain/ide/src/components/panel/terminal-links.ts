// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
export interface TerminalFileLocation {
  readonly text: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly start: number;
}

/** 支持 tsc/esbuild/Vite 常见的 path:line:column 形式。 */
export function parseTerminalFileLocations (line: string, workspaceRoot = ''): readonly TerminalFileLocation[] {
  const result: TerminalFileLocation[] = []
  const pattern = /(?:^|[\s(])((?:[A-Za-z]:)?[^\s():]+\.(?:vue|tsx?|jsx?|mjs|cjs|json|css|scss|less|html)):(\d+):(\d+)/g
  for (const match of line.matchAll(pattern)) {
    const text = match[1]
    if (text === undefined) continue
    let path = text.replace(/^file:\/\//, '')
    if (workspaceRoot !== '' && path.startsWith(`${workspaceRoot}/`)) path = path.slice(workspaceRoot.length + 1)
    path = path.replace(/^\.\//, '')
    if (path.startsWith('/')) continue
    result.push({
      text: `${text}:${match[2]}:${match[3]}`,
      path,
      line: Number(match[2]),
      column: Number(match[3]),
      start: (match.index ?? 0) + match[0].indexOf(text),
    })
  }
  return result
}
