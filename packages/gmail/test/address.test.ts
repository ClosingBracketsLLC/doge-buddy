import { describe, expect, it } from 'vitest'
import { parseAddrSpecs, parseFirstAddrSpec } from '../src/address.ts'

describe('parseAddrSpecs', () => {
  it('extracts lowercase addr-specs from display-name forms and lists', () => {
    expect(parseAddrSpecs('DogeBuddy Support <Admin@DogeBuddy.com>')).toEqual(['admin@dogebuddy.com'])
    expect(parseAddrSpecs('a@x.com, "B, comma" <b@y.com>')).toEqual(['a@x.com', 'b@y.com'])
    expect(parseAddrSpecs('bare@addr.com')).toEqual(['bare@addr.com'])
  })
  it('is NOT fooled by an address inside a display name (spoof case)', () => {
    expect(parseAddrSpecs('"support@dogebuddy.com" <x@evil.com>')).toEqual(['x@evil.com'])
  })
  it('handles null/empty/garbage', () => {
    expect(parseAddrSpecs(null)).toEqual([])
    expect(parseAddrSpecs('no address here')).toEqual([])
    expect(parseFirstAddrSpec('Bob <b@y.com>')).toBe('b@y.com')
    expect(parseFirstAddrSpec('')).toBeNull()
  })
  it('extracts the LAST angle bracket group when multiple are present', () => {
    expect(parseAddrSpecs('Name <spoof@evil.com> <real@good.com>')).toEqual(['real@good.com'])
  })
})
