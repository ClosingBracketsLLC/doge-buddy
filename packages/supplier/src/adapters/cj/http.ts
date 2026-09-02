import { CjApiError, CjPointsBudgetExceededError } from './errors.ts'

export interface StoredCjTokens {
  accessToken: string
  accessExpiresAt: string
  refreshToken: string
  refreshExpiresAt: string
}

export interface CjTokenStore {
  load(): Promise<StoredCjTokens | null>
  save(tokens: StoredCjTokens): Promise<void>
  /** Discards any stored tokens so the next `load()` returns null, forcing a full
   * re-authentication. Called by CjHttpClient when CJ rejects the current access token
   * (HTTP 401) so a stale/revoked token is never reused on retry. */
  invalidate(): Promise<void>
}

/** In-memory CjTokenStore used for tests/dev. Not for production (no persistence across restarts). */
export class InMemoryCjTokenStore implements CjTokenStore {
  private tokens: StoredCjTokens | null = null

  async load(): Promise<StoredCjTokens | null> {
    return this.tokens
  }

  async save(tokens: StoredCjTokens): Promise<void> {
    this.tokens = tokens
  }

  async invalidate(): Promise<void> {
    this.tokens = null
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

type CjHttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export interface CjHttpClientOptions {
  apiKey: string
  tokenStore: CjTokenStore
  fetchImpl?: FetchLike
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  rps?: number
  dailyPointsBudget?: number
  baseUrl?: string
}

export interface CjRequestOptions {
  query?: Record<string, string | number | undefined>
  body?: unknown
  points?: number
  priority?: boolean
}

interface CjEnvelope<T> {
  code: number
  result: boolean
  message: string
  data: T
  requestId?: string
}

interface CjAuthResponse {
  accessToken: string
  accessTokenExpiryDate: string
  refreshToken: string
  refreshTokenExpiryDate: string
}

const DEFAULT_BASE_URL = 'https://developers.cjdropshipping.com/api2.0/v1'
const DEFAULT_RPS = 1
const DEFAULT_DAILY_POINTS_BUDGET = 50_000
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000
// 5 attempts with a 1s base (waits 1s, 2s, 4s, 8s — 15s of patience total). The old 3×500ms
// schedule (~1.5s) was outlasted by CJ's sustained limiting during the 2026-09-02 backfill run:
// a ~90-call burst left a few reads hitting "retries exhausted" on every rerun, roving across
// variants. Callers that aren't rate-limited pay nothing — the backoff only runs on a 429.
const MAX_429_ATTEMPTS = 5
const BACKOFF_429_BASE_MS = 1000

/**
 * CJ Dropshipping HTTP client: owns token lifecycle (getAccessToken / refreshAccessToken),
 * per-account rate limiting (1 rps free tier), the daily points budget, and the
 * {code, result, message, data, requestId} envelope. All effects (fetch, clock, sleep) are
 * injected so tests never touch real timers or the network.
 */
export class CjHttpClient {
  private readonly apiKey: string
  private readonly tokenStore: CjTokenStore
  private readonly fetchImpl: FetchLike
  private readonly now: () => Date
  private readonly sleep: (ms: number) => Promise<void>
  private readonly rps: number
  private readonly dailyPointsBudget: number
  private readonly baseUrl: string

  private lastRequestAt: number | null = null
  private inFlightAuth: Promise<string> | null = null
  private spentToday = 0
  private spentDateUtc: string | null = null

  constructor(opts: CjHttpClientOptions) {
    this.apiKey = opts.apiKey
    this.tokenStore = opts.tokenStore
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init))
    this.now = opts.now ?? (() => new Date())
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.rps = opts.rps ?? DEFAULT_RPS
    this.dailyPointsBudget = opts.dailyPointsBudget ?? DEFAULT_DAILY_POINTS_BUDGET
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL
  }

  async request<T = any>(method: CjHttpMethod, path: string, opts: CjRequestOptions = {}): Promise<T> {
    const points = opts.points ?? 0
    const priority = opts.priority ?? false

    this.resetPointsIfNewDay()
    if (!priority && this.spentToday + points > this.dailyPointsBudget) {
      throw new CjPointsBudgetExceededError(
        `CJ daily points budget exceeded: spent=${this.spentToday} + points=${points} > budget=${this.dailyPointsBudget}`,
      )
    }

    const data = await this.requestWithAuthRetry<T>(method, path, opts)

    this.spentToday += points
    return data
  }

  /** Issues the request with the current token. On HTTP 401 (CJ rejected the access token —
   * e.g. revoked-but-unexpired), invalidates the token store and retries exactly once with a
   * freshly obtained token; a second 401 propagates as-is. Non-auth errors (rate limits,
   * envelope failures, other HTTP errors) are untouched by this path. */
  private async requestWithAuthRetry<T>(method: CjHttpMethod, path: string, opts: CjRequestOptions): Promise<T> {
    const accessToken = await this.ensureToken()
    try {
      return await this.doHttp<T>(method, path, {
        query: opts.query,
        body: opts.body,
        headers: { 'CJ-Access-Token': accessToken },
      })
    } catch (err) {
      if (!(err instanceof CjApiError) || err.code !== 401) throw err

      await this.tokenStore.invalidate()
      const retryToken = await this.ensureToken()
      return await this.doHttp<T>(method, path, {
        query: opts.query,
        body: opts.body,
        headers: { 'CJ-Access-Token': retryToken },
      })
    }
  }

  pointsSpentToday(): number {
    this.resetPointsIfNewDay()
    return this.spentToday
  }

  // --- Sandbox helpers (Task 6 harness) -----------------------------------

  async simulatePay(orderId: string): Promise<unknown> {
    return this.request('POST', '/shopping/sandbox/simulatePay', { body: { orderId }, points: 0, priority: true })
  }

  async sandboxUpdateStatus(orderId: string, targetStatus: number): Promise<unknown> {
    return this.request('POST', '/shopping/sandbox/updateStatus', {
      body: { orderId, targetStatus },
      points: 0,
      priority: true,
    })
  }

  async sandboxUpdateTrackNumber(orderId: string, trackNumber: string): Promise<unknown> {
    return this.request('POST', '/shopping/sandbox/updateTrackNumber', {
      body: { orderId, trackNumber },
      points: 0,
      priority: true,
    })
  }

  // --- Token lifecycle ------------------------------------------------------

  private async ensureToken(): Promise<string> {
    if (this.inFlightAuth) return this.inFlightAuth
    const promise = this.doEnsureToken()
    this.inFlightAuth = promise
    try {
      return await promise
    } finally {
      this.inFlightAuth = null
    }
  }

  private async doEnsureToken(): Promise<string> {
    const stored = await this.tokenStore.load()
    if (!stored) {
      return this.authenticate('getAccessToken', { apiKey: this.apiKey })
    }

    const accessExpiresAtMs = new Date(stored.accessExpiresAt).getTime()
    const nowMs = this.now().getTime()
    if (accessExpiresAtMs - nowMs >= TWO_DAYS_MS) {
      return stored.accessToken
    }

    const refreshExpiresAtMs = new Date(stored.refreshExpiresAt).getTime()
    if (refreshExpiresAtMs > nowMs) {
      try {
        return await this.authenticate('refreshAccessToken', { refreshToken: stored.refreshToken })
      } catch {
        // fall through to a full re-authentication below
      }
    }
    return this.authenticate('getAccessToken', { apiKey: this.apiKey })
  }

  private async authenticate(kind: 'getAccessToken' | 'refreshAccessToken', body: unknown): Promise<string> {
    const data = await this.doHttp<CjAuthResponse>('POST', `/authentication/${kind}`, { body })
    const tokens: StoredCjTokens = {
      accessToken: data.accessToken,
      accessExpiresAt: new Date(data.accessTokenExpiryDate).toISOString(),
      refreshToken: data.refreshToken,
      refreshExpiresAt: new Date(data.refreshTokenExpiryDate).toISOString(),
    }
    await this.tokenStore.save(tokens)
    return tokens.accessToken
  }

  // --- Rate limiting ----------------------------------------------------

  private async throttle(): Promise<void> {
    const minIntervalMs = 1000 / this.rps
    if (this.lastRequestAt !== null) {
      const elapsed = this.now().getTime() - this.lastRequestAt
      if (elapsed < minIntervalMs) {
        await this.sleep(minIntervalMs - elapsed)
      }
    }
    this.lastRequestAt = this.now().getTime()
  }

  // --- Points budget ------------------------------------------------------

  private resetPointsIfNewDay(): void {
    const today = this.now().toISOString().slice(0, 10) // UTC YYYY-MM-DD
    if (this.spentDateUtc !== today) {
      this.spentDateUtc = today
      this.spentToday = 0
    }
  }

  // --- HTTP + envelope ------------------------------------------------------

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    let url = `${this.baseUrl}${path}`
    if (query) {
      const parts: string[] = []
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      }
      if (parts.length > 0) url += `?${parts.join('&')}`
    }
    return url
  }

  private async doHttp<T>(
    method: CjHttpMethod,
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const url = this.buildUrl(path, opts.query)
    const init: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json', ...opts.headers },
    }
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body)
    }

    await this.throttle()

    let attempt = 0
    for (;;) {
      const res = await this.fetchImpl(url, init)

      if (res.status === 429) {
        attempt += 1
        if (attempt >= MAX_429_ATTEMPTS) {
          throw new CjApiError(429, 'CJ API rate limited (429): retries exhausted')
        }
        await this.sleep(BACKOFF_429_BASE_MS * 2 ** (attempt - 1))
        continue
      }

      if (!res.ok) {
        throw new CjApiError(res.status, `CJ API HTTP error ${res.status}`)
      }

      const envelope = (await res.json()) as CjEnvelope<T>
      if (envelope.code !== 200 || envelope.result === false) {
        throw new CjApiError(envelope.code, envelope.message, envelope.requestId)
      }
      return envelope.data
    }
  }
}
