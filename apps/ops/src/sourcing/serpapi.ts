/**
 * Shared per-run SerpApi HTTP client (spec 2026-09-01 market-price §1 / Decision 7). ONE instance
 * serves both the trends provider (Stage 3) and the market-price provider (Stage 5's MCP tool), so
 * the request cap below is the RUN total across both. One instance = one run — the counter never
 * resets (Phase 5 FIX C2), so composition roots construct a fresh client per pipeline run.
 */
export const SERPAPI_MAX_REQUESTS_PER_RUN = 25

const SERPAPI_URL = 'https://serpapi.com/search'

export interface SerpApiClient {
  /** GET SERPAPI_URL with `params` + api_key. Returns parsed JSON, or null when the run cap is
   *  reached (no request fired, nothing counted), the response is non-2xx, or fetch/json throws.
   *  NEVER throws — a SerpApi problem degrades the caller, it must not abort a paid run. */
  get(params: Record<string, string>): Promise<unknown | null>
  requestsMade(): number
}

/** Guarantees the raw api key value can never survive into a log line or error message. */
export function scrubApiKey(text: string, apiKey: string): string {
  if (!apiKey) return text
  return text.split(apiKey).join('[redacted]')
}

export function createSerpApiClient(deps: { apiKey: string; fetchFn?: typeof fetch; maxRequests?: number }): SerpApiClient {
  const { apiKey } = deps
  const fetchFn = deps.fetchFn ?? globalThis.fetch
  const maxRequests = deps.maxRequests ?? SERPAPI_MAX_REQUESTS_PER_RUN
  let requestsMade = 0

  return {
    async get(params: Record<string, string>): Promise<unknown | null> {
      if (requestsMade >= maxRequests) return null
      requestsMade += 1
      try {
        const search = new URLSearchParams({ ...params, api_key: apiKey })
        const res = await fetchFn(`${SERPAPI_URL}?${search.toString()}`)
        if (!res.ok) throw new Error(`SerpApi responded with HTTP ${res.status}`)
        return (await res.json()) as unknown
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[serpapi] request failed:', scrubApiKey(message, apiKey))
        return null
      }
    },
    requestsMade: () => requestsMade,
  }
}
