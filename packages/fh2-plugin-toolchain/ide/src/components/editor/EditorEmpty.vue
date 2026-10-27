<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { useDocumentsStore } from '../../stores/documents'

/**
 * 编辑区空态：无活动文档（tab 全关）时的默认占位页，
 * 绝对定位盖在 Monaco 宿主上；插画为内联 SVG，配色走全局 CSS 变量。
 */
const documents = useDocumentsStore()
</script>

<template>
  <div v-if="documents.active === null" class="editor-empty">
    <svg class="editor-empty-art" viewBox="0 0 200 140" aria-hidden="true">
      <!-- 编辑器窗口 -->
      <rect x="2" y="2" width="196" height="136" rx="8" fill="var(--bg-elevated)" stroke="var(--border)" />
      <!-- 标题栏 + 窗口圆点 -->
      <path d="M2 24 H198" stroke="var(--border)" fill="none" />
      <circle cx="16" cy="13" r="3" fill="#f48771" opacity="0.75" />
      <circle cx="28" cy="13" r="3" fill="#e2c08d" opacity="0.75" />
      <circle cx="40" cy="13" r="3" fill="#89d185" opacity="0.75" />
      <!-- 行号列 -->
      <g fill="var(--fg-muted)" opacity="0.25">
        <rect x="10" y="35" width="5" height="6" rx="2" />
        <rect x="10" y="47" width="5" height="6" rx="2" />
        <rect x="10" y="59" width="5" height="6" rx="2" />
        <rect x="10" y="71" width="5" height="6" rx="2" />
        <rect x="10" y="83" width="5" height="6" rx="2" />
        <rect x="10" y="95" width="5" height="6" rx="2" />
        <rect x="10" y="107" width="5" height="6" rx="2" />
      </g>
      <!-- 代码行：缩进/长度/颜色模拟语法高亮 -->
      <rect x="22" y="35" width="54" height="6" rx="3" fill="var(--accent-hover)" opacity="0.9" />
      <rect x="22" y="47" width="34" height="6" rx="3" fill="#c586c0" opacity="0.7" />
      <rect x="34" y="59" width="92" height="6" rx="3" fill="var(--fg-muted)" opacity="0.55" />
      <rect x="46" y="71" width="48" height="6" rx="3" fill="var(--fg-muted)" opacity="0.55" />
      <rect x="46" y="83" width="62" height="6" rx="3" fill="var(--fg-muted)" opacity="0.4" />
      <rect x="116" y="83" width="22" height="6" rx="3" fill="#89d185" opacity="0.55" />
      <rect x="34" y="95" width="58" height="6" rx="3" fill="var(--fg-muted)" opacity="0.55" />
      <rect x="22" y="107" width="78" height="6" rx="3" fill="var(--fg-muted)" opacity="0.4" />
      <!-- 光标 -->
      <rect x="96" y="94" width="2.5" height="10" rx="1" fill="var(--fg-strong)" opacity="0.9" />
    </svg>
    <p class="editor-empty-title">
      未打开文件
    </p>
    <p class="editor-empty-hint">
      从左侧资源管理器点击文件，或切换到搜索视图定位文件
    </p>
  </div>
</template>
