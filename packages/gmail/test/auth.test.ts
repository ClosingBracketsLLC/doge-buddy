import { generateKeyPairSync, createVerify } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createGmailAuth } from '../src/auth.ts'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const TEST_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

function fakeTokenEndpoint(capture: { body?: URLSearchParams }, token = 'tok-1') {
  return vi.fn(async (_url: string | URL, init?: RequestInit) => {
    capture.body = new URLSearchParams(String(init?.body))
    return new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), { status: 200 })
  }) as unknown as typeof fetch
}

describe('createGmailAuth', () => {
  it('sends a valid RS256 JWT with iss/sub/scope/aud claims', async () => {
    const capture: { body?: URLSearchParams } = {}
    const auth = createGmailAuth({
      saEmail: 'sa@x.iam.gserviceaccount.com', saKey: TEST_PEM, impersonate: 'admin@dogebuddy.com',
      fetchFn: fakeTokenEndpoint(capture), now: () => new Date(1_760_000_000_000),
    })
    expect(await auth.getAccessToken()).toBe('tok-1')
    const assertion = capture.body!.get('assertion')!
    const [h, c, sig] = assertion.split('.')
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString())
    expect(claims).toMatchObject({
      iss: 'sa@x.iam.gserviceaccount.com', sub: 'admin@dogebuddy.com',
      scope: 'https://www.googleapis.com/auth/gmail.modify', aud: 'https://oauth2.googleapis.com/token',
      iat: 1_760_000_000, exp: 1_760_000_000 + 3600,
    })
    const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig!, 'base64url'))
    expect(ok).toBe(true)
    expect(capture.body!.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
  })

  it('caches the token and refreshes when under 10 minutes remain', async () => {
    let t = 1_760_000_000_000
    const capture: { body?: URLSearchParams } = {}
    const fetchFn = fakeTokenEndpoint(capture)
    const auth = createGmailAuth({ saEmail: 'sa@x', saKey: TEST_PEM, impersonate: 'a@b', fetchFn, now: () => new Date(t) })
    await auth.getAccessToken(); await auth.getAccessToken()
    expect(fetchFn).toHaveBeenCalledTimes(1)          // cached
    t += 51 * 60 * 1000                               // 51 min in => <10 min left
    await auth.getAccessToken()
    expect(fetchFn).toHaveBeenCalledTimes(2)          // refreshed
  })

  it('throws GmailAuthError with status+body on a non-200 token response', async () => {
    const fetchFn = vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch
    const auth = createGmailAuth({ saEmail: 'sa@x', saKey: TEST_PEM, impersonate: 'a@b', fetchFn })
    await expect(auth.getAccessToken()).rejects.toMatchObject({ name: 'GmailAuthError', status: 400 })
  })

  it('invalidates cached token and fetches fresh token on next getAccessToken', async () => {
    const capture: { body?: URLSearchParams } = {}
    const fetchFn = fakeTokenEndpoint(capture)
    const auth = createGmailAuth({ saEmail: 'sa@x', saKey: TEST_PEM, impersonate: 'a@b', fetchFn })
    await auth.getAccessToken()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    auth.invalidate()
    await auth.getAccessToken()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})
