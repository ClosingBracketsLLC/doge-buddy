import { describe, expect, it } from 'vitest'
import { err, isErr, isOk, ok } from '@doge-buddy/core'

describe('Result', () => {
  it('ok wraps a value and narrows via isOk', () => {
    const r = ok(42)
    expect(isOk(r)).toBe(true)
    if (isOk(r)) expect(r.value).toBe(42)
  })
  it('err wraps an error and narrows via isErr', () => {
    const r = err(new Error('boom'))
    expect(isErr(r)).toBe(true)
    if (isErr(r)) expect(r.error.message).toBe('boom')
  })
})
