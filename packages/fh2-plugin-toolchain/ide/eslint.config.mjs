// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import antfu from '@antfu/eslint-config'

/**
 * 局部覆盖根配置（根是 vue:false）：本 app 是仓内 Vue 3 工程之一，
 * .vue 文件需要完整的 vue lint。其余规则与根 eslint.config.mjs 保持一致，
 * 避免同目录下既有 .ts 文件的 lint 行为漂移。
 */
export default antfu(
  {
    typescript: true,
    vue: true,
    regexp: false,
    jsdoc: false,
    ignores: ['dist/**', '.mock-workspace/**'],
  },
  {
    // 全语言通用的风格约定（对齐根配置）
    rules: {
      'style/semi': 'warn',
      'style/indent': 'warn',
      'style/quote-props': ['warn', 'as-needed'],
      'style/comma-dangle': 'warn',
      'style/brace-style': ['warn', '1tbs'],
      'style/space-before-function-paren': ['warn', 'always'],
      'antfu/if-newline': 'off',
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      'style/member-delimiter-style': ['warn', {
        multiline: { delimiter: 'semi', requireLast: true },
        singleline: { delimiter: 'semi', requireLast: false },
      }],
      'ts/consistent-type-imports': 'warn',
      'ts/method-signature-style': 'off',
      'ts/prefer-literal-enum-member': 'off',
    },
  },
  {
    files: ['**/*.vue'],
    rules: {
      // SFC 采用 script → template → style 顺序即可，不强制 block 顺序
      'vue/block-order': 'off',
    },
  },
)
