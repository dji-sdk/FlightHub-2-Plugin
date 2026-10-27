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
