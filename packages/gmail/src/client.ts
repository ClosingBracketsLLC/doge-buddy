import type { GmailAuth } from './auth.ts'
import type { GmailClient, HistoryRecord, NormalizedMessage } from './types.ts'
import { GmailApiError, GmailRateLimitError, HistoryExpiredError, MessageGoneError } from './errors.ts'
import { parseAddrSpecs, parseFirstAddrSpec } from './address.ts'
import { extractBodyText } from './body.ts'
import { buildReplyRaw } from './rfc2822.ts'

const BASE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me'

/** 403 reasons that mean "quota blip, try again" rather than "permission denied". */
const RATE_LIMIT_REASONS = new Set(['userRateLimitExceeded', 'rateLimitExceeded', 'dailyLimitExceeded'])

/** Order is significant — mirrors the brief's required metadataHeaders order exactly. */
const METADATA_HEADERS = [
  'From',
  'To',
  'Cc',
  'Delivered-To',
  'Subject',
  'Message-ID',
  'In-Reply-To',
  'References',
  'Authentication-Results',
]

export interface CreateGmailClientOptions {
  auth: GmailAuth
  /** Stamped as From on sendReply — required for all replies. */
  fromAddress: string
  fetchFn?: typeof fetch
}

interface GmailErrorBody {
  error?: {
    code?: number
    message?: string
    status?: string
    errors?: { reason?: string; message?: string; domain?: string }[]
  }
}

interface RawHistoryRecord {
  id: string
  messagesAdded?: { message: { id: string; threadId: string } }[]
}

interface GmailHeader {
  name: string
  value: string
}

interface GmailMessagePayload {
  mimeType?: string
  headers?: GmailHeader[]
  body?: { data?: string; attachmentId?: string; size?: number }
  parts?: GmailMessagePayload[]
}

interface RawGmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  internalDate?: string
  payload?: GmailMessagePayload
}

type Endpoint = 'listHistory' | 'getMessage' | 'other'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 200ms base + up to 400ms of jitter, per the brief's retry spec. */
function jitterDelayMs(): number {
  return 200 + Math.random() * 400
}

/** IMPORTANT 4a: every request gets its own hard timeout, well under the poll's own 5-minute
 * queue expiry (client.ts's own §2.9-adjacent concern) — a hung Gmail call must not be able to
 * keep a poll (and the singleton queue lock protecting it) alive indefinitely. */
const REQUEST_TIMEOUT_MS = 20_000

/** AbortSignal.timeout() rejects with a DOMException named 'TimeoutError' (NOT 'AbortError') —
 * this is the only abort reason the client itself can produce, since it never accepts a caller
 * signal. Any other error name is unknown and must propagate untouched. */
function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError'
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    const text = await res.text()
    return text.length > 0 ? JSON.parse(text) : null
  } catch {
    return null
  }
}

function headerValues(headers: GmailHeader[] | undefined, name: string): string[] {
  if (!headers) return []
  const lower = name.toLowerCase()
  return headers.filter((h) => h.name.toLowerCase() === lower).map((h) => h.value)
}

function firstHeader(headers: GmailHeader[] | undefined, name: string): string | null {
  const [value] = headerValues(headers, name)
  return value ?? null
}

/** Delivered-To (and, defensively, any other address header) can repeat — collect ALL occurrences. */
function addrListFromHeaders(headers: GmailHeader[] | undefined, name: string): string[] {
  const values = headerValues(headers, name)
  if (values.length === 0) return []
  return parseAddrSpecs(values.join(', '))
}

function normalizeMessage(raw: RawGmailMessage, format: 'metadata' | 'full'): NormalizedMessage {
  const headers = raw.payload?.headers
  const fromRaw = firstHeader(headers, 'From')

  return {
    id: raw.id,
    threadId: raw.threadId,
    labelIds: raw.labelIds ?? [],
    internalDate: new Date(Number(raw.internalDate ?? 0)),
    fromAddr: parseFirstAddrSpec(fromRaw),
    fromRaw,
    to: addrListFromHeaders(headers, 'To'),
    cc: addrListFromHeaders(headers, 'Cc'),
    deliveredTo: addrListFromHeaders(headers, 'Delivered-To'),
    subject: firstHeader(headers, 'Subject'),
    rfcMessageId: firstHeader(headers, 'Message-ID'),
    inReplyTo: firstHeader(headers, 'In-Reply-To'),
    references: firstHeader(headers, 'References'),
    // The topmost Authentication-Results header is Gmail's own stamp (each hop that adds one
    // prepends it) — firstHeader already returns the first/topmost occurrence. Exposed for both
    // 'metadata' and 'full' formats since support ingest fetches format:'full'.
    authenticationResults: firstHeader(headers, 'Authentication-Results'),
    // format:'metadata' never carries body content — null it explicitly rather
    // than trusting the fixture/response to omit body.data.
    bodyText: format === 'metadata' ? null : extractBodyText(raw.payload),
  }
}

export function createGmailClient(opts: CreateGmailClientOptions): GmailClient {
  const { auth, fromAddress, fetchFn = globalThis.fetch } = opts

  /**
   * Single HTTP entry point implementing the full error taxonomy:
   *   - 401            -> invalidate() + refetch token, single retry
   *   - 429 / 403-quota -> single jittered retry, then GmailRateLimitError
   *   - 403 other       -> GmailApiError (no retry — distinct from quota)
   *   - 404             -> HistoryExpiredError / MessageGoneError (endpoint-specific)
   *   - 5xx             -> single jittered retry, then GmailApiError
   */
  async function request(
    method: string,
    path: string,
    params: [string, string][],
    endpoint: Endpoint,
    body?: unknown,
  ): Promise<unknown> {
    const url = new URL(BASE_URL + path)
    for (const [key, value] of params) url.searchParams.append(key, value)

    let attemptedAuthRetry = false
    let attemptedRateRetry = false
    let attemptedServerRetry = false

    for (;;) {
      const token = await auth.getAccessToken()
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }

      let res: Response
      try {
        res = await fetchFn(url, init)
      } catch (err) {
        // A timed-out fetch throws rather than resolving with a Response — treat it like a 5xx:
        // one jittered retry (sharing the same retry budget as the 5xx path — no more attempts
        // than a garden-variety server error gets), then throw as a GmailApiError so callers don't
        // need to special-case a raw DOMException on top of the existing error taxonomy.
        if (isTimeoutError(err) && !attemptedServerRetry) {
          attemptedServerRetry = true
          await sleep(jitterDelayMs())
          continue
        }
        if (isTimeoutError(err)) {
          throw new GmailApiError('Gmail API request timed out', 0, 'timeout')
        }
        // Unknown error (not our own timeout) — the client accepts no caller signal, so there's
        // nothing else this could legitimately be. Don't retry, don't wrap: propagate as-is.
        throw err
      }

      if (res.ok) {
        if (res.status === 204) return undefined
        const text = await res.text()
        return text.length > 0 ? JSON.parse(text) : undefined
      }

      const errBody = (await safeJson(res)) as GmailErrorBody | null
      const reason = errBody?.error?.errors?.[0]?.reason ?? null
      const status = res.status

      if (status === 401 && !attemptedAuthRetry) {
        attemptedAuthRetry = true
        auth.invalidate()
        continue
      }

      const rateLimited = status === 429 || (status === 403 && reason !== null && RATE_LIMIT_REASONS.has(reason))
      if (rateLimited) {
        if (!attemptedRateRetry) {
          attemptedRateRetry = true
          await sleep(jitterDelayMs())
          continue
        }
        throw new GmailRateLimitError(errBody?.error?.message ?? 'Gmail API rate limit exceeded')
      }

      if (status >= 500 && status < 600) {
        if (!attemptedServerRetry) {
          attemptedServerRetry = true
          await sleep(jitterDelayMs())
          continue
        }
        throw new GmailApiError(errBody?.error?.message ?? `Gmail API server error (${status})`, status, reason)
      }

      if (status === 404 && endpoint === 'listHistory') throw new HistoryExpiredError()
      if (status === 404 && endpoint === 'getMessage') throw new MessageGoneError()

      throw new GmailApiError(errBody?.error?.message ?? `Gmail API error (${status})`, status, reason)
    }
  }

  return {
    async getProfile() {
      const raw = (await request('GET', '/profile', [], 'other')) as { emailAddress: string; historyId: string }
      return { emailAddress: raw.emailAddress, historyId: raw.historyId }
    },

    async listHistory(q) {
      const params: [string, string][] = [['startHistoryId', q.startHistoryId]]
      if (q.pageToken) params.push(['pageToken', q.pageToken])

      const raw = (await request('GET', '/history', params, 'listHistory')) as {
        history?: RawHistoryRecord[]
        nextPageToken?: string
      }

      const records: HistoryRecord[] = (raw.history ?? []).map((r) => ({
        id: r.id,
        messagesAdded: (r.messagesAdded ?? []).map((m) => ({ id: m.message.id, threadId: m.message.threadId })),
      }))

      return { records, nextPageToken: raw.nextPageToken }
    },

    async listMessages(q) {
      const params: [string, string][] = []
      if (q.q) params.push(['q', q.q])
      if (q.pageToken) params.push(['pageToken', q.pageToken])
      if (q.includeSpamTrash !== undefined) params.push(['includeSpamTrash', String(q.includeSpamTrash)])

      const raw = (await request('GET', '/messages', params, 'other')) as {
        messages?: { id: string; threadId: string }[]
        nextPageToken?: string
      }

      return {
        ids: (raw.messages ?? []).map((m) => ({ id: m.id, threadId: m.threadId })),
        nextPageToken: raw.nextPageToken,
      }
    },

    async getThread(threadId) {
      const raw = (await request(
        'GET',
        `/threads/${encodeURIComponent(threadId)}`,
        [['format', 'minimal']],
        'other',
      )) as { messages?: { id: string }[] }

      return { messages: (raw.messages ?? []).map((m) => ({ id: m.id })) }
    },

    async getMessage(id, opts) {
      const params: [string, string][] = [['format', opts.format]]
      if (opts.format === 'metadata') {
        for (const header of METADATA_HEADERS) params.push(['metadataHeaders', header])
      }

      const raw = (await request(
        'GET',
        `/messages/${encodeURIComponent(id)}`,
        params,
        'getMessage',
      )) as RawGmailMessage

      return normalizeMessage(raw, opts.format)
    },

    async listLabels() {
      const raw = (await request('GET', '/labels', [], 'other')) as { labels?: { id: string; name: string }[] }
      return (raw.labels ?? []).map((l) => ({ id: l.id, name: l.name }))
    },

    async createLabel(name) {
      const raw = (await request('POST', '/labels', [], 'other', { name })) as { id: string; name: string }
      return { id: raw.id, name: raw.name }
    },

    async modifyMessage(id, mods) {
      await request('POST', `/messages/${encodeURIComponent(id)}/modify`, [], 'other', {
        addLabelIds: mods.addLabelIds ?? [],
        removeLabelIds: mods.removeLabelIds ?? [],
      })
    },

    async sendReply(r) {
      const raw = buildReplyRaw({
        from: fromAddress,
        to: r.to,
        subject: r.subject,
        inReplyTo: r.inReplyTo,
        references: r.references,
        bodyText: r.bodyText,
        extraHeaders: r.extraHeaders,
      })

      const result = (await request('POST', '/messages/send', [], 'other', { raw, threadId: r.threadId })) as {
        id: string
        threadId: string
      }

      return { id: result.id, threadId: result.threadId }
    },
  }
}
