import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSerpApiTrends, SERPAPI_MAX_REQUESTS_PER_RUN } from '../src/sourcing/trends.ts'

// Never a real key — SerpApi calls are always mocked via fetchFn in this suite.
const FAKE_API_KEY = 'fake-serp-key-for-tests-only'

interface FixturePoint {
  date: string
  values: Array<{ query: string; extracted_value: number }>
}

function serpApiFixture(entries: FixturePoint[]) {
  return {
    interest_over_time: {
      timeline_data: entries.map((e) => ({ date: e.date, values: e.values })),
    },
  }
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response
}

describe('createSerpApiTrends', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exposes key "serpapi"', () => {
    const provider = createSerpApiTrends({ apiKey: FAKE_API_KEY, fetchFn: vi.fn() as unknown as typeof fetch })
    expect(provider.key).toBe('serpapi')
  })

  it('batches keywords 5 at a time, comma-joined into q — 7 keywords => exactly 2 requests (5 + 2)', async () => {
    const calls: string[] = []
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url))
      return jsonResponse(serpApiFixture([]))
    })
    const provider = createSerpApiTrends({ apiKey: FAKE_API_KEY, fetchFn: fetchFn as unknown as typeof fetch })

    await provider.fetchInterest(['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7'])

    expect(fetchFn).toHaveBeenCalledTimes(2)
    const url1 = new URL(calls[0]!)
    const url2 = new URL(calls[1]!)
    expect(url1.searchParams.get('q')).toBe('k1,k2,k3,k4,k5')
    expect(url2.searchParams.get('q')).toBe('k6,k7')
    expect(url1.searchParams.get('engine')).toBe('google_trends')
    expect(url1.searchParams.get('data_type')).toBe('TIMESERIES')
    expect(url1.searchParams.get('date')).toBe('today 3-m')
    expect(url1.searchParams.get('api_key')).toBe(FAKE_API_KEY)
  })

  it('scores each keyword as the mean of its timeline values; snapshot is the per-keyword slice, not the whole response', async () => {
    const fixture = serpApiFixture([
      {
        date: 'Week 1',
        values: [
          { query: 'dog leash', extracted_value: 20 },
          { query: 'cat tree', extracted_value: 40 },
        ],
      },
      {
        date: 'Week 2',
        values: [
          { query: 'dog leash', extracted_value: 30 },
          { query: 'cat tree', extracted_value: 60 },
        ],
      },
    ])
    const fetchFn = vi.fn(async () => jsonResponse(fixture))
    const provider = createSerpApiTrends({ apiKey: FAKE_API_KEY, fetchFn: fetchFn as unknown as typeof fetch })

    const [leash, tree] = await provider.fetchInterest(['dog leash', 'cat tree'])

    expect(leash!.score).toBe(25) // mean(20, 30)
    expect(tree!.score).toBe(50) // mean(40, 60)

    // Snapshot must be a per-keyword slice, never the raw multi-keyword response.
    expect(leash!.snapshot).not.toEqual(fixture)
    expect(JSON.stringify(leash!.snapshot)).not.toContain('cat tree')
    expect(JSON.stringify(tree!.snapshot)).not.toContain('dog leash')
  })

  it('maps defensively: a keyword absent from the response series scores null while its batch-mate still scores', async () => {
    const fixture = serpApiFixture([{ date: 'Week 1', values: [{ query: 'dog leash', extracted_value: 10 }] }])
    const fetchFn = vi.fn(async () => jsonResponse(fixture))
    const provider = createSerpApiTrends({ apiKey: FAKE_API_KEY, fetchFn: fetchFn as unknown as typeof fetch })

    const [leash, ghost] = await provider.fetchInterest(['dog leash', 'ghost keyword'])

    expect(leash!.score).toBe(10)
    expect(ghost!.score).toBeNull()
    expect(ghost!.snapshot).toEqual({ timelineData: [] })
  })

  it('does not mis-key: a missing keyword FIRST in the batch never inherits its batch-mate\'s tagged entry by position', async () => {
    // 'real' is tagged and occupies index 0 of `values` (SerpApi omits entries for terms with no
    // data — it does not pad with holes). 'ghost' is requested first (batchIndex 0) but has no
    // data. A naive `values[batchIndex]` fallback would wrongly hand 'ghost' the entry tagged for
    // 'real'. Since at least one entry in `values` carries `query`, no positional guessing is
    // allowed at all — 'ghost' must resolve to null, not to 40.
    const fixture = serpApiFixture([{ date: 'Week 1', values: [{ query: 'real', extracted_value: 40 }] }])
    const fetchFn = vi.fn(async () => jsonResponse(fixture))
    const provider = createSerpApiTrends({ apiKey: FAKE_API_KEY, fetchFn: fetchFn as unknown as typeof fetch })

    const [ghost, real] = await provider.fetchInterest(['ghost', 'real'])

    expect(ghost!.score).toBeNull()
    expect(ghost!.snapshot).toEqual({ timelineData: [] })
    expect(real!.score).toBe(40)
  })

  it('resolves positionally only for a genuinely untagged/legacy response shape (no values[] entry carries a query field)', async () => {
    const untagged = {
      interest_over_time: {
        timeline_data: [
          { date: 'Week 1', values: [{ extracted_value: 15 }, { extracted_value: 35 }] },
          { date: 'Week 2', values: [{ extracted_value: 25 }, { extracted_value: 45 }] },
        ],
      },
    }
    const fetchFn = vi.fn(async () => jsonResponse(untagged))
    const provider = createSerpApiTrends({ apiKey: FAKE_API_KEY, fetchFn: fetchFn as unknown as typeof fetch })

    const [first, second] = await provider.fetchInterest(['first kw', 'second kw'])

    expect(first!.score).toBe(20) // mean(15, 25) — resolved by position 0
    expect(second!.score).toBe(40) // mean(35, 45) — resolved by position 1
  })

  it(`caps requests at SERPAPI_MAX_REQUESTS_PER_RUN (${SERPAPI_MAX_REQUESTS_PER_RUN}); tail keywords beyond the cap come back score: null with no request fired`, async () => {
    const fetchFn = vi.fn(async () => jsonResponse(serpApiFixture([])))
    const provider = createSerpApiTrends({ apiKey: FAKE_API_KEY, fetchFn: fetchFn as unknown as typeof fetch })

    const keywords = Array.from({ length: 60 }, (_, i) => `kw${i}`)
    const signals = await provider.fetchInterest(keywords)

    // 60 keywords / 5 per batch = 12 batches; only the first 10 are allowed to fire.
    expect(fetchFn).toHaveBeenCalledTimes(SERPAPI_MAX_REQUESTS_PER_RUN)
    expect(signals).toHaveLength(60)
    expect(signals.map((s) => s.keyword)).toEqual(keywords)

    const tail = signals.slice(SERPAPI_MAX_REQUESTS_PER_RUN * 5) // kw50..kw59, never requested
    expect(tail).toHaveLength(10)
    expect(tail.every((s) => s.score === null)).toBe(true)
  })

  it('does not throw on fetch rejection; that batch comes back score: null and the api key never appears in a log line', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      throw new Error(`network down while calling ${String(url)}`)
    })
    const provider = createSerpApiTrends({ apiKey: FAKE_API_KEY, fetchFn: fetchFn as unknown as typeof fetch })

    const signals = await provider.fetchInterest(['a', 'b'])

    expect(signals).toEqual([
      { keyword: 'a', score: null, snapshot: {} },
      { keyword: 'b', score: null, snapshot: {} },
    ])

    expect(errSpy).toHaveBeenCalled()
    for (const call of errSpy.mock.calls) {
      const serialized = call.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
      expect(serialized).not.toContain(FAKE_API_KEY)
    }
  })
})
