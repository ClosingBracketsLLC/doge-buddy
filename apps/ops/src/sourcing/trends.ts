/**
 * TrendsProvider: swappable Google Trends interest signal source for the sourcing pipeline.
 * `createSerpApiTrends` is the current adapter (SerpApi's `google_trends` engine, TIMESERIES
 * data type). Google's own alpha API can slot in later behind the same interface — key
 * 'google_trends_alpha' — without touching callers.
 */
export interface TrendSignal {
  keyword: string
  /** 0-100 mean interest over the window, or null when SerpApi returned nothing for the term */
  score: number | null
  snapshot: Record<string, unknown>
}

export interface TrendsProvider {
  readonly key: string // 'serpapi' now; 'google_trends_alpha' later
  fetchInterest(keywords: string[]): Promise<TrendSignal[]>
}

/**
 * Run-scoped ceiling on SerpApi requests this adapter will fire (one createSerpApiTrends()
 * instance = one sourcing run). Guards against a runaway keyword list burning the SerpApi quota
 * in a single run. Once the cap is hit, remaining batches never fire a request — their keywords
 * come back as `score: null` signals instead of throwing, so a used-up cap degrades the run
 * rather than aborting it.
 */
export const SERPAPI_MAX_REQUESTS_PER_RUN = 10

/** SerpApi's google_trends TIMESERIES engine accepts at most 5 comma-joined `q` terms per request. */
const SERPAPI_BATCH_SIZE = 5
const SERPAPI_URL = 'https://serpapi.com/search'
/** Fixed lookback window for every request this adapter makes. */
const SERPAPI_DATE_RANGE = 'today 3-m'

interface SerpApiTimelineValue {
  query?: string
  value?: string
  extracted_value?: number
}

interface SerpApiTimelinePoint {
  date?: string
  timestamp?: string
  values?: SerpApiTimelineValue[]
}

interface SerpApiTrendsResponse {
  interest_over_time?: {
    timeline_data?: SerpApiTimelinePoint[]
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

function nullSignalsFor(keywords: string[]): TrendSignal[] {
  return keywords.map((keyword) => ({ keyword, score: null, snapshot: {} }))
}

function buildUrl(keywords: string[], apiKey: string): string {
  const params = new URLSearchParams({
    engine: 'google_trends',
    data_type: 'TIMESERIES',
    q: keywords.join(','),
    date: SERPAPI_DATE_RANGE,
    api_key: apiKey,
  })
  return `${SERPAPI_URL}?${params.toString()}`
}

/** Guarantees the raw api key value can never survive into a log line or error message. */
function scrubApiKey(text: string, apiKey: string): string {
  if (!apiKey) return text
  return text.split(apiKey).join('[redacted]')
}

/**
 * Finds the `values[]` entry for `keyword` in one timeline point. Matches by the `query` field
 * SerpApi echoes back per requested term. Positional fallback (`values[batchIndex]`) is ONLY
 * valid for a genuinely untagged/legacy response shape — one where NO entry carries a `query`
 * field at all — because it assumes `values[]` is ordered exactly like the request's `q` list.
 * The instant even one entry is query-tagged, a keyword that fails the exact match must resolve
 * to undefined (-> score null), never to some other keyword's positionally-nearby entry: SerpApi
 * omits entries for terms with no data, so position drifts out of sync with the request order as
 * soon as one keyword in the batch is missing.
 */
function findValueForKeyword(
  values: SerpApiTimelineValue[] | undefined,
  keyword: string,
  batchIndex: number,
): SerpApiTimelineValue | undefined {
  if (!values || values.length === 0) return undefined
  const anyTagged = values.some((v) => v.query != null)
  if (anyTagged) return values.find((v) => v.query === keyword)
  return values[batchIndex]
}

/**
 * Builds one keyword's TrendSignal from a batch's response. `score` is the mean of that
 * keyword's numeric interest values across the window; `snapshot` is that keyword's own slice of
 * timeline points — never the raw multi-keyword response. Points with no matching or non-numeric
 * value are skipped defensively; a keyword with no usable points at all scores null.
 */
function extractSignal(keyword: string, batchIndex: number, timelineData: SerpApiTimelinePoint[]): TrendSignal {
  const points: Array<{ date?: string; value: number }> = []

  for (const point of timelineData) {
    const match = findValueForKeyword(point.values, keyword, batchIndex)
    if (!match) continue
    const numeric = typeof match.extracted_value === 'number' ? match.extracted_value : Number(match.value)
    if (Number.isFinite(numeric)) {
      points.push({ date: point.date, value: numeric })
    }
  }

  const score = points.length > 0 ? points.reduce((sum, p) => sum + p.value, 0) / points.length : null

  return { keyword, score, snapshot: { timelineData: points } }
}

/**
 * SerpApi `google_trends` adapter (TIMESERIES). Batches keywords 5 at a time (SerpApi's
 * per-request term limit), self-enforces a run-scoped SERPAPI_MAX_REQUESTS_PER_RUN cap, and
 * never throws: a capped or failed request degrades to `score: null` signals for its keywords so
 * one bad batch — or a used-up cap — never aborts the rest of the run.
 */
export function createSerpApiTrends(deps: { apiKey: string; fetchFn?: typeof fetch }): TrendsProvider {
  const { apiKey } = deps
  const fetchFn = deps.fetchFn ?? globalThis.fetch
  let requestsMade = 0

  async function fetchBatch(batch: string[]): Promise<TrendSignal[]> {
    if (requestsMade >= SERPAPI_MAX_REQUESTS_PER_RUN) {
      return nullSignalsFor(batch)
    }
    requestsMade += 1

    try {
      const res = await fetchFn(buildUrl(batch, apiKey))
      if (!res.ok) {
        throw new Error(`SerpApi responded with HTTP ${res.status}`)
      }
      const json = (await res.json()) as SerpApiTrendsResponse
      const timelineData = json.interest_over_time?.timeline_data ?? []
      return batch.map((keyword, index) => extractSignal(keyword, index, timelineData))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[serpapi-trends] request failed:', scrubApiKey(message, apiKey))
      return nullSignalsFor(batch)
    }
  }

  return {
    key: 'serpapi',
    async fetchInterest(keywords: string[]): Promise<TrendSignal[]> {
      const results: TrendSignal[] = []
      for (const batch of chunk(keywords, SERPAPI_BATCH_SIZE)) {
        results.push(...(await fetchBatch(batch)))
      }
      return results
    },
  }
}
