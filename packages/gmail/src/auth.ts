import { createSign } from 'node:crypto'

export class GmailAuthError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string,
  ) {
    super(message)
    this.name = 'GmailAuthError'
  }
}

export interface GmailAuth {
  getAccessToken(): Promise<string>
  invalidate(): void
}

interface CachedToken {
  token: string
  expiresAtMs: number
}

export interface CreateGmailAuthOptions {
  saEmail: string
  saKey: string
  impersonate: string
  fetchFn?: typeof fetch
  now?: () => Date
}

export function createGmailAuth(opts: CreateGmailAuthOptions): GmailAuth {
  const {
    saEmail,
    saKey,
    impersonate,
    fetchFn = typeof globalThis !== 'undefined' ? globalThis.fetch : undefined,
    now = () => new Date(),
  } = opts

  let cached: CachedToken | null = null

  function shouldRefresh(): boolean {
    if (!cached) return true
    const tenMinutesMs = 10 * 60 * 1000
    return now().getTime() >= cached.expiresAtMs - tenMinutesMs
  }

  function createJwt(): string {
    const nowDate = now()
    const nowSec = Math.floor(nowDate.getTime() / 1000)
    const expSec = nowSec + 3600 // 1 hour

    const header = JSON.stringify({ alg: 'RS256', typ: 'JWT' })
    const claims = JSON.stringify({
      iss: saEmail,
      sub: impersonate,
      scope: 'https://www.googleapis.com/auth/gmail.modify',
      aud: 'https://oauth2.googleapis.com/token',
      iat: nowSec,
      exp: expSec,
    })

    const headerB64 = Buffer.from(header).toString('base64url')
    const claimsB64 = Buffer.from(claims).toString('base64url')
    const message = `${headerB64}.${claimsB64}`

    const signer = createSign('RSA-SHA256')
    signer.update(message)
    const signatureB64 = signer.sign(saKey, 'base64url')

    return `${message}.${signatureB64}`
  }

  async function fetchToken(): Promise<string> {
    if (!fetchFn) {
      throw new Error('fetch function not available')
    }

    const jwt = createJwt()
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    })

    const response = await fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })

    if (!response.ok) {
      const bodyText = await response.text()
      throw new GmailAuthError(
        `Failed to get access token`,
        response.status,
        bodyText,
      )
    }

    const data = (await response.json()) as { access_token: string; expires_in: number }
    const expiresAtMs = now().getTime() + data.expires_in * 1000

    cached = {
      token: data.access_token,
      expiresAtMs,
    }

    return data.access_token
  }

  return {
    async getAccessToken(): Promise<string> {
      if (!shouldRefresh()) {
        return cached!.token
      }
      return fetchToken()
    },

    invalidate(): void {
      cached = null
    },
  }
}
