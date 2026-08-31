import { describe, expect, it, vi } from 'vitest'
import { TURNSTILE_VERIFY_URL, verifyTurnstile } from '../src/support/turnstile.ts'

describe('verifyTurnstile', () => {
  it('POSTs form-encoded secret/response/remoteip and returns ok on success:true', async () => {
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(TURNSTILE_VERIFY_URL)
      expect(init?.method).toBe('POST')
      const params = new URLSearchParams(String(init?.body))
      expect(params.get('secret')).toBe('sec')
      expect(params.get('response')).toBe('tok')
      expect(params.get('remoteip')).toBe('203.0.113.9')
      return new Response(JSON.stringify({ success: true, hostname: 'dogebuddy.com' }), { status: 200 })
    }) as unknown as typeof fetch
    await expect(verifyTurnstile({ secretKey: 'sec', token: 'tok', remoteIp: '203.0.113.9', fetchFn })).resolves.toEqual({ ok: true, errorCodes: [] })
  })

  it('omits remoteip when unknown and surfaces error-codes on failure', async () => {
    const fetchFn = vi.fn(async (_u: string | URL, init?: RequestInit) => {
      expect(new URLSearchParams(String(init?.body)).has('remoteip')).toBe(false)
      return new Response(JSON.stringify({ success: false, 'error-codes': ['timeout-or-duplicate'] }), { status: 200 })
    }) as unknown as typeof fetch
    await expect(verifyTurnstile({ secretKey: 'sec', token: 'tok', remoteIp: null, fetchFn })).resolves.toEqual({ ok: false, errorCodes: ['timeout-or-duplicate'] })
  })

  it('never throws: a thrown fetch, a 5xx, or a non-JSON body all fail closed', async () => {
    const boom = vi.fn(async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    await expect(verifyTurnstile({ secretKey: 's', token: 't', remoteIp: null, fetchFn: boom })).resolves.toEqual({ ok: false, errorCodes: ['network'] })
    const five = vi.fn(async () => new Response('bad gateway', { status: 502 })) as unknown as typeof fetch
    await expect(verifyTurnstile({ secretKey: 's', token: 't', remoteIp: null, fetchFn: five })).resolves.toEqual({ ok: false, errorCodes: ['network'] })
    const junk = vi.fn(async () => new Response('not json', { status: 200 })) as unknown as typeof fetch
    await expect(verifyTurnstile({ secretKey: 's', token: 't', remoteIp: null, fetchFn: junk })).resolves.toEqual({ ok: false, errorCodes: ['network'] })
  })

  it('surfaces errorCodes:["unknown"] when a 2xx body has success:false with no error-codes', async () => {
    const empty = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    await expect(verifyTurnstile({ secretKey: 's', token: 't', remoteIp: null, fetchFn: empty })).resolves.toEqual({ ok: false, errorCodes: ['unknown'] })
  })
})
