import { createDb, orders, proposals, supportMessages, supportTickets } from '@doge-buddy/db'
import { eq, like } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { validateReplyBody, validateRefundIntent, validateSupportOutput } from '../src/support/validator.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

const SOURCE_WORKFLOW = 'support-validator-test'
const ORDER_PREFIX = 'gid://shopify/Order/valtest-'
const TICKET_PREFIX = 'valtest-'
const MSG_PREFIX = 'valtest-msg-'

let uidCounter = 0
function uid(): string {
  uidCounter += 1
  return `${Date.now()}-${uidCounter}`
}

describe('support validator', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  afterEach(async () => {
    await db.delete(supportMessages).where(like(supportMessages.gmailMessageId, `${MSG_PREFIX}%`))
    await db.delete(proposals).where(eq(proposals.sourceWorkflow, SOURCE_WORKFLOW))
    await db.delete(supportTickets).where(like(supportTickets.gmailThreadId, `${TICKET_PREFIX}%`))
    await db.delete(orders).where(like(orders.shopifyOrderGid, `${ORDER_PREFIX}%`))
  })

  async function seedOrder(totalCents: number | null): Promise<string> {
    const [row] = await db
      .insert(orders)
      .values({ shopifyOrderGid: `${ORDER_PREFIX}${uid()}`, isTest: true, totalCents })
      .returning({ id: orders.id })
    return row!.id
  }

  async function seedTicket(opts: { customerEmail?: string | null; orderId?: string | null } = {}): Promise<string> {
    const [row] = await db
      .insert(supportTickets)
      .values({
        gmailThreadId: `${TICKET_PREFIX}${uid()}`,
        customerEmail: opts.customerEmail ?? 'customer@example.com',
        orderId: opts.orderId ?? null,
      })
      .returning({ id: supportTickets.id })
    return row!.id
  }

  async function seedInboundMessage(ticketId: string, opts: { authResults?: string | null; sentAt?: Date } = {}): Promise<void> {
    await db.insert(supportMessages).values({
      ticketId,
      gmailMessageId: `${MSG_PREFIX}${uid()}`,
      direction: 'inbound',
      authResults: opts.authResults ?? null,
      sentAt: opts.sentAt ?? new Date(),
    })
  }

  async function seedRefundProposal(opts: {
    ticketId?: string | null
    orderId?: string | null
    status: 'pending' | 'approved' | 'rejected' | 'expired' | 'applying' | 'applied' | 'failed'
    amountCents: number
  }): Promise<string> {
    const [row] = await db
      .insert(proposals)
      .values({
        type: 'refund',
        status: opts.status,
        summary: 'test refund proposal',
        payload: { amountCents: opts.amountCents },
        sourceWorkflow: SOURCE_WORKFLOW,
        ticketId: opts.ticketId ?? null,
        orderId: opts.orderId ?? null,
      })
      .returning({ id: proposals.id })
    return row!.id
  }

  const noRefund = { hasRefundInOutput: false, trackingUrl: null as string | null }

  // -- Plain text checks --

  describe('validateReplyBody: plain text', () => {
    it('rejects a body containing an HTML tag', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Hi <b>there</b>, thanks for writing in.', noRefund)
      expect(result.ok).toBe(false)
    })

    it('rejects a body over 4000 chars', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'a'.repeat(4001), noRefund)
      expect(result.ok).toBe(false)
    })

    it('accepts an ordinary plain-text body', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Thanks for reaching out, we will look into it.', noRefund)
      expect(result).toEqual({ ok: true })
    })
  })

  // -- Promised-action screen --

  describe('validateReplyBody: promised-action screen', () => {
    it('hits across a newline within 200 chars ("your refund has been\\nprocessed")', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Good news — your refund has been\nprocessed today.', noRefund)
      expect(result).toEqual({ ok: false, code: 'promised_action', detail: expect.any(String) })
    })

    it('"store credit has been applied" hits', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Your store credit has been applied to your account.', noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('promised_action')
    })

    it('"a free replacement is on its way" hits', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Good news, a free replacement is on its way to you.', noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('promised_action')
    })

    it('policy quote without a refund in output and no live sibling proposal fails', async () => {
      const ticketId = await seedTicket()
      const body = 'Good news — your refund has been processed today.'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: false, code: 'promised_action', detail: expect.any(String) })
    })

    it('the same body passes when a live sibling refund proposal exists for the ticket', async () => {
      const ticketId = await seedTicket()
      await seedRefundProposal({ ticketId, status: 'pending', amountCents: 500 })
      const body = 'Good news — your refund has been processed today.'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true })
    })

    it('the same body passes when hasRefundInOutput is true (no sibling needed)', async () => {
      const ticketId = await seedTicket()
      const body = 'Good news — your refund has been processed today.'
      const result = await validateReplyBody(db, ticketId, body, { hasRefundInOutput: true, trackingUrl: null })
      expect(result).toEqual({ ok: true })
    })

    it('a sibling proposal in a non-live status (rejected) does not excuse the promised-action hit', async () => {
      const ticketId = await seedTicket()
      await seedRefundProposal({ ticketId, status: 'rejected', amountCents: 500 })
      const body = 'Good news — your refund has been processed today.'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('promised_action')
    })

    it('a body with no action/promise proximity passes', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(
        db,
        ticketId,
        'Thanks so much for your patience while our team looks into this.',
        noRefund,
      )
      expect(result).toEqual({ ok: true })
    })

    // I3 (ruled): extended ACTION/PROMISE token families — natural phrasings the reviewer found
    // that the original token lists missed. Each MUST be caught when there's no refund object and
    // no live sibling proposal.
    const mustCatchPhrases = [
      'You have been refunded $19.99 to your original payment method.',
      "We've refunded your order in full.",
      "I've gone ahead and refunded you.",
      'Your refund is complete.',
      'Refund complete — expect it in 3-5 days.',
      'Your refund is on the way.',
      'We have cancelled your order.',
      'Your order has been cancelled.',
      'A replacement has shipped.',
      'Expect the funds back in 5 business days.',
    ]
    for (const phrase of mustCatchPhrases) {
      it(`"${phrase}" is caught by the extended promised-action screen`, async () => {
        const ticketId = await seedTicket()
        const result = await validateReplyBody(db, ticketId, phrase, noRefund)
        expect(result.ok).toBe(false)
        expect((result as { code: string }).code).toBe('promised_action')
      })
    }

    // Explicitly documented as an accepted gap (I3 ruling): "Consider it refunded." has no
    // ACTION+PROMISE proximity under the enumerated token screen — it stays uncaught.
    it('"Consider it refunded." is NOT caught (enumerated screen, accepted gap)', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Consider it refunded.', noRefund)
      expect(result).toEqual({ ok: true })
    })

    it('the extended tokens do not false-positive on ordinary policy language', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(
        db,
        ticketId,
        'We have received your message and will take a look shortly.',
        noRefund,
      )
      expect(result).toEqual({ ok: true })
    })
  })

  // -- URL / domain screen --

  describe('validateReplyBody: URL/domain screen', () => {
    const cases: { name: string; body: string; ok: boolean }[] = [
      { name: 'https://dogebuddy.com/track passes', body: 'Track it here: https://dogebuddy.com/track', ok: true },
      { name: 'https://www.dogebuddy.com passes', body: 'Visit https://www.dogebuddy.com for info.', ok: true },
      { name: 'http://dogebuddy.com fails (not https)', body: 'Visit http://dogebuddy.com for info.', ok: false },
      { name: 'https://evil.com fails', body: 'Visit https://evil.com for info.', ok: false },
      { name: 'https://dogebuddy.com.evil.com/x fails', body: 'Visit https://dogebuddy.com.evil.com/x for info.', ok: false },
      { name: 'bare dogebuddy-help.com fails', body: 'Please see dogebuddy-help.com for details.', ok: false },
      { name: 'bare dogebuddy.com passes', body: 'Please see dogebuddy.com for details.', ok: true },
      { name: 'admin.dogebuddy.com fails (subdomain excluded)', body: 'Please see admin.dogebuddy.com for details.', ok: false },
      // C1 regression: a bare `@domain.tld` mention with NO email local part (a Telegram-style
      // handle or off-platform channel, not a real address) must still be caught by the
      // URL/domain screen — the deleted `@`-skip carve-out used to let these straight through.
      { name: '@evil.com (bare, no local part) fails', body: 'Contact @evil.com for help.', ok: false },
      { name: 'Message us at @dogepay.shop fails', body: 'Message us at @dogepay.shop for a faster reply.', ok: false },
      { name: 'Telegram: @refund-help.com fails', body: 'Telegram: @refund-help.com — DM us there.', ok: false },
      // m5: NFKC normalization folds Unicode dot look-alikes to a plain '.' before the domain
      // regexes ever run.
      { name: 'evil․com (U+2024 ONE DOT LEADER) fails', body: 'Please see evil․com for details.', ok: false },
      { name: 'evil．com (U+FF0E FULLWIDTH FULL STOP) fails', body: 'Please see evil．com for details.', ok: false },
      // m4: trailing prose punctuation and a `<...>` wrap are stripped before parsing/comparing.
      { name: 'trailing period after a schemed URL passes', body: 'Track your order at https://dogebuddy.com.', ok: true },
      { name: 'angle-bracket-wrapped URL passes (not HTML)', body: 'See <https://dogebuddy.com/help> for details.', ok: true },
    ]

    for (const c of cases) {
      it(c.name, async () => {
        const ticketId = await seedTicket()
        const result = await validateReplyBody(db, ticketId, c.body, noRefund)
        expect(result.ok).toBe(c.ok)
        if (!c.ok) expect((result as { code: string }).code).toBe('url_not_allowed')
      })
    }

    // C1: with the contact screen now running BEFORE the URL/domain screen, a URL whose userinfo
    // section looks like an email (`dogebuddy.com@evil.com`) is caught by the EMAIL check first —
    // still `ok:false`, just reported as `contact_channel` instead of `url_not_allowed`. Either
    // code is a correct block; this test locks in which one actually fires post-reorder.
    it('https://dogebuddy.com@evil.com/ fails via the contact screen (userinfo looks like an email; real hostname is evil.com)', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Visit https://dogebuddy.com@evil.com/ for info.', noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('contact_channel')
    })

    it('tracking URL byte-equal to opts.trackingUrl passes even off the dogebuddy.com hostname', async () => {
      const ticketId = await seedTicket()
      const trackingUrl = 'https://carrier.example.com/trk?id=ABC123'
      const result = await validateReplyBody(db, ticketId, `Track it here: ${trackingUrl}`, {
        hasRefundInOutput: false,
        trackingUrl,
      })
      expect(result).toEqual({ ok: true })
    })

    it('an off-by-one mismatch against opts.trackingUrl fails', async () => {
      const ticketId = await seedTicket()
      const trackingUrl = 'https://carrier.example.com/trk?id=ABC123'
      const bodyUrl = 'https://carrier.example.com/trk?id=ABC124'
      const result = await validateReplyBody(db, ticketId, `Track it here: ${bodyUrl}`, {
        hasRefundInOutput: false,
        trackingUrl,
      })
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('url_not_allowed')
    })
  })

  // -- Contact screen --

  describe('validateReplyBody: contact screen', () => {
    it('help@gmail.com fails (contact screen runs before URL/domain, per C1)', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'You can also reach us at help@gmail.com any time.', noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('contact_channel')
    })

    // m5/C1: NFKC-normalizing the body before any screen runs means a Unicode dot look-alike used
    // to dodge the literal '.' in EMAIL_RE is folded back to a plain ASCII email first.
    it('help@gmail․com with a U+2024 ONE DOT LEADER still fails as contact_channel', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'You can also reach us at help@gmail․com any time.', noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('contact_channel')
    })

    it('support@dogebuddy.com passes', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'You can also reach us at support@dogebuddy.com any time.', noRefund)
      expect(result).toEqual({ ok: true })
    })

    it('+1 (888) 555-0142 fails', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Feel free to call us at +1 (888) 555-0142 anytime.', noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('contact_channel')
    })

    it('spaced-digit "8 8 8 5 5 5 0 1 4 2" still fails (separators between every digit)', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Call us at 8 8 8 5 5 5 0 1 4 2 any time.', noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('contact_channel')
    })

    it('"order #12345" passes (digits < 7 with separators)', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Please reference order #12345 when you write back.', noRefund)
      expect(result).toEqual({ ok: true })
    })

    // I2 ruling: a single unseparated digit run with no leading +/( is not phone-like, no matter
    // how long — it's an order/tracking number, not a phone number.
    it('"Order 10023481 shipped" passes (unseparated digit run, no leading +/()', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Order 10023481 shipped', noRefund)
      expect(result).toEqual({ ok: true })
    })

    // I2 ruling: a bare alphanumeric tracking token (letters interleaved with digits) is not
    // phone-like — the embedded unseparated digit run alone doesn't qualify either.
    it('"Your tracking number is 1Z999AA10123456784." passes', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Your tracking number is 1Z999AA10123456784.', noRefund)
      expect(result).toEqual({ ok: true })
    })

    it('ISO dates "Ordered on 2024-01-15 and shipped 2024-01-18." pass (excluded explicitly)', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Ordered on 2024-01-15 and shipped 2024-01-18.', noRefund)
      expect(result).toEqual({ ok: true })
    })

    it('a long digit run inside an allowed dogebuddy.com URL path passes (allowedSpans-aware)', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(
        db,
        ticketId,
        'Your tracking link: https://dogebuddy.com/track/9405511899223197428490',
        noRefund,
      )
      expect(result).toEqual({ ok: true })
    })

    it('a byte-equal tracking URL containing separated digits passes (allowedSpans exempts it from the phone screen too)', async () => {
      const ticketId = await seedTicket()
      const trackingUrl = 'https://carrier.example.com/trk?ref=1-800-555-0199#nums=LZ123456789CN'
      const result = await validateReplyBody(db, ticketId, `Track it here: ${trackingUrl}`, {
        hasRefundInOutput: false,
        trackingUrl,
      })
      expect(result).toEqual({ ok: true })
    })
  })

  // -- validateRefundIntent --

  describe('validateRefundIntent', () => {
    it('fails refund_unverified_order when ticket.orderId is null', async () => {
      const result = await validateRefundIntent(
        db,
        { id: 'ignored', orderId: null },
        { amountCents: 500, openCjDispute: false },
      )
      expect(result).toEqual({ ok: false, code: 'refund_unverified_order', detail: expect.any(String) })
    })

    it('fails refund_unverified_order when the order row totalCents is null', async () => {
      const orderId = await seedOrder(null)
      const result = await validateRefundIntent(
        db,
        { id: 'ignored', orderId },
        { amountCents: 500, openCjDispute: false },
      )
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('refund_unverified_order')
    })

    it('fails refund_exceeds_total on accumulation: $10 already applied + $15 new on a $20 order', async () => {
      const orderId = await seedOrder(2000)
      await seedRefundProposal({ orderId, status: 'applied', amountCents: 1000 })
      const result = await validateRefundIntent(
        db,
        { id: 'ignored', orderId },
        { amountCents: 1500, openCjDispute: false },
      )
      expect(result).toEqual({ ok: false, code: 'refund_exceeds_total', detail: expect.any(String) })
    })

    it('fails refund_exceeds_total when the new amount alone exceeds the order total', async () => {
      const orderId = await seedOrder(1000)
      const result = await validateRefundIntent(
        db,
        { id: 'ignored', orderId },
        { amountCents: 1500, openCjDispute: false },
      )
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('refund_exceeds_total')
    })

    it('does not count non-applied prior proposals toward the accumulation bound', async () => {
      const orderId = await seedOrder(2000)
      await seedRefundProposal({ orderId, status: 'pending', amountCents: 1900 })
      const ticketId = await seedTicket({ orderId })
      await seedInboundMessage(ticketId, { authResults: 'dkim=pass; dmarc=pass' })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 1500, openCjDispute: false },
      )
      expect(result).toEqual({ ok: true })
    })

    it('fails refund_sender_unauthenticated when the latest inbound message has auth_results null', async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId })
      await seedInboundMessage(ticketId, { authResults: null })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 500, openCjDispute: false },
      )
      expect(result).toEqual({ ok: false, code: 'refund_sender_unauthenticated', detail: expect.any(String) })
    })

    it('fails refund_sender_unauthenticated when the latest inbound message auth_results does not contain dmarc=pass', async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId })
      await seedInboundMessage(ticketId, { authResults: 'dkim=pass; dmarc=fail (p=REJECT)' })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 500, openCjDispute: false },
      )
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('refund_sender_unauthenticated')
    })

    it('fails refund_sender_unauthenticated when there is no inbound message at all', async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 500, openCjDispute: false },
      )
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('refund_sender_unauthenticated')
    })

    it('uses the LATEST inbound message, not an earlier authenticated one', async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId })
      await seedInboundMessage(ticketId, { authResults: 'dmarc=pass', sentAt: new Date('2024-01-01T00:00:00Z') })
      await seedInboundMessage(ticketId, { authResults: null, sentAt: new Date('2024-02-01T00:00:00Z') })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 500, openCjDispute: false },
      )
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('refund_sender_unauthenticated')
    })

    it('treats a NULL-sentAt row as older than a timestamped row (NULLS LAST), not as the latest', async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId })
      // A NULL sentAt row with no auth — if this sorted first under DESC, the check would
      // wrongly fail even though a real, authenticated message exists.
      await db.insert(supportMessages).values({
        ticketId,
        gmailMessageId: `${MSG_PREFIX}${uid()}`,
        direction: 'inbound',
        authResults: null,
        sentAt: null,
      })
      await seedInboundMessage(ticketId, { authResults: 'dmarc=pass', sentAt: new Date('2024-03-01T00:00:00Z') })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 500, openCjDispute: false },
      )
      expect(result).toEqual({ ok: true })
    })

    it('fails when openCjDispute is true but cjDisputeReasonId is missing', async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId })
      await seedInboundMessage(ticketId, { authResults: 'dmarc=pass' })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 500, openCjDispute: true },
      )
      expect(result.ok).toBe(false)
    })

    it('passes when openCjDispute is true and cjDisputeReasonId is present', async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId })
      await seedInboundMessage(ticketId, { authResults: 'dmarc=pass' })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 500, openCjDispute: true, cjDisputeReasonId: 'reason-1' },
      )
      expect(result).toEqual({ ok: true })
    })

    it('happy path: verified order, within total, authenticated sender, no dispute → passes', async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId })
      await seedInboundMessage(ticketId, { authResults: 'dkim=pass; dmarc=pass action=none' })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 500, openCjDispute: false },
      )
      expect(result).toEqual({ ok: true })
    })

    // m8 boundary: amountCents exactly equal to the remaining balance (total − prior applied) is
    // allowed; one cent over fails.
    it('boundary: amountCents exactly equal to the remaining balance passes', async () => {
      const orderId = await seedOrder(2000)
      await seedRefundProposal({ orderId, status: 'applied', amountCents: 500 })
      const ticketId = await seedTicket({ orderId })
      await seedInboundMessage(ticketId, { authResults: 'dmarc=pass' })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 1500, openCjDispute: false }, // remaining = 2000 - 500 = 1500
      )
      expect(result).toEqual({ ok: true })
    })

    it('boundary: remaining balance + 1 cent fails', async () => {
      const orderId = await seedOrder(2000)
      await seedRefundProposal({ orderId, status: 'applied', amountCents: 500 })
      const ticketId = await seedTicket({ orderId })
      await seedInboundMessage(ticketId, { authResults: 'dmarc=pass' })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 1501, openCjDispute: false }, // remaining = 1500, one cent over
      )
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('refund_exceeds_total')
    })

    // m9: the ORDER BY tiebreak (created_at DESC, id DESC after sentAt DESC NULLS LAST) makes
    // "latest inbound message" deterministic even when two rows share the exact same sentAt.
    it('tiebreaks same-sentAt rows by created_at DESC: the later-created row wins', async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId })
      const sameSentAt = new Date('2024-05-01T00:00:00Z')
      await db.insert(supportMessages).values({
        ticketId,
        gmailMessageId: `${MSG_PREFIX}${uid()}`,
        direction: 'inbound',
        authResults: null,
        sentAt: sameSentAt,
        createdAt: new Date('2024-05-01T00:00:01Z'),
      })
      await db.insert(supportMessages).values({
        ticketId,
        gmailMessageId: `${MSG_PREFIX}${uid()}`,
        direction: 'inbound',
        authResults: 'dmarc=pass',
        sentAt: sameSentAt,
        createdAt: new Date('2024-05-01T00:00:05Z'), // later created_at — this one should win
      })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 500, openCjDispute: false },
      )
      expect(result).toEqual({ ok: true })
    })

    it('tiebreaks same-sentAt rows by created_at DESC: the earlier-created row is correctly ignored', async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId })
      const sameSentAt = new Date('2024-05-01T00:00:00Z')
      await db.insert(supportMessages).values({
        ticketId,
        gmailMessageId: `${MSG_PREFIX}${uid()}`,
        direction: 'inbound',
        authResults: 'dmarc=pass',
        sentAt: sameSentAt,
        createdAt: new Date('2024-05-01T00:00:01Z'), // earlier created_at
      })
      await db.insert(supportMessages).values({
        ticketId,
        gmailMessageId: `${MSG_PREFIX}${uid()}`,
        direction: 'inbound',
        authResults: null,
        sentAt: sameSentAt,
        createdAt: new Date('2024-05-01T00:00:05Z'), // later created_at — this one wins, and it's unauthenticated
      })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 500, openCjDispute: false },
      )
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('refund_sender_unauthenticated')
    })
  })

  // -- validateSupportOutput composition --

  describe('validateSupportOutput', () => {
    it('rejects a propose outcome when ticket.customerEmail is null', async () => {
      const ticketId = await seedTicket()
      const result = await validateSupportOutput(
        db,
        { id: ticketId, orderId: null, customerEmail: null },
        { outcome: 'propose', reply: { body: 'Thanks for writing in.' }, rationale: 'x' },
      )
      expect(result.ok).toBe(false)
    })

    it('passes an escalate outcome straight through with no reply/refund checks', async () => {
      const ticketId = await seedTicket()
      const result = await validateSupportOutput(
        db,
        { id: ticketId, orderId: null, customerEmail: null },
        { outcome: 'escalate', escalationReason: 'legal threat', rationale: 'x' },
      )
      expect(result).toEqual({ ok: true })
    })

    it('passes a no_action outcome straight through', async () => {
      const ticketId = await seedTicket()
      const result = await validateSupportOutput(
        db,
        { id: ticketId, orderId: null, customerEmail: null },
        { outcome: 'no_action', rationale: 'x' },
      )
      expect(result).toEqual({ ok: true })
    })

    it('surfaces a reply-body URL violation for a propose outcome', async () => {
      const ticketId = await seedTicket()
      const result = await validateSupportOutput(
        db,
        { id: ticketId, orderId: null, customerEmail: 'customer@example.com' },
        { outcome: 'propose', reply: { body: 'Please visit https://evil.com to continue.' }, rationale: 'x' },
      )
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('url_not_allowed')
    })

    it('surfaces a refund cross-check failure for a propose outcome with refund', async () => {
      const orderId = await seedOrder(1000)
      const ticketId = await seedTicket({ orderId, customerEmail: 'customer@example.com' })
      await seedInboundMessage(ticketId, { authResults: 'dmarc=pass' })
      const result = await validateSupportOutput(
        db,
        { id: ticketId, orderId, customerEmail: 'customer@example.com' },
        {
          outcome: 'propose',
          reply: { body: 'Your refund is on the way once approved by a human.' },
          refund: { amountCents: 1500, reason: 'damaged', openCjDispute: false },
          rationale: 'x',
        },
      )
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('refund_exceeds_total')
    })

    it('happy path: propose with a clean reply and a valid refund passes end to end', async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId, customerEmail: 'customer@example.com' })
      await seedInboundMessage(ticketId, { authResults: 'dmarc=pass' })
      const result = await validateSupportOutput(
        db,
        { id: ticketId, orderId, customerEmail: 'customer@example.com' },
        {
          outcome: 'propose',
          reply: { body: 'Thanks for reaching out — we have processed a refund pending approval.' },
          refund: { amountCents: 500, reason: 'damaged', openCjDispute: false },
          rationale: 'x',
        },
      )
      expect(result).toEqual({ ok: true })
    })

    // m7: validateSupportOutput's optional 4th trackingUrl param threads through to
    // validateReplyBody, so a legitimate off-domain carrier tracking link in the reply passes.
    it('threads an explicit trackingUrl param through to the reply-body URL/contact screens', async () => {
      const ticketId = await seedTicket({ customerEmail: 'customer@example.com' })
      const trackingUrl = 'https://carrier.example.com/trk?id=XYZ789'
      const result = await validateSupportOutput(
        db,
        { id: ticketId, orderId: null, customerEmail: 'customer@example.com' },
        { outcome: 'propose', reply: { body: `Track it here: ${trackingUrl}` }, rationale: 'x' },
        trackingUrl,
      )
      expect(result).toEqual({ ok: true })
    })

    it('without an explicit trackingUrl argument, the same off-domain URL fails (default null, unchanged behavior)', async () => {
      const ticketId = await seedTicket({ customerEmail: 'customer@example.com' })
      const trackingUrl = 'https://carrier.example.com/trk?id=XYZ789'
      const result = await validateSupportOutput(
        db,
        { id: ticketId, orderId: null, customerEmail: 'customer@example.com' },
        { outcome: 'propose', reply: { body: `Track it here: ${trackingUrl}` }, rationale: 'x' },
      )
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('url_not_allowed')
    })
  })
})
