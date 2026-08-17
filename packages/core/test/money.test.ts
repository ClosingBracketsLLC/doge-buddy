import { describe, expect, it } from 'vitest'
import { assertCents, formatCents, grossMarginBps, usdToCents } from '@doge-buddy/core'

describe('formatCents', () => {
  it('formats integer cents as USD', () => {
    expect(formatCents(1234)).toBe('$12.34')
    expect(formatCents(0)).toBe('$0.00')
    expect(formatCents(5)).toBe('$0.05')
    expect(formatCents(-1234)).toBe('-$12.34')
  })
  it('rejects non-integers', () => {
    expect(() => formatCents(12.5)).toThrow(RangeError)
    expect(() => formatCents(Number.NaN)).toThrow(RangeError)
  })
})

describe('grossMarginBps', () => {
  it('computes margin in basis points', () => {
    expect(grossMarginBps(2000, 800)).toBe(6000) // 60.00%
    expect(grossMarginBps(1000, 1000)).toBe(0)
    expect(grossMarginBps(1000, 1500)).toBe(-5000)
  })
  it('rejects zero/negative revenue and non-integers', () => {
    expect(() => grossMarginBps(0, 100)).toThrow(RangeError)
    expect(() => grossMarginBps(100.5, 10)).toThrow(RangeError)
  })
})

describe('assertCents', () => {
  it('accepts safe integers, rejects everything else', () => {
    expect(() => assertCents(100)).not.toThrow()
    expect(() => assertCents(1.5)).toThrow(RangeError)
    expect(() => assertCents(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError)
  })
})

describe('usdToCents', () => {
  it('converts numbers and numeric strings to integer cents', () => {
    expect(usdToCents(19.99)).toBe(1999)
    expect(usdToCents('7.5')).toBe(750)
    expect(usdToCents(0)).toBe(0)
    expect(usdToCents('12')).toBe(1200)
    expect(usdToCents(1.005)).toBe(101) // rounds half-up despite float representation
  })
  it('rejects negatives, non-finite, and junk strings', () => {
    expect(() => usdToCents(-1)).toThrow(RangeError)
    expect(() => usdToCents(Number.NaN)).toThrow(RangeError)
    expect(() => usdToCents('12,50')).toThrow(RangeError)
    expect(() => usdToCents('')).toThrow(RangeError)
  })
  it('handles exponential notation correctly', () => {
    expect(usdToCents('1e2')).toBe(10000) // 100 USD
    expect(usdToCents(1e2)).toBe(10000) // 100 USD
    expect(usdToCents(1e-7)).toBe(0) // rounds to 0
    expect(() => usdToCents(1e21)).toThrow(RangeError) // overflow
  })
})
