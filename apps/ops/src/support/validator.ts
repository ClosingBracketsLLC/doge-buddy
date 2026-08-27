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
 * always wrong, not a false positive worth tolerating. */
const HTML_TAG_RE = /<[a-z!/]/i

// -- Promised-action screen --

/** Verbs/nouns describing an ACTION that resolves the customer's issue. */
const ACTION_RE =
  /refund(ed)?|reimburs\w*|credit(ed)?|store credit|money back|compensat\w*|replacement|reship\w*|resend|cancel\w* (your|the) order|payment (returned|reversed)/gi
/** Words that PROMISE the action already happened or is imminent — the combination is what makes
 * a drafted reply a commitment rather than an explanation of policy. */
const PROMISE_RE = /issued|processed|sent|approved|applied|on its way|within \d+ (business )?days|has been|will be/gi
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

// -- Contact screen --

const EMAIL_RE = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g
const ALLOWED_EMAIL_SUFFIX = '@dogebuddy.com'
/** A phone-like run of digits/separators. Deliberately loose (it has to catch `+1 (888)
 * 555-0142`) — the ≥7-actual-digits check below is what keeps `order #12345` from tripping it. */
const PHONE_RE = /[+(]?\d[\d\s().-]{6,}\d/g
const PHONE_MIN_DIGITS = 7

interface Span {
  start: number
  end: number
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

function checkUrlsAndDomains(body: string, trackingUrl: string | null): ValidationResult {
  const allowedSpans: Span[] = []

  const schemedRe = new RegExp(SCHEMED_URL_RE)
  schemedRe.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = schemedRe.exec(body))) {
    const raw = m[0]
    if (!isAllowedSchemedUrl(raw, trackingUrl)) {
      return fail('url_not_allowed', `disallowed URL in reply body: ${raw}`)
    }
    allowedSpans.push({ start: m.index, end: m.index + raw.length })
  }

  const domainRe = new RegExp(BARE_DOMAIN_RE)
  domainRe.lastIndex = 0
  while ((m = domainRe.exec(body))) {
    const raw = m[0]
    const start = m.index
    const end = start + raw.length
    // Already covered by an allowed schemed URL (e.g. the query string of an allowed tracking
    // link) — not a second, independent domain mention.
    if (allowedSpans.some((s) => start >= s.start && end <= s.end)) continue
    // The domain half of an email address (e.g. `gmail.com` in `help@gmail.com`) — the contact
    // screen owns email addresses; classifying it here too would misreport an off-platform email
    // as a bare-domain violation instead of a contact-channel one.
    if (body[start - 1] === '@') continue

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

function checkContact(body: string): ValidationResult {
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
    const digitCount = (raw.match(/\d/g) ?? []).length
    if (digitCount >= PHONE_MIN_DIGITS) {
      return fail('contact_channel', `phone-like token in reply body: ${raw}`)
    }
  }

  return { ok: true }
}

/**
 * Body-only checks + the sibling-aware promised-action screen (spec §3). `ticketId` is used only
 * for the promised-action screen's live-sibling-proposal lookup; nothing else here touches the DB.
 */
export async function validateReplyBody(
  db: Db,
  ticketId: string,
  body: string,
  opts: { hasRefundInOutput: boolean; trackingUrl: string | null },
): Promise<ValidationResult> {
  if (HTML_TAG_RE.test(body)) return fail('html_not_allowed', 'reply body contains an HTML tag')
  if (body.length > MAX_BODY_LEN) return fail('body_too_long', `reply body is ${body.length} chars (max ${MAX_BODY_LEN})`)

  const normalized = body.replace(/\s+/g, ' ')
  if (hasPromisedActionHit(normalized)) {
    if (!opts.hasRefundInOutput) {
      const hasSibling = await hasLiveSiblingRefundProposal(db, ticketId)
      if (!hasSibling) {
        return fail('promised_action', 'reply body promises a resolved action with no refund attached to it')
      }
    }
  }

  const urlResult = checkUrlsAndDomains(body, opts.trackingUrl)
  if (!urlResult.ok) return urlResult

  return checkContact(body)
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

  const [latestInbound] = await db
    .select({ authResults: supportMessages.authResults })
    .from(supportMessages)
    .where(and(eq(supportMessages.ticketId, ticket.id), eq(supportMessages.direction, 'inbound')))
    .orderBy(sql`${supportMessages.sentAt} DESC NULLS LAST`)
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
 */
export async function validateSupportOutput(
  db: Db,
  ticket: { id: string; orderId: string | null; customerEmail: string | null },
  output: SupportOutput,
): Promise<ValidationResult> {
  if (output.outcome !== 'propose') return { ok: true }

  if (!ticket.customerEmail) return fail('customer_email_missing', 'ticket has no customer email to reply to')

  const replyResult = await validateReplyBody(db, ticket.id, output.reply.body, {
    hasRefundInOutput: output.refund !== undefined,
    trackingUrl: null,
  })
  if (!replyResult.ok) return replyResult

  if (output.refund) {
    const refundResult = await validateRefundIntent(db, { id: ticket.id, orderId: ticket.orderId }, output.refund)
    if (!refundResult.ok) return refundResult
  }

  return { ok: true }
}
