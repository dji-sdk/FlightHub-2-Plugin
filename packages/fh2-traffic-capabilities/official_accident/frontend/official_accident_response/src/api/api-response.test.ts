// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { ApiBusinessError, unwrapApiData } from './api-response'

describe('api envelope', () => {
  it('显式返回成功响应的 data', () => {
    expect(unwrapApiData({ code: 0, message: 'OK', data: { list: [1, 2] } }))
      .toEqual({ list: [1, 2] })
  })

  it('保留非零业务错误码', () => {
    try {
      unwrapApiData({ code: 1001, msg: 'query failed', data: null })
      throw new Error('预期抛出业务错误')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiBusinessError)
      expect(error).toMatchObject({ code: 1001, message: 'query failed（code: 1001）' })
    }
  })
})
