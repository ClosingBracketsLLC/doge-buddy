import { describe, expect, it } from 'vitest'
import { redactTokenParam } from '../src/http/redact.ts'

describe('redactTokenParam', () => {
  it('redacts a bare ?t= query param', () => {
    expect(redactTokenParam('/admin/login/consume?t=abc')).toBe('/admin/login/consume?t=[redacted]')
  })

  it('redacts an &t= param while preserving surrounding params', () => {
    expect(redactTokenParam('/x?x=1&t=abc&y=2')).toBe('/x?x=1&t=[redacted]&y=2')
  })

  it('leaves a URL with no t param unchanged', () => {
    expect(redactTokenParam('/admin/login')).toBe('/admin/login')
    expect(redactTokenParam('/a/123/approve')).toBe('/a/123/approve')
  })

  it('does not touch "t" appearing only as a substring of a value', () => {
    expect(redactTokenParam('/x?not=at=3')).toBe('/x?not=at=3')
  })
})
