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
  })

  // -- URL / domain screen --

  describe('validateReplyBody: URL/domain screen', () => {
    const cases: { name: string; body: string; ok: boolean }[] = [
      { name: 'https://dogebuddy.com/track passes', body: 'Track it here: https://dogebuddy.com/track', ok: true },
      { name: 'https://www.dogebuddy.com passes', body: 'Visit https://www.dogebuddy.com for info.', ok: true },
      { name: 'http://dogebuddy.com fails (not https)', body: 'Visit http://dogebuddy.com for info.', ok: false },
      { name: 'https://evil.com fails', body: 'Visit https://evil.com for info.', ok: false },
      { name: 'https://dogebuddy.com.evil.com/x fails', body: 'Visit https://dogebuddy.com.evil.com/x for info.', ok: false },
      {
        name: 'https://dogebuddy.com@evil.com/ fails (userinfo — hostname is evil.com)',
        body: 'Visit https://dogebuddy.com@evil.com/ for info.',
        ok: false,
      },
      { name: 'bare dogebuddy-help.com fails', body: 'Please see dogebuddy-help.com for details.', ok: false },
      { name: 'bare dogebuddy.com passes', body: 'Please see dogebuddy.com for details.', ok: true },
      { name: 'admin.dogebuddy.com fails (subdomain excluded)', body: 'Please see admin.dogebuddy.com for details.', ok: false },
    ]

    for (const c of cases) {
      it(c.name, async () => {
        const ticketId = await seedTicket()
        const result = await validateReplyBody(db, ticketId, c.body, noRefund)
        expect(result.ok).toBe(c.ok)
        if (!c.ok) expect((result as { code: string }).code).toBe('url_not_allowed')
      })
    }

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
    it('help@gmail.com fails', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'You can also reach us at help@gmail.com any time.', noRefund)
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

    it('"order #12345" passes (digits < 7 with separators)', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Please reference order #12345 when you write back.', noRefund)
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
  })
})
