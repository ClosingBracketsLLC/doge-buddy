/** Cloudflare Turnstile server-side verification (spec 2026-08-31 §2 step 3). */
export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const DEFAULT_TIMEOUT_MS = 5_000

export interface VerifyTurnstileInput {
  secretKey: string
  token: string
  remoteIp: string | null
  fetchFn?: typeof fetch
  timeoutMs?: number
}

/**
 * Fails CLOSED: any transport problem is `ok:false` with `['network']` — the caller answers 400
 * and the visitor retries. Tokens are single-use on Cloudflare's side, so a replayed submission
 * fails here by construction.
 */
export async function verifyTurnstile(input: VerifyTurnstileInput): Promise<{ ok: boolean; errorCodes: string[] }> {
  const fetchFn = input.fetchFn ?? fetch
  const body = new URLSearchParams({ secret: input.secretKey, response: input.token })
  if (input.remoteIp) body.set('remoteip', input.remoteIp)
  try {
    const res = await fetchFn(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, errorCodes: ['network'] }
    const json = (await res.json()) as { success?: boolean; 'error-codes'?: string[] }
    return { ok: json.success === true, errorCodes: json.success === true ? [] : (json['error-codes'] ?? ['unknown']) }
  } catch {
    return { ok: false, errorCodes: ['network'] }
  }
}
