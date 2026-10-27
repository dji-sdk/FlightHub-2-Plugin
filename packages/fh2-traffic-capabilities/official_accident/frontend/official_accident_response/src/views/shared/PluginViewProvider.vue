<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <n-config-provider
    :theme="darkTheme"
    :theme-overrides="pluginThemeOverrides"
    :style-mount-target="styleTarget"
    style="height: 100%"
  >
    <n-global-style />
    <slot />
  </n-config-provider>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { NConfigProvider, NGlobalStyle, darkTheme } from 'naive-ui'
import { pluginThemeOverrides } from './theme'

defineProps<{
  styleTarget: ShadowRoot | HTMLHeadElement;
}>()
</script>

<style>
/* vueuc mounts these rules in document.head, which cannot style ShadowRoot followers. */
.v-binder-follower-container {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  height: 0;
  pointer-events: none;
  z-index: auto;
}

.v-binder-follower-content {
  position: absolute;
  z-index: auto;
}

.v-binder-follower-content > * {
  pointer-events: all;
}

.v-binder-follower-content:has(> .n-tooltip),
.n-tooltip {
  width: max-content;
  max-width: min(320px, calc(100vw - 24px));
}
</style>
