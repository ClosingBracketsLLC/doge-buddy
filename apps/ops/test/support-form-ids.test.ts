import { describe, expect, it } from 'vitest'
import {
  formMessageId, formPlaceholderThreadId, formSendingSentinel, isFormPlaceholder, isGmailMessageId, parseSendingSentinel,
} from '../src/support/form-ids.ts'

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

  it('the sending sentinel stays form:-prefixed and carries a readable claim timestamp', () => {
    const at = 1_718_000_000_000
    const sentinel = formSendingSentinel('abc', at)
    expect(sentinel.startsWith('form:abc:sending:')).toBe(true)
    // still a placeholder to every Gmail-touching path, so a crash mid-send keeps the reply
    // worker's hold and the sweep's LIKE 'form:%' working
    expect(isFormPlaceholder(sentinel)).toBe(true)
    expect(parseSendingSentinel(sentinel)).toEqual({ claimedAtMs: at })
    expect(formSendingSentinel('abc', at)).not.toBe(formSendingSentinel('abc', at))
  })

  it('parseSendingSentinel returns null for anything that is not one of ours', () => {
    expect(parseSendingSentinel(formPlaceholderThreadId('abc'))).toBeNull()
    expect(parseSendingSentinel('1a050c80ad6eb6d0')).toBeNull()
    // a sentinel from the PREVIOUS deploy carried no timestamp: not reclaimable on a guess
    expect(parseSendingSentinel('form:abc:sending:3f1e6a4c-0d2b-4c7e-9a1f-8b5d6e7f0a1b')).toBeNull()
  })
})
