export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface ShopifyTokenManagerOptions {
  shopDomain: string
  clientId: string
  clientSecret: string
  fetchImpl?: FetchLike
  now?: () => Date
}

interface CachedToken {
  token: string
  expiresAtMs: number
}

interface AccessTokenResponse {
  access_token: string
  expires_in: number
}

const REFRESH_WINDOW_MS = 300_000

/**
 * Manages a Shopify Admin API client-credentials access token: fetches it on first use,
 * caches it, and transparently refreshes it 5 minutes before expiry. Concurrent getToken()
 * calls while a fetch is in flight share the same request instead of firing duplicates.
 */
export class ShopifyTokenManager {
  private readonly shopDomain: string
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly fetchImpl: FetchLike
  private readonly now: () => Date

  private cached: CachedToken | null = null
  private inFlight: Promise<string> | null = null

  constructor(opts: ShopifyTokenManagerOptions) {
    this.shopDomain = opts.shopDomain
    this.clientId = opts.clientId
    this.clientSecret = opts.clientSecret
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init))
    this.now = opts.now ?? (() => new Date())
  }

  async getToken(): Promise<string> {
    if (this.inFlight) return this.inFlight

    const nowMs = this.now().getTime()
    if (this.cached && nowMs < this.cached.expiresAtMs - REFRESH_WINDOW_MS) {
      return this.cached.token
    }

    const promise = this.fetchToken()
    this.inFlight = promise
    try {
      return await promise
    } finally {
      this.inFlight = null
    }
  }

  invalidate(): void {
    this.cached = null
  }

  private async fetchToken(): Promise<string> {
    const url = `https://${this.shopDomain}/admin/oauth/access_token`
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'client_credentials',
      }),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(
        `Shopify token request failed: ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`,
      )
    }

    const data = (await response.json()) as AccessTokenResponse
    const nowMs = this.now().getTime()
    this.cached = { token: data.access_token, expiresAtMs: nowMs + data.expires_in * 1000 }
    return data.access_token
  }
}
