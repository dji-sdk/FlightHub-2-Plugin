// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { installMonacoWorkers, installPostgreSqlLanguageFeatures, reassertJsonSchemasOnLanguageActivation } from './editor/monaco-setup.js'

installMonacoWorkers()
installPostgreSqlLanguageFeatures()
// DAG-013-01 防御：json 语言激活时重申已应用的 schema 配置（见 monaco-setup 的说明）
reassertJsonSchemasOnLanguageActivation()

const root = document.getElementById('app')
if (root === null) throw new Error('缺少 #app 挂载点')

const app = createApp(App)
app.use(createPinia())
app.mount(root)
