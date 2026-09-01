import { describe, expect, it, vi } from 'vitest'
import { SERPAPI_MAX_REQUESTS_PER_RUN, createSerpApiClient, scrubApiKey } from '../src/sourcing/serpapi.ts'

const FAKE_API_KEY = 'fake-serp-key-for-tests-only'

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

describe('createSerpApiClient', () => {
  it('GETs serpapi.com/search with the params plus api_key and returns the parsed JSON', async () => {
    const calls: string[] = []
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url))
      return jsonResponse({ hello: 'world' })
    })
    const client = createSerpApiClient({ apiKey: FAKE_API_KEY, fetchFn: fetchFn as unknown as typeof fetch })

    const result = await client.get({ engine: 'google_shopping', q: 'dog bed' })

    expect(result).toEqual({ hello: 'world' })
    const url = new URL(calls[0]!)
    expect(url.origin + url.pathname).toBe('https://serpapi.com/search')
    expect(url.searchParams.get('engine')).toBe('google_shopping')
    expect(url.searchParams.get('q')).toBe('dog bed')
    expect(url.searchParams.get('api_key')).toBe(FAKE_API_KEY)
    expect(client.requestsMade()).toBe(1)
  })

  it('caps at maxRequests: capped calls fire no request, count nothing, and return null', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}))
    const client = createSerpApiClient({ apiKey: FAKE_API_KEY, fetchFn: fetchFn as unknown as typeof fetch, maxRequests: 2 })

    expect(await client.get({ q: 'a' })).toEqual({})
    expect(await client.get({ q: 'b' })).toEqual({})
    expect(await client.get({ q: 'c' })).toBeNull()
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(client.requestsMade()).toBe(2)
  })

  it('defaults the cap to SERPAPI_MAX_REQUESTS_PER_RUN (25)', () => {
    expect(SERPAPI_MAX_REQUESTS_PER_RUN).toBe(25)
  })

  it('non-2xx and thrown fetches return null (never throw) and the key never reaches the error log', async () => {
    const logged: string[] = []
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
    })
    const http500 = createSerpApiClient({
      apiKey: FAKE_API_KEY,
      fetchFn: (async () => ({ ok: false, status: 500 }) as unknown as Response) as unknown as typeof fetch,
    })
    expect(await http500.get({ q: 'x' })).toBeNull()

    const throwing = createSerpApiClient({
      apiKey: FAKE_API_KEY,
      fetchFn: (async () => {
        throw new Error(`ECONNRESET talking to https://serpapi.com/search?api_key=${FAKE_API_KEY}`)
      }) as unknown as typeof fetch,
    })
    expect(await throwing.get({ q: 'x' })).toBeNull()
    expect(logged.join('\n')).not.toContain(FAKE_API_KEY)
    errSpy.mockRestore()
  })
})

describe('scrubApiKey', () => {
  it('replaces every occurrence of the key with [redacted]', () => {
    expect(scrubApiKey(`a ${FAKE_API_KEY} b ${FAKE_API_KEY}`, FAKE_API_KEY)).toBe('a [redacted] b [redacted]')
  })
  it('empty key is a no-op', () => {
    expect(scrubApiKey('text', '')).toBe('text')
  })
})
