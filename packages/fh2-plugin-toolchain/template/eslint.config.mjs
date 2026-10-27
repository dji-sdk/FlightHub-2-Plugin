// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import antfu from '@antfu/eslint-config'

export default antfu({
  typescript: true,
  vue: true,
  ignores: ['dist/**', 'src/generated/**', 'backend/handlers/**/*.js', 'backend/events/**/*.js'],
}, {
  rules: {
    'jsonc/sort-keys': 'off',
    'style/member-delimiter-style': ['error', {
      multiline: { delimiter: 'semi', requireLast: true },
      singleline: { delimiter: 'semi', requireLast: false },
    }],
    'style/brace-style': ['error', '1tbs'],
    'style/space-before-function-paren': ['error', 'always'],
    'test/prefer-lowercase-title': 'off',
    'vue/block-order': 'off',
  },
})
