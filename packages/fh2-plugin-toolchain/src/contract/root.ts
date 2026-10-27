// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { loadDeveloperRuntime } from '../developer-runtime/loader.js'

export { resolveDeveloperRuntimeRoot as resolveContractRoot } from '../developer-runtime/loader.js'
export { DEVELOPER_RUNTIME_PACKAGE_NAME as CONTRACT_PACKAGE_NAME } from '../developer-runtime/types.js'

/** Only published JSON aliases are readable, even when a private Contract is adjacent. */
export function readContractJson<T> (contractRoot: string, relativePath: string): T {
  if (relativePath.startsWith('/') || relativePath.includes('\\')
    || relativePath.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`契约资源路径越界：${relativePath}`)
  }
  const files = loadDeveloperRuntime({ root: contractRoot }).resources.files
  if (!Object.hasOwn(files, relativePath)) throw new Error(`契约资源未发布或不存在：${relativePath}`)
  return files[relativePath] as T
}
