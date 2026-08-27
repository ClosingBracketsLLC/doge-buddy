import { orders, proposals, supportMessages, type createDb } from '@doge-buddy/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { SupportOutput } from '../agents/support-output-schema.ts'

type Db = ReturnType<typeof createDb>['db']

export type ValidationFailure = { ok: false; code: string; detail: string }
export type ValidationResult = { ok: true } | ValidationFailure

function fail(code: string, detail: string): ValidationFailure {
  return { ok: false, code, detail }
}

// -- Plain text --

const MAX_BODY_LEN = 4000
/** Any HTML-tag-looking opener: `<b`, `<!--`, `</p`, etc. A drafted reply is plain text only —
 * nothing here is ever rendered as HTML, so a literal `<` followed by a tag-ish character is
 * always wrong, not a false positive worth tolerating. Exception: `<https://...>` / `<http://...>`
 * — angle brackets wrapped around a URL (a common plain-text convention for delimiting a link from
 * surrounding punctuation) are not HTML; the URL/domain screen still fully screens what's inside.
 */
const HTML_TAG_RE = /<(?!https?:\/\/)[a-z!/]/i

// -- Promised-action screen --

/** Verbs/nouns describing an ACTION that resolves the customer's issue. Includes both active
 * ("cancel your order") and passive/perfect ("order has been cancelled") phrasings for
 * cancellation, and the shipped-replacement completion phrase — natural ways a drafted reply
 * reports an action as done, not just requested. */
const ACTION_RE =
  /refund(ed)?|reimburs\w*|credit(ed)?|store credit|money back|compensat\w*|replacement|reship\w*|resend|cancel\w* (your|the) order|order (has been|was|is) cancel\w*|replacement has (been )?shipped|payment (returned|reversed)|funds/gi
/** Words that PROMISE the action already happened or is imminent — the combination is what makes
 * a drafted reply a commitment rather than an explanation of policy. */
const PROMISE_RE =
  /issued|processed|sent|approved|applied|on its way|on the way|within \d+ (business )?days|has been|have been|we have|we've|i've|is complete|has shipped|expect (it|the funds|your (refund|money))|funds back|will be/gi
/** How close an ACTION token and a PROMISE token must be (in whitespace-normalized chars) to
 * count as one promised-action hit. */
const PROMISE_PROXIMITY_CHARS = 200

const LIVE_REFUND_PROPOSAL_STATUSES = ['pending', 'approved', 'applying', 'applied'] as const

// -- URL / domain screen --

const SCHEMED_URL_RE = /https?:\/\/\S+/gi
const ALLOWED_HOSTNAMES = new Set(['dogebuddy.com', 'www.dogebuddy.com'])
const BARE_DOMAIN_RE = /\b[a-z0-9-]+(\.[a-z0-9-]+)+\b/gi
const PLAUSIBLE_TLDS = new Set([
  'com', 'net', 'org', 'io', 'co', 'shop', 'store', 'info', 'biz', 'us', 'uk', 'de', 'xyz', 'me', 'app', 'dev',
  'link', 'site',
])
/** Trailing punctuation that's prose, not part of the URL: `Track it here: https://dogebuddy.com.`
 * — the sentence-ending period is not part of the link. */
const TRAILING_URL_PUNCT_RE = /[.,;:!?)\]}'"]+$/

// -- Contact screen --

const EMAIL_RE = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g
const ALLOWED_EMAIL_SUFFIX = '@dogebuddy.com'
/** A phone-like run of digits/separators. Deliberately loose (it has to catch `+1 (888)
 * 555-0142`) — the extra checks in `isPhoneLikeCandidate` are what keep `order #12345`, ISO dates,
 * and long unseparated digit runs (tracking numbers, `1Z999AA10123456784`) from tripping it. */
const PHONE_RE = /[+(]?\d[\d\s().-]{6,}\d/g
const PHONE_MIN_DIGITS = 7
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** A separator character INSIDE a candidate match (space, parens, dot, dash) — distinct from a
 * leading `+`/`(`, which `isPhoneLikeCandidate` checks separately. */
const PHONE_SEPARATOR_RE = /[\s().-]/

interface Span {
  start: number
  end: number
}

function overlapsAnySpan(start: number, end: number, spans: Span[]): boolean {
  return spans.some((s) => start >= s.start && end <= s.end)
}

function findMatches(re: RegExp, text: string): Span[] {
  const out: Span[] = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    out.push({ start: m.index, end: m.index + m[0].length })
  }
  return out
}

/** Character gap between two spans; 0 when they overlap or touch. */
function gapBetween(a: Span, b: Span): number {
  if (a.end <= b.start) return b.start - a.end
  if (b.end <= a.start) return a.start - b.end
  return 0
}

function hasPromisedActionHit(normalizedBody: string): boolean {
  const actions = findMatches(ACTION_RE, normalizedBody)
  if (actions.length === 0) return false
  const promises = findMatches(PROMISE_RE, normalizedBody)
  if (promises.length === 0) return false

  for (const a of actions) {
    for (const p of promises) {
      if (gapBetween(a, p) <= PROMISE_PROXIMITY_CHARS) return true
    }
  }
  return false
}

async function hasLiveSiblingRefundProposal(db: Db, ticketId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(
      and(
        eq(proposals.ticketId, ticketId),
        eq(proposals.type, 'refund'),
        inArray(proposals.status, [...LIVE_REFUND_PROPOSAL_STATUSES]),
      ),
    )
    .limit(1)
  return row !== undefined
}

/** Strips prose wrapping off a URL-ish regex match before it's parsed/compared: a trailing
 * sentence-punctuation run (`https://dogebuddy.com.` → `https://dogebuddy.com`), and a trailing
 * `>` when the character immediately before the match is its opening `<` (`<https://.../help>` →
 * `https://.../help`) — angle brackets are a plain-text link delimiter, not part of the URL. */
function stripUrlToken(body: string, raw: string, matchStart: number): string {
  let s = raw
  if (body[matchStart - 1] === '<' && s.endsWith('>')) s = s.slice(0, -1)
  s = s.replace(TRAILING_URL_PUNCT_RE, '')
  return s
}

/** Schemed-URL allowlist check: https + hostname dogebuddy.com/www.dogebuddy.com, OR byte-equal
 * to the ticket's own tracking URL (e.g. a carrier tracking link that is legitimately off-domain). */
function isAllowedSchemedUrl(raw: string, trackingUrl: string | null): boolean {
  if (trackingUrl !== null && raw === trackingUrl) return true
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'https:' && ALLOWED_HOSTNAMES.has(parsed.hostname)
  } catch {
    return false
  }
}

interface UrlScreenData {
  /** Spans (over the ORIGINAL body, stripped-length) of every schemed URL that passed the
   * allowlist — shared with the contact screen's phone check so digits inside an allowed link
   * (tracking numbers, order refs in a query string) are never misread as a phone number. */
  allowedSpans: Span[]
  /** Raw text of the first schemed URL that did NOT pass the allowlist, or null if all did. */
  disallowedRaw: string | null
}

/** Scans every schemed URL in the body once, up front — shared by the contact screen (phone
 * digits inside an allowed URL are exempt) and the URL/domain screen (which owns reporting the
 * actual `url_not_allowed` failure). Does not short-circuit on the first bad URL: all allowed
 * spans are still collected so the contact screen sees the full picture regardless of ordering. */
function scanSchemedUrls(body: string, trackingUrl: string | null): UrlScreenData {
  const allowedSpans: Span[] = []
  let disallowedRaw: string | null = null

  const re = new RegExp(SCHEMED_URL_RE)
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    const matchStart = m.index
    const stripped = stripUrlToken(body, m[0], matchStart)
    if (isAllowedSchemedUrl(stripped, trackingUrl)) {
      allowedSpans.push({ start: matchStart, end: matchStart + stripped.length })
    } else if (disallowedRaw === null) {
      disallowedRaw = m[0]
    }
  }

  return { allowedSpans, disallowedRaw }
}

function checkUrlsAndDomains(body: string, urlData: UrlScreenData): ValidationResult {
  if (urlData.disallowedRaw !== null) {
    return fail('url_not_allowed', `disallowed URL in reply body: ${urlData.disallowedRaw}`)
  }

  const domainRe = new RegExp(BARE_DOMAIN_RE)
  domainRe.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = domainRe.exec(body))) {
    const raw = m[0]
    const start = m.index
    const end = start + raw.length
    // Already covered by an allowed schemed URL (e.g. the query string of an allowed tracking
    // link) — not a second, independent domain mention. Deliberately NOT skipped just because the
    // token is preceded by `@` (an `@bare-domain.tld` mention with no local part, e.g. a Telegram
    // handle, is exactly the kind of off-platform channel this screen exists to catch).
    if (overlapsAnySpan(start, end, urlData.allowedSpans)) continue

    const lower = raw.toLowerCase()
    const labels = lower.split('.')
    const tld = labels[labels.length - 1]
    if (!tld || !PLAUSIBLE_TLDS.has(tld)) continue

    if (!ALLOWED_HOSTNAMES.has(lower)) {
      return fail('url_not_allowed', `disallowed bare domain in reply body: ${raw}`)
    }
  }

  return { ok: true }
}

/** A phone-candidate match is only actually phone-like when: it has ≥7 digits, it is not an
 * ISO date (`2024-01-15`), and it either starts with `+`/`(` or contains at least one separator
 * between digit groups — a bare unseparated digit run (`10023481`, or the digit run embedded in
 * `1Z999AA10123456784`) is an order/tracking number, not a phone number, no matter how long. */
function isPhoneLikeCandidate(raw: string): boolean {
  const digitCount = (raw.match(/\d/g) ?? []).length
  if (digitCount < PHONE_MIN_DIGITS) return false
  if (ISO_DATE_RE.test(raw)) return false

  const hasLeadingPrefix = raw[0] === '+' || raw[0] === '('
  const hasSeparator = PHONE_SEPARATOR_RE.test(raw)
  return hasLeadingPrefix || hasSeparator
}

function checkContact(body: string, allowedUrlSpans: Span[]): ValidationResult {
  const emailRe = new RegExp(EMAIL_RE)
  emailRe.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = emailRe.exec(body))) {
    const raw = m[0]
    if (!raw.toLowerCase().endsWith(ALLOWED_EMAIL_SUFFIX)) {
      return fail('contact_channel', `disallowed email address in reply body: ${raw}`)
    }
  }

  const phoneRe = new RegExp(PHONE_RE)
  phoneRe.lastIndex = 0
  while ((m = phoneRe.exec(body))) {
    const raw = m[0]
    const start = m.index
    const end = start + raw.length
    // Digits inside an allowed URL (tracking number in a path/query) are not a phone number.
    if (overlapsAnySpan(start, end, allowedUrlSpans)) continue
    if (isPhoneLikeCandidate(raw)) {
      return fail('contact_channel', `phone-like token in reply body: ${raw}`)
    }
  }

  return { ok: true }
}

/**
 * Body-only checks + the sibling-aware promised-action screen (spec §3). `ticketId` is used only
 * for the promised-action screen's live-sibling-proposal lookup; nothing else here touches the DB.
 *
 * Check order is: plain text → promised-action → contact → URL/domain. Contact runs BEFORE the
 * URL/domain screen so a bare `@domain.tld` mention with a real local part (`help@gmail.com`) is
 * reported as `contact_channel`, not misclassified as a stray bare-domain `url_not_allowed` —
 * both screens still independently catch every bypass either way, this only decides which failure
 * code comes back when a body trips both.
 */
export async function validateReplyBody(
  db: Db,
  ticketId: string,
  rawBody: string,
  opts: { hasRefundInOutput: boolean; trackingUrl: string | null },
): Promise<ValidationResult> {
  // Unicode-normalize before ANY screen runs: NFKC folds compatibility look-alikes (U+2024 ONE DOT
  // LEADER, U+FF0E FULLWIDTH FULL STOP, etc.) down to their plain ASCII equivalents, so a body
  // using `evil․com` or `evil．com` to dodge the literal `.` in the domain regexes is screened
  // exactly like `evil.com`.
  const body = rawBody.normalize('NFKC')

  if (HTML_TAG_RE.test(body)) return fail('html_not_allowed', 'reply body contains an HTML tag')
  if (body.length > MAX_BODY_LEN) return fail('body_too_long', `reply body is ${body.length} chars (max ${MAX_BODY_LEN})`)

  const normalizedForPromiseScan = body.replace(/\s+/g, ' ')
  if (hasPromisedActionHit(normalizedForPromiseScan)) {
    if (!opts.hasRefundInOutput) {
      const hasSibling = await hasLiveSiblingRefundProposal(db, ticketId)
      if (!hasSibling) {
        return fail('promised_action', 'reply body promises a resolved action with no refund attached to it')
      }
    }
  }

  const urlData = scanSchemedUrls(body, opts.trackingUrl)

  const contactResult = checkContact(body, urlData.allowedSpans)
  if (!contactResult.ok) return contactResult

  return checkUrlsAndDomains(body, urlData)
}

/**
 * Refund cross-checks (spec §3): verified order, non-NULL total, accumulation bound, sender
 * authenticated (dmarc=pass on the ticket's latest inbound message), and — when the agent wants to
 * open a CJ dispute — a reason id. Every one of these re-derives from the DB; nothing here trusts
 * the agent's own numbers.
 */
export async function validateRefundIntent(
  db: Db,
  ticket: { id: string; orderId: string | null },
  refund: { amountCents: number; openCjDispute: boolean; cjDisputeReasonId?: string },
): Promise<ValidationResult> {
  if (!ticket.orderId) return fail('refund_unverified_order', 'ticket has no linked order')

  const [order] = await db.select({ totalCents: orders.totalCents }).from(orders).where(eq(orders.id, ticket.orderId)).limit(1)
  if (!order || order.totalCents === null) {
    return fail('refund_unverified_order', 'order total is not known (order missing or total_cents is NULL)')
  }

  const priorApplied = await db
    .select({ amountCents: sql<number>`(${proposals.payload} ->> 'amountCents')::int` })
    .from(proposals)
    .where(and(eq(proposals.orderId, ticket.orderId), eq(proposals.type, 'refund'), eq(proposals.status, 'applied')))
  const priorAppliedSum = priorApplied.reduce((sum, row) => sum + (row.amountCents ?? 0), 0)

  if (refund.amountCents > order.totalCents - priorAppliedSum) {
    return fail(
      'refund_exceeds_total',
      `requested ${refund.amountCents}c exceeds remaining ${order.totalCents - priorAppliedSum}c (total ${order.totalCents}c, prior applied ${priorAppliedSum}c)`,
    )
  }

  // NULLS LAST for sentAt (the ordinary case: newest wall-clock message wins), then created_at and
  // id as deterministic tiebreaks for rows that share (or both lack) a sentAt — so "latest inbound
  // message" never depends on unstable row order when Gmail delivers two messages the same second.
  const [latestInbound] = await db
    .select({ authResults: supportMessages.authResults })
    .from(supportMessages)
    .where(and(eq(supportMessages.ticketId, ticket.id), eq(supportMessages.direction, 'inbound')))
    .orderBy(sql`${supportMessages.sentAt} DESC NULLS LAST, ${supportMessages.createdAt} DESC, ${supportMessages.id} DESC`)
    .limit(1)

  if (!latestInbound || latestInbound.authResults === null || !/\bdmarc=pass\b/i.test(latestInbound.authResults)) {
    return fail('refund_sender_unauthenticated', 'latest inbound message is not dmarc=pass authenticated')
  }

  if (refund.openCjDispute && !refund.cjDisputeReasonId) {
    return fail('refund_dispute_reason_required', 'openCjDispute is true but no cjDisputeReasonId was given')
  }

  return { ok: true }
}

/**
 * Composes the two checks for one agent output. Only the `propose` outcome carries anything sent
 * to a customer or applied to an order, so `escalate`/`no_action` pass straight through — those
 * outcomes take no customer-facing or financial action for this to screen.
 *
 * `trackingUrl` defaults to null (no off-domain tracking link exempted) — callers that know the
 * ticket's real tracking URL (e.g. the route in Task 18) should pass it through so a legitimate
 * carrier link doesn't trip the URL/domain or contact screens.
 */
export async function validateSupportOutput(
  db: Db,
  ticket: { id: string; orderId: string | null; customerEmail: string | null },
  output: SupportOutput,
  trackingUrl: string | null = null,
): Promise<ValidationResult> {
  if (output.outcome !== 'propose') return { ok: true }

  if (!ticket.customerEmail) return fail('customer_email_missing', 'ticket has no customer email to reply to')

  const replyResult = await validateReplyBody(db, ticket.id, output.reply.body, {
    hasRefundInOutput: output.refund !== undefined,
    trackingUrl,
  })
  if (!replyResult.ok) return replyResult

  if (output.refund) {
    const refundResult = await validateRefundIntent(db, { id: ticket.id, orderId: ticket.orderId }, output.refund)
    if (!refundResult.ok) return refundResult
  }

  return { ok: true }
}
