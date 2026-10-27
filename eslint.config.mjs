// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import antfu from '@antfu/eslint-config'

export default antfu({
    typescript: true,
    vue: false,
    regexp: false,
    jsdoc: false,
    ignores: [
        '**/dist/**',
        '**/release/**',
        '**/node_modules/**',
        '**/*.d.ts',
        '**/*.json',
        '**/coverage/**',
        'docs/**',
        'THIRD-PARTY-NOTICES.md',
        'scripts/public-source/THIRD-PARTY-NOTICES.md',
        'packages/fh2-plugin-toolchain/template/**',
        'packages/fh2-plugin-toolchain/template-fullstack/**',
        'packages/fh2-plugin-toolchain/template-backend/**',
        'packages/fh2-plugin-toolchain/template-capability/**',
        'packages/fh2-plugin-toolchain/template-variants/**',
        'packages/fh2-plugin-toolchain/src/backend/__fixtures__/**',
        'packages/fh2-plugin-sdk/src/backend/**',
        'packages/fh2-plugin-toolchain/developer-runtime/**',
        'packages/fh2-plugin-toolchain/runtime-assets/**',
        '**/backend/handlers/**/*.js',
        '**/backend/events/**/*.js',
        'packages/*-capabilities/*/backend/**'
    ]
}, {
    rules: {
        'style/semi': 'warn',
        'style/indent': 'warn',
        'style/quote-props': ['warn', 'as-needed'],
        'style/comma-dangle': 'warn',
        'style/brace-style': ['warn', '1tbs'],
        'style/space-before-function-paren': ['warn', 'always'],
        'antfu/if-newline': 'off',
    },
}, {
    files: ['**/*.{js,mjs,cjs}'],
    ignores: ['**/*.md/**'],
    rules: {
        'unused-imports/no-unused-vars': 'off',
        'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
}, {
    files: ['scripts/plugin-doc-sync/**'],
    rules: {
        'node/prefer-global/process': 'off',
        'unicorn/prefer-node-protocol': 'off',
        'unicorn/escape-case': 'off',
        'no-cond-assign': 'off',
        'style/operator-linebreak': 'off',
        'style/indent': 'off',
        'style/arrow-parens': 'off',
        'antfu/consistent-list-newline': 'off',
    },
}, {
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
})
