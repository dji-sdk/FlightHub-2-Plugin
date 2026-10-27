<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { useUiStore } from '../../stores/ui'

/** 致命错误覆盖层：401 / 初始化失败时替换整个可用界面。 */
const ui = useUiStore()
</script>

<template>
  <div v-if="ui.fatal !== null" class="fatal">
    <div class="fatal-card">
      <h2>{{ ui.fatal.title }}</h2>
      <p v-for="(line, index) in ui.fatal.lines" :key="index">
        {{ line }}
      </p>
    </div>
  </div>
</template>
