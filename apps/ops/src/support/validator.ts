import { orders, proposals, supportMessages, type createDb } from '@doge-buddy/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { SupportOutput } from '../agents/support-output-schema.ts'

type Db = ReturnType<typeof createDb>['db']

export type ValidationFailure = { ok: false; code: string; detail: string }
/**
 * `normalizedBody` is populated on every `ok:true` result from `validateReplyBody`/
 * `validateSupportOutput` — the NFKC-normalized body that was actually screened. Downstream
 * callers (e.g. the send path) should store/send exactly this string, not the raw agent output,
 * to avoid a screened-vs-delivered divergence. `validateRefundIntent` never populates it — it
 * doesn't screen a reply body.
 */
export type ValidationResult = { ok: true; normalizedBody?: string } | ValidationFailure

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
 * reports an action as done, not just requested. `funds back` (not bare `funds`, dropped after
 * N2 review — see PROMISE_RE below) lives ONLY here, not in PROMISE_RE (round-3 cleanup — see
 * PROMISE_RE's doc comment for why): "Expect the funds back..." is still caught via this ACTION
 * token overlapping PROMISE_RE's `expect (...the funds...)`, without a bare `funds` token
 * false-positiving on ordinary sentences that just happen to mention funds (a chargeback question,
 * a "have the funds arrived" check-in). */
const ACTION_RE =
  /refund(ed)?|reimburs\w*|credit(ed)?|store credit|money back|compensat\w*|replacement|reship\w*|resend|cancel\w* (your|the) order|order (has been|was|is) cancel\w*|replacement has (been )?shipped|payment (returned|reversed)|funds back/gi
/** Words that PROMISE the action already happened or is imminent — the combination is what makes
 * a drafted reply a commitment rather than an explanation of policy. `gone ahead and` (not bare
 * `i've`, dropped after N2 review) catches "I've gone ahead and refunded you." without `i've`
 * alone false-positiving on ordinary first-person sentences ("I've reviewed your order...",
 * "I've attached our policy...") that never actually promise anything.
 *
 * Deliberately does NOT include `funds back` (round-3 cleanup): that phrase is an ACTION token
 * only. Dual-listing it here too meant it matched itself as its own "promise" at gap 0, so ANY
 * mention of `funds back` self-triggered regardless of context — including a plain question like
 * "Would you like the funds back on your card?", which promises nothing. `expect (it|the
 * funds|...)` below still catches the one phrase this token pair was added for ("Expect the funds
 * back in 5 business days.") via the ACTION `funds back` overlapping THIS token's `the funds`. */
const PROMISE_RE =
  /issued|processed|sent|approved|applied|on its way|on the way|within \d+ (business )?days|has been|have been|we have|we've|gone ahead and|is complete|has shipped|expect (it|the funds|your (refund|money))|will be/gi
/** How close an ACTION token and a PROMISE token must be (in whitespace-normalized chars) to
 * count as one promised-action hit. */
const PROMISE_PROXIMITY_CHARS = 200

/** A refund proposal that is still on its way to moving money (or already has). Shared by the
 * promised-action screen's sibling lookup and the accumulation bound — both ask the same question:
 * is there refund money on this order that is not cancelled? */
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
/** ISO date substrings (`2024-01-15`) anywhere in the body — exempted digit-by-digit (a per-span
 * exemption, not a whole-candidate-match check) so a phone-regex candidate that MERGES two
 * adjacent dates through a single connecting space (`2024-01-15 2024-01-18` — the space is inside
 * PHONE_RE's own character class, so it's one combined match) still has every one of its digits
 * correctly excluded, not just an isolated single-date candidate.
 *
 * Digit-anchored on both ends (`(?<!\d)` / `(?!\d)`) — WITHOUT this, an unanchored match can land
 * on a 4-2-2 SLICE of a longer, non-date digit-dash run (a phone number regrouped as 4-2-2, e.g.
 * `5551-23-4567` or `8885-55-0142`), wrongly exempting most of its digits and letting it slip the
 * phone screen. Anchoring means the match only fires on a digit run that IS actually 4-2-2 shaped
 * end to end, not a coincidental 4-2-2 prefix/slice of something longer. */
const ISO_DATE_SPAN_RE = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g
/** A separator character INSIDE a candidate match (space, parens, dot, dash) — distinct from a
 * leading `+`/`(`, which `isPhoneLikeCandidate` checks separately. */
const PHONE_SEPARATOR_RE = /[\s().-]/
/** A standalone run of EXACTLY 10 or 11 digits, bounded by non-alphanumeric characters (or string
 * start/end) on both sides — the shape of a US phone number (with or without country code) typed
 * with no separators or leading `+`/( at all, e.g. `8885550142`. Lookaround-anchored on both ends
 * so it can never match a sub-run within a longer digit blob (a 22-digit tracking number, where no
 * 10/11-length window is bounded by non-digits on both sides) or a run embedded in an alphanumeric
 * id (`1Z999AA10123456784`, where the run is bounded by a letter). Independent of, and in addition
 * to, the separator/prefix rule in `isPhoneLikeCandidate`. */
const STANDALONE_DIGIT_RUN_RE = /(?<![a-zA-Z0-9])\d{10,11}(?![a-zA-Z0-9])/g

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

/** Counts the digits inside `raw` (a match starting at `matchStart` in the full body) that do NOT
 * fall inside any of `excludeSpans` (ISO-date occurrences). Per-digit exemption rather than a
 * whole-match check: a candidate that merges two ISO dates through a connecting separator still
 * has every one of its digits correctly excluded, not just a candidate that IS a single date. */
function digitsExcludingSpans(raw: string, matchStart: number, excludeSpans: Span[]): number {
  let count = 0
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (ch < '0' || ch > '9') continue
    const pos = matchStart + i
    if (excludeSpans.some((s) => pos >= s.start && pos < s.end)) continue
    count++
  }
  return count
}

/** A phone-candidate match is only actually phone-like when it has ≥7 digits OUTSIDE any ISO-date
 * span, AND it either starts with `+`/`(` or contains at least one separator between digit groups
 * — a bare unseparated digit run (`10023481`, or the digit run embedded in `1Z999AA10123456784`)
 * is an order/tracking number, not a phone number, no matter how long. (Bare unseparated 10/11-
 * digit runs ARE still caught, but by the separate `STANDALONE_DIGIT_RUN_RE` check — see N1.) */
function isPhoneLikeCandidate(raw: string, effectiveDigitCount: number): boolean {
  if (effectiveDigitCount < PHONE_MIN_DIGITS) return false

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

  const isoDateSpans = findMatches(ISO_DATE_SPAN_RE, body)

  const phoneRe = new RegExp(PHONE_RE)
  phoneRe.lastIndex = 0
  while ((m = phoneRe.exec(body))) {
    const raw = m[0]
    const start = m.index
    const end = start + raw.length
    // Digits inside an allowed URL (tracking number in a path/query) are not a phone number.
    if (overlapsAnySpan(start, end, allowedUrlSpans)) continue
    const effectiveDigits = digitsExcludingSpans(raw, start, isoDateSpans)
    if (isPhoneLikeCandidate(raw, effectiveDigits)) {
      return fail('contact_channel', `phone-like token in reply body: ${raw}`)
    }
  }

  // N1: a standalone (non-alphanumeric-bounded) run of exactly 10 or 11 digits — e.g.
  // `8885550142` or `18885550142` typed with no separators and no leading +/( at all — is still a
  // phone number even though it trips neither the digit-count-and-separator rule above nor the
  // "long unseparated run" exemption (that exemption is for tracking/order numbers of OTHER
  // lengths, or ones embedded in an alphanumeric id).
  const standaloneRe = new RegExp(STANDALONE_DIGIT_RUN_RE)
  standaloneRe.lastIndex = 0
  while ((m = standaloneRe.exec(body))) {
    const raw = m[0]
    const start = m.index
    const end = start + raw.length
    if (overlapsAnySpan(start, end, allowedUrlSpans)) continue
    return fail('contact_channel', `phone-like token in reply body: ${raw}`)
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
 *
 * On success, returns `{ ok: true, normalizedBody }` — the NFKC-normalized body that was actually
 * screened, so a caller that sends/stores the reply sends exactly what was checked.
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

  const urlResult = checkUrlsAndDomains(body, urlData)
  if (!urlResult.ok) return urlResult

  return { ok: true, normalizedBody: body }
}

/**
 * Refund cross-checks (spec §3): verified order, non-NULL total, accumulation bound over every
 * LIVE prior refund proposal (pending/approved/applying/applied — not just applied), sender
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

  // Every LIVE refund proposal counts against the total, not just the applied ones: a `pending` or
  // `approved` refund is money the owner is one tap away from moving (an `approved` one is already
  // enqueued for apply), so summing only `applied` lets a second proposal be drafted, approved, and
  // applied on top of a first that lands moments later — a double refund past the order total, the
  // exact outcome this bound exists to prevent.
  const priorLive = await db
    .select({ amountCents: sql<number>`(${proposals.payload} ->> 'amountCents')::int` })
    .from(proposals)
    .where(
      and(
        eq(proposals.orderId, ticket.orderId),
        eq(proposals.type, 'refund'),
        inArray(proposals.status, [...LIVE_REFUND_PROPOSAL_STATUSES]),
      ),
    )
  const priorLiveSum = priorLive.reduce((sum, row) => sum + (row.amountCents ?? 0), 0)

  if (refund.amountCents > order.totalCents - priorLiveSum) {
    return fail(
      'refund_exceeds_total',
      `requested ${refund.amountCents}c exceeds remaining ${order.totalCents - priorLiveSum}c (total ${order.totalCents}c, prior live ${priorLiveSum}c)`,
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
 * outcomes take no customer-facing or financial action for this to screen (and so return no
 * `normalizedBody`: there is no reply body involved).
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

  return { ok: true, normalizedBody: replyResult.normalizedBody }
}
