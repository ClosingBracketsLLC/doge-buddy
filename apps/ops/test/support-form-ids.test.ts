import { describe, expect, it } from 'vitest'
import { formMessageId, formPlaceholderThreadId, isFormPlaceholder, isGmailMessageId } from '../src/support/form-ids.ts'

describe('form ids', () => {
  it('placeholder thread id and message ids carry the form: prefix; real Gmail ids do not', () => {
    expect(formPlaceholderThreadId('abc')).toBe('form:abc')
    expect(isFormPlaceholder('form:abc')).toBe(true)
    expect(isFormPlaceholder('1a050c80ad6eb6d0')).toBe(false)
    expect(isGmailMessageId('1a050c80ad6eb6d0')).toBe(true)
    expect(isGmailMessageId(formMessageId())).toBe(false)
    expect(formMessageId()).toMatch(/^form:[0-9a-f-]{36}$/)
    expect(formMessageId()).not.toBe(formMessageId())
  })
})
