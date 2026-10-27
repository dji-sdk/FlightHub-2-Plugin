// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 另存副本的路径（DAG-017-08 规格）：`${path}.local-<时间>` 直接追加在完整路径末尾。
 * ⚠️ 不能把 `.local-<ts>` 插在扩展名前（旧实现生成 `x.local-<ts>.json`）——
 * 九列规格与自动化按 `原名.local-*` 前缀识别副本，插中间会导致副本不被认出
 * （保存链路本身是通的，纯粹命名口径）。
 */
export function localCopyPath (path: string, stamp = Date.now()): string {
  return `${path}.local-${stamp}`
}
