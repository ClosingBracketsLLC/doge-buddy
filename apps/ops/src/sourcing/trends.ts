import type { SerpApiClient } from './serpapi.ts'

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

/** One rising related query for a base keyword. `value` is SerpApi's display string ("+120%",
 *  "Breakout"); `extractedValue` its numeric form when present (absent for Breakout). */
export interface RisingQuery {
  query: string
  value: string | null
  extractedValue: number | null
}

export interface TrendsProvider {
  readonly key: string // 'serpapi' now; 'google_trends_alpha' later
  fetchInterest(keywords: string[]): Promise<TrendSignal[]>
  /** Rising related queries for ONE keyword (RELATED_QUERIES takes a single q per request,
   *  unlike TIMESERIES's 5-comma batch). null = client could not look (cap/HTTP); [] = looked,
   *  nothing rising. FIXTURE-ASSUMPTION on the rising[] shape — verify on the first live run. */
  fetchRisingQueries(keyword: string): Promise<RisingQuery[] | null>
}

/** SerpApi's google_trends TIMESERIES engine accepts at most 5 comma-joined `q` terms per request. */
const SERPAPI_BATCH_SIZE = 5
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

interface SerpApiRelatedQueriesResponse {
  related_queries?: {
    rising?: Array<{ query?: string; value?: string | number; extracted_value?: number }>
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
 * SerpApi `google_trends` adapter (TIMESERIES). Batches keywords 5 at a time and never throws: a
 * failed request — or a client whose shared per-run cap is spent — yields `score: null` signals for
 * that batch's keywords, so trends problems degrade the run rather than aborting it. The request
 * budget itself lives on the SHARED SerpApiClient (serpapi.ts), spent jointly with the
 * market-price provider; one instance of the client = one run.
 */
export function createSerpApiTrends(deps: { client: SerpApiClient }): TrendsProvider {
  const { client } = deps

  async function fetchBatch(batch: string[]): Promise<TrendSignal[]> {
    const json = (await client.get({
      engine: 'google_trends',
      data_type: 'TIMESERIES',
      q: batch.join(','),
      date: SERPAPI_DATE_RANGE,
    })) as SerpApiTrendsResponse | null
    if (json === null) return nullSignalsFor(batch)
    const timelineData = json.interest_over_time?.timeline_data ?? []
    return batch.map((keyword, index) => extractSignal(keyword, index, timelineData))
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
    async fetchRisingQueries(keyword: string): Promise<RisingQuery[] | null> {
      const json = (await client.get({
        engine: 'google_trends',
        data_type: 'RELATED_QUERIES',
        q: keyword,
        date: SERPAPI_DATE_RANGE,
      })) as SerpApiRelatedQueriesResponse | null
      if (json === null) return null
      const rising: RisingQuery[] = []
      for (const entry of json.related_queries?.rising ?? []) {
        if (typeof entry.query !== 'string' || entry.query.trim().length === 0) continue
        rising.push({
          query: entry.query.trim(),
          value: entry.value != null ? String(entry.value) : null,
          extractedValue: typeof entry.extracted_value === 'number' && Number.isFinite(entry.extracted_value) ? entry.extracted_value : null,
        })
      }
      return rising
    },
  }
}
