// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 变道抓拍算法验证模拟器入口（traffic-capture-plugin 独立调试页）。
 *
 * 启动：插件目录内 `pnpm sim`（rsbuild dev -c rsbuild.sim.config.ts）。
 * 本页面不写入插件 Manifest，不进入正式插件构建产物。
 *
 * 顶层为 tab 壳（SimTabs）：
 * - 合成场景模拟器：原有 App.vue；
 * - 真机录像验证：video/VideoApp.vue（上传 DJI 机载 MP4 走 djmd 检测数据回放）。
 */
import { createApp } from 'vue'
import SimTabs from './SimTabs.vue'

const app = createApp(SimTabs)
app.mount('#app')
