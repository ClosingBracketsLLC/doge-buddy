import { createDb, proposals, auditLog, orders, supportMessages, supportTickets } from '@doge-buddy/db'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSettings } from '../src/settings.ts'
import { createCaptureNotifier } from '../src/notify/capture.ts'
import { hashActionToken } from '../src/proposals/tokens.ts'
import { submitProposal } from '../src/proposals/submit.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

function newListingPayload() {
  return {
    type: 'new_listing', title: 'Dog Snuff Pad', descriptionHtml: '<p>x</p>',
    categoryTag: 'toys', imageUrls: ['https://cf.cjdropshipping.com/x.png'], shipsFrom: 'US',
    deliveryMinDays: 3, deliveryMaxDays: 7,
    variants: [{ sku: `SKU-${crypto.randomUUID()}`, priceCents: 2999, supplierCostCents: 1414,
      supplier: 'cj', supplierProductId: 'cjp-1', supplierVariantId: 'cjv-1' }],
  }
}

function refundPayload(amountCents: number, orderId: string = crypto.randomUUID()) {
  return {
    type: 'refund',
    orderId,
    shopifyOrderGid: 'gid://shopify/Order/123',
    amountCents,
    reason: 'damaged',
    openCjDispute: false,
    threadSnapshotAt: '2026-08-27T12:00:00.000Z',
  }
}

function deprecateProductPayload(productId: string = crypto.randomUUID()) {
  return {
    type: 'deprecate_product',
    productId,
    evidence: {
      unitsSold28d: 0,
      refundCount28d: 0,
      ticketCount28d: 0,
      daysLive: 30,
    },
  }
}

// Task 8: same shape as `validContext` in packages/core/test/proposals.test.ts.
const validContext = {
  version: 1 as const,
  economics: {
    freight: { priceCents: 649, name: 'USPS Ground', minDays: 3, maxDays: 7 },
    variants: [{ sku: 'DB-1', priceCents: 2399, supplierCostCents: 612, landedCents: 1261, profitCents: 1138, marginBps: 4743 }],
    market: { query: 'dog water bottle', offerCount: 12, medianCents: 2199, typicalCents: 2399, ceilingCents: 2858, maxPriceToMarketBps: 13000 },
    usStockUnits: 214,
  },
  demand: {
    cjListedCount: 1200,
    cjReviews: { page1Count: 10, ratedCount: 8, avgRating: 4.6 },
    marketOfferCount: 12,
    trends: { keyword: 'dog leash', score: 62.1, momentum: 8 },
    amazon: { query: 'dog water bottle', resultsSampled: 10, medianPriceCents: 2199, medianReviews: 3400, totalReviews: 54000 },
  },
}

describe('submitProposal', () => {
  const { db, pool } = createDb(url)

  beforeEach(async () => {
    await db.delete(auditLog)
    await db.delete(proposals)
  })
  afterAll(() => pool.end())

  // -- Task 18: per-type Telegram notify bodies --------------------------------------------------

  let ticketIds: string[] = []
  let orderIds: string[] = []

  afterEach(async () => {
    if (ticketIds.length > 0) {
      await db.delete(supportMessages).where(inArray(supportMessages.ticketId, ticketIds))
      await db.delete(supportTickets).where(inArray(supportTickets.id, ticketIds))
      ticketIds = []
    }
    if (orderIds.length > 0) {
      await db.delete(orders).where(inArray(orders.id, orderIds))
      orderIds = []
    }
  })

  async function seedTicket(overrides: Partial<{ subject: string; customerEmail: string }> = {}) {
    const [ticket] = await db
      .insert(supportTickets)
      .values({
        gmailThreadId: `t18-${crypto.randomUUID()}`,
        customerEmail: overrides.customerEmail ?? 'buyer@example.com',
        subject: overrides.subject ?? 'Where is my order',
        status: 'awaiting_approval',
      })
      .returning()
    ticketIds.push(ticket!.id)
    return ticket!
  }

  async function seedOrder(number = '#2001') {
    const [order] = await db
      .insert(orders)
      .values({
        shopifyOrderGid: `gid://shopify/Order/${crypto.randomUUID()}`,
        shopifyOrderNumber: number,
        isTest: true,
      })
      .returning()
    orderIds.push(order!.id)
    return order!
  }

  it('support_reply notify body: a >800-char draft is head(600)+tail(200) excerpted with … between', async () => {
    const settings = createSettings(db)
    const { notify, sent } = createCaptureNotifier()
    const enqueue = vi.fn()
    const alert = vi.fn()
    const ticket = await seedTicket()

    const head = 'H'.repeat(600)
    const middle = 'M'.repeat(1200)
    const tail = 'T'.repeat(200)
    const longBody = head + middle + tail // 2000 chars total

    await submitProposal(
      { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
      {
        type: 'support_reply',
        summary: 'Reply: test',
        payload: { type: 'support_reply', ticketId: ticket.id, body: longBody, threadSnapshotAt: new Date().toISOString() },
        sourceWorkflow: 'support',
        ticketId: ticket.id,
      },
    )

    const notification = sent[0]!
    expect(notification.body).toContain(head)
    expect(notification.body).toContain(tail)
    expect(notification.body).toContain('…')
    expect(notification.body).not.toContain(middle)
    expect(notification.body.indexOf(head)).toBeLessThan(notification.body.indexOf('…'))
    expect(notification.body.indexOf('…')).toBeLessThan(notification.body.indexOf(tail))
  })

  it('support_reply notify body: an 800-char-or-under draft is NOT excerpted — the whole body appears', async () => {
    const settings = createSettings(db)
    const { notify, sent } = createCaptureNotifier()
    const enqueue = vi.fn()
    const alert = vi.fn()
    const ticket = await seedTicket()
    const shortBody = 'S'.repeat(800)

    await submitProposal(
      { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
      {
        type: 'support_reply',
        summary: 'Reply: test',
        payload: { type: 'support_reply', ticketId: ticket.id, body: shortBody, threadSnapshotAt: new Date().toISOString() },
        sourceWorkflow: 'support',
        ticketId: ticket.id,
      },
    )

    const notification = sent[0]!
    expect(notification.body).toContain(shortBody)
    expect(notification.body).not.toContain('…')
  })

  it('support_reply notify body includes the ticket subject/customer and does NOT contain the ⚠ line when no sibling refund is pending', async () => {
    const settings = createSettings(db)
    const { notify, sent } = createCaptureNotifier()
    const enqueue = vi.fn()
    const alert = vi.fn()
    const ticket = await seedTicket({ subject: 'Broken widget', customerEmail: 'alice@example.com' })

    await submitProposal(
      { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
      {
        type: 'support_reply',
        summary: 'Reply: test',
        payload: { type: 'support_reply', ticketId: ticket.id, body: 'Sorry about that.', threadSnapshotAt: new Date().toISOString() },
        sourceWorkflow: 'support',
        ticketId: ticket.id,
      },
    )

    const notification = sent[0]!
    expect(notification.body).toContain('Broken widget')
    expect(notification.body).toContain('alice@example.com')
    expect(notification.body).not.toContain('⚠')
  })

  it('support_reply notify body: warns with the paired proposal id when a sibling refund is pending', async () => {
    const settings = createSettings(db)
    const { notify, sent } = createCaptureNotifier()
    const enqueue = vi.fn()
    const alert = vi.fn()
    const ticket = await seedTicket()
    const order = await seedOrder()

    const refundResult = await submitProposal(
      { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
      {
        type: 'refund',
        summary: 'Refund test',
        payload: refundPayload(1000, order.id),
        sourceWorkflow: 'support',
        ticketId: ticket.id,
        orderId: order.id,
      },
    )
    expect(refundResult.status).toBe('pending')

    await submitProposal(
      { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
      {
        type: 'support_reply',
        summary: 'Reply: test',
        payload: {
          type: 'support_reply',
          ticketId: ticket.id,
          body: 'Your refund is on the way.',
          threadSnapshotAt: new Date().toISOString(),
        },
        sourceWorkflow: 'support',
        ticketId: ticket.id,
      },
    )

    expect(sent).toHaveLength(2)
    const replyNotification = sent[1]!
    expect(replyNotification.body).toContain('⚠ promises a refund')
    expect(replyNotification.body).toContain(refundResult.id)
    // FR2c: the wording now reflects that after the reply ships, a rejected/expired refund
    // re-escalates the ticket (the old "rejecting it cancels this reply" was false post-ship).
    expect(replyNotification.body).toContain('decide/approve the paired refund proposal')
    expect(replyNotification.body).toContain('the ticket re-escalates')
  })

  it('refund notify body: amount + order number + reason, dispute flag, and no crash with no linked order/ticket', async () => {
    const settings = createSettings(db)
    const { notify, sent } = createCaptureNotifier()
    const enqueue = vi.fn()
    const alert = vi.fn()
    const order = await seedOrder('#3005')

    await submitProposal(
      { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
      {
        type: 'refund',
        summary: 'Refund test',
        payload: { ...refundPayload(2599, order.id), openCjDispute: true, cjDisputeReasonId: 'r1' },
        sourceWorkflow: 'support',
      },
    )

    const notification = sent[0]!
    expect(notification.body).toContain('$25.99')
    expect(notification.body).toContain('#3005')
    expect(notification.body).toContain('damaged')
    expect(notification.body).toContain('CJ dispute: requested')
  })

  it('manual mode: lands pending, tokened, notified, audited', async () => {
    const settings = createSettings(db)
    const { notify, sent } = createCaptureNotifier()
    const enqueue = vi.fn()
    const alert = vi.fn()

    const result = await submitProposal(
      { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
      {
        type: 'new_listing',
        summary: 'New listing: Dog Snuff Pad',
        payload: newListingPayload(),
        sourceWorkflow: 'sourcing-agent',
      },
    )

    expect(result.status).toBe('pending')

    const [row] = await db.select().from(proposals).where(eq(proposals.id, result.id))
    expect(row).toBeDefined()
    expect(row!.actionTokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(row!.autoApproved).toBe(false)

    expect(sent).toHaveLength(1)
    const notification = sent[0]!
    expect(notification.body).toContain('IP check done')
    expect(notification.body).toContain('TikTok Creative Center')
    expect(notification.body).toContain(`https://ops.test/admin/proposals/${result.id}`)

    expect(notification.actions).toBeDefined()
    expect(notification.actions).toHaveLength(2)
    const [approve, reject] = notification.actions!
    expect(approve!.label).toBe('Approve')
    expect(reject!.label).toBe('Reject')

    const approveMatch = approve!.url.match(
      new RegExp(`^https://ops\\.test/a/${result.id}/approve\\?t=(.+)$`),
    )
    const rejectMatch = reject!.url.match(
      new RegExp(`^https://ops\\.test/a/${result.id}/reject\\?t=(.+)$`),
    )
    expect(approveMatch).not.toBeNull()
    expect(rejectMatch).not.toBeNull()
    const approveToken = approveMatch![1]!
    const rejectToken = rejectMatch![1]!
    expect(approveToken).toBe(rejectToken)

    expect(enqueue).not.toHaveBeenCalled()

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'proposal.created'), eq(auditLog.entityId, result.id)))
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]).toMatchObject({
      actor: 'system',
      action: 'proposal.created',
      entityType: 'proposal',
      entityId: result.id,
      detail: { type: 'new_listing', sourceWorkflow: 'sourcing-agent', mode: 'manual' },
    })
  })

  it('the token in the notification hashes to the stored actionTokenHash', async () => {
    const settings = createSettings(db)
    const { notify, sent } = createCaptureNotifier()
    const enqueue = vi.fn()
    const alert = vi.fn()

    const result = await submitProposal(
      { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
      {
        type: 'new_listing',
        summary: 'New listing: Dog Snuff Pad',
        payload: newListingPayload(),
        sourceWorkflow: 'sourcing-agent',
      },
    )

    const notification = sent[0]!
    const approve = notification.actions![0]!
    const match = approve.url.match(/[?&]t=([^&]+)/)
    expect(match).not.toBeNull()
    const token = decodeURIComponent(match![1]!)

    const [row] = await db.select().from(proposals).where(eq(proposals.id, result.id))
    expect(hashActionToken(token)).toBe(row!.actionTokenHash)
  })

  it('auto mode: lands approved, enqueues apply, audits created+approve', async () => {
    const settings = createSettings(db)
    const { notify, sent } = createCaptureNotifier()
    const enqueue = vi.fn(async () => {})
    const alert = vi.fn()

    await settings.set('workflow.sourcing.mode', 'auto')
    try {
      const result = await submitProposal(
        { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
        {
          type: 'new_listing',
          summary: 'New listing: Dog Snuff Pad',
          payload: newListingPayload(),
          sourceWorkflow: 'sourcing-agent',
        },
      )

      expect(result.status).toBe('approved')

      const [row] = await db.select().from(proposals).where(eq(proposals.id, result.id))
      expect(row!.autoApproved).toBe(true)
      expect(row!.decidedBy).toBe('system:auto')
      expect(row!.decidedAt).not.toBeNull()
      expect(row!.actionTokenHash).toBeNull()

      expect(sent).toHaveLength(0)

      expect(enqueue).toHaveBeenCalledTimes(1)
      expect(enqueue).toHaveBeenCalledWith(
        'proposal.apply',
        { proposalId: result.id },
        { retryLimit: 5, retryBackoff: true, retryDelay: 30, expireInSeconds: 600, singletonKey: result.id },
      )

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, result.id))
      const actions = auditRows.map((r) => r.action).sort()
      expect(actions).toEqual(['proposal.approve', 'proposal.created'])
      const approveRow = auditRows.find((r) => r.action === 'proposal.approve')!
      expect(approveRow.detail).toMatchObject({ via: 'auto' })
    } finally {
      await settings.set('workflow.sourcing.mode', 'manual')
    }
  })

  it('refund is ALWAYS manual — even in auto mode, under OR over cap, it needs owner approval (owner ruling: sole approver of every refund)', async () => {
    const settings = createSettings(db)
    const { notify, sent } = createCaptureNotifier()
    const enqueue = vi.fn(async () => {})
    const alert = vi.fn()

    // Force the strongest auto config: auto mode AND an amount well under the cap. Even so, the
    // refund type is hard-locked to manual in code — the mode setting and the cap are ignored for
    // refunds. A refund can never be auto-approved.
    await settings.set('workflow.refund.mode', 'auto')
    try {
      const overCap = await submitProposal(
        { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
        {
          type: 'refund',
          summary: 'Refund over cap',
          payload: refundPayload(5000),
          sourceWorkflow: 'support-agent',
        },
      )
      expect(overCap.status).toBe('pending')
      const [overRow] = await db.select().from(proposals).where(eq(proposals.id, overCap.id))
      expect(overRow!.autoApproved).toBe(false)
      expect(overRow!.decidedBy).toBeNull()
      expect(overRow!.actionTokenHash).toMatch(/^[a-f0-9]{64}$/)

      const underCap = await submitProposal(
        { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
        {
          type: 'refund',
          summary: 'Refund under cap',
          payload: refundPayload(1000),
          sourceWorkflow: 'support-agent',
        },
      )
      // Under-cap in auto mode would previously have auto-approved; now it stays manual.
      expect(underCap.status).toBe('pending')
      const [underRow] = await db.select().from(proposals).where(eq(proposals.id, underCap.id))
      expect(underRow!.autoApproved).toBe(false)
      expect(underRow!.decidedBy).toBeNull()
      expect(enqueue).not.toHaveBeenCalled() // never enqueued for apply without approval
      expect(sent).toHaveLength(2) // both notified the owner for a decision
    } finally {
      await settings.set('workflow.refund.mode', 'manual')
    }
  })

  it('invalid payload rejects: throws zod error, no row inserted', async () => {
    const settings = createSettings(db)
    const { notify } = createCaptureNotifier()
    const enqueue = vi.fn()
    const alert = vi.fn()

    const before = await db.select().from(proposals)

    await expect(
      submitProposal(
        { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
        {
          type: 'new_listing',
          summary: 'Bad listing',
          payload: { type: 'new_listing' },
          sourceWorkflow: 'sourcing-agent',
        },
      ),
    ).rejects.toThrow()

    const after = await db.select().from(proposals)
    expect(after).toHaveLength(before.length)
  })

  it('notify failure still lands pending without throwing', async () => {
    const settings = createSettings(db)
    const notify = async () => false
    const enqueue = vi.fn()
    const alert = vi.fn()

    const result = await submitProposal(
      { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
      {
        type: 'new_listing',
        summary: 'New listing: Dog Snuff Pad',
        payload: newListingPayload(),
        sourceWorkflow: 'sourcing-agent',
      },
    )

    expect(result.status).toBe('pending')
    const [row] = await db.select().from(proposals).where(eq(proposals.id, result.id))
    expect(row).toBeDefined()
  })

  it('auto mode: enqueue throw is swallowed — resolves approved, alerts apply_enqueue_failed, row stays approved', async () => {
    const settings = createSettings(db)
    const { notify, sent } = createCaptureNotifier()
    const enqueue = vi.fn(async () => {
      throw new Error('boss unavailable')
    })
    const alert = vi.fn(async () => {})

    await settings.set('workflow.sourcing.mode', 'auto')
    try {
      const result = await submitProposal(
        { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
        {
          type: 'new_listing',
          summary: 'New listing: Dog Snuff Pad',
          payload: newListingPayload(),
          sourceWorkflow: 'sourcing-agent',
        },
      )

      expect(result.status).toBe('approved')
      expect(sent).toHaveLength(0)

      expect(alert).toHaveBeenCalledWith('critical', 'apply_enqueue_failed', { proposalId: result.id })

      const [row] = await db.select().from(proposals).where(eq(proposals.id, result.id))
      expect(row!.status).toBe('approved')
      expect(row!.autoApproved).toBe(true)
    } finally {
      await settings.set('workflow.sourcing.mode', 'manual')
    }
  })

  it('manual mode with no adminBaseUrl: alerts notify_unconfigured, no notify call, still lands pending', async () => {
    const settings = createSettings(db)
    const { notify, sent } = createCaptureNotifier()
    const enqueue = vi.fn()
    const alert = vi.fn(async () => {})

    const result = await submitProposal(
      { db, settings, notify, enqueue, alert },
      {
        type: 'new_listing',
        summary: 'New listing: Dog Snuff Pad',
        payload: newListingPayload(),
        sourceWorkflow: 'sourcing-agent',
      },
    )

    expect(result.status).toBe('pending')
    expect(sent).toHaveLength(0)
    expect(alert).toHaveBeenCalledWith('warning', 'notify_unconfigured', { proposalId: result.id })

    const [row] = await db.select().from(proposals).where(eq(proposals.id, result.id))
    expect(row).toBeDefined()
    expect(row!.actionTokenHash).toMatch(/^[a-f0-9]{64}$/)
  })

  // Fix round 1 (Task 18 review), M8: the WHOLE assembled Telegram body must be capped, not any
  // one field — a hostile/very-long ticket subject must not blow the send past Telegram's message
  // limit and silently suppress the owner's page.
  it('support_reply notify body: a 4000-char subject is capped — the assembled body never exceeds 3500 chars', async () => {
    const settings = createSettings(db)
    const { notify, sent } = createCaptureNotifier()
    const enqueue = vi.fn()
    const alert = vi.fn()
    const ticket = await seedTicket({ subject: 'S'.repeat(4000) })

    await submitProposal(
      { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
      {
        type: 'support_reply',
        summary: 'Reply: test',
        payload: { type: 'support_reply', ticketId: ticket.id, body: 'A short reply.', threadSnapshotAt: new Date().toISOString() },
        sourceWorkflow: 'support',
        ticketId: ticket.id,
      },
    )

    expect(sent).toHaveLength(1)
    expect(sent[0]!.body.length).toBeLessThanOrEqual(3500)
  })

  // Fix round 2 (Task 18 review), N1: round 1's M8 head-sliced the WHOLE assembled body, which
  // silently truncated the ⚠ paired-refund warning off the end whenever a long subject pushed it
  // past 3500 chars — the reviewer's exact repro. Round 2 bounds the subject BEFORE assembly and
  // appends the ⚠ line as mandatory tail (guaranteed to survive the final cap), so this must now
  // hold even at the reviewer's reported length.
  it('N1 fix: a 3400-char subject with a live sibling refund still shows the ⚠ warning AND the full head/tail draft excerpt (body stays ≤3500)', async () => {
    const settings = createSettings(db)
    const { notify, sent } = createCaptureNotifier()
    const enqueue = vi.fn()
    const alert = vi.fn()
    const ticket = await seedTicket({ subject: 'S'.repeat(3400) })
    const order = await seedOrder()

    const refundResult = await submitProposal(
      { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
      {
        type: 'refund',
        summary: 'Refund test',
        payload: refundPayload(1000, order.id),
        sourceWorkflow: 'support',
        ticketId: ticket.id,
        orderId: order.id,
      },
    )
    expect(refundResult.status).toBe('pending')

    const head = 'H'.repeat(600)
    const middle = 'M'.repeat(1200)
    const tail = 'T'.repeat(200)
    const longBody = head + middle + tail // 2000 chars, > 800 -> triggers the head/tail excerpt

    await submitProposal(
      { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
      {
        type: 'support_reply',
        summary: 'Reply: test',
        payload: { type: 'support_reply', ticketId: ticket.id, body: longBody, threadSnapshotAt: new Date().toISOString() },
        sourceWorkflow: 'support',
        ticketId: ticket.id,
      },
    )

    expect(sent).toHaveLength(2)
    const replyBody = sent[1]!.body
    expect(replyBody.length).toBeLessThanOrEqual(3500)
    expect(replyBody).toContain('⚠ promises a refund')
    expect(replyBody).toContain(refundResult.id)
    expect(replyBody).toContain('decide/approve the paired refund proposal') // FR2c wording
    // The head-600/tail-200 draft excerpt rule still holds despite the huge subject.
    expect(replyBody).toContain(head)
    expect(replyBody).toContain(tail)
    expect(replyBody).toContain('…')
    expect(replyBody).not.toContain(middle)
  })

  // N1 also covers the generic body's mandatory tail: the admin deep link must survive an
  // unusually long `summary` the same way the ⚠ line survives a long subject.
  it('N1 fix: a new_listing notify body with an extremely long summary still keeps the admin deep link', async () => {
    const settings = createSettings(db)
    const { notify, sent } = createCaptureNotifier()
    const enqueue = vi.fn()
    const alert = vi.fn()

    const result = await submitProposal(
      { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
      {
        type: 'new_listing',
        summary: 'X'.repeat(4000),
        payload: newListingPayload(),
        sourceWorkflow: 'sourcing-agent',
      },
    )

    expect(sent).toHaveLength(1)
    const body = sent[0]!.body
    expect(body.length).toBeLessThanOrEqual(3500)
    expect(body).toContain(`https://ops.test/admin/proposals/${result.id}`)
  })

  // -- Task 4: `suppressNotify` opt --------------------------------------------------------------

  it('manual mode with opts.suppressNotify: lands pending, actionTokenHash NULL, notify NOT called, audit still written', async () => {
    const settings = createSettings(db)
    const { notify, sent } = createCaptureNotifier()
    const enqueue = vi.fn()
    const alert = vi.fn()
    const productId = crypto.randomUUID()

    const result = await submitProposal(
      { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
      {
        type: 'deprecate_product',
        summary: 'Deprecate: X',
        payload: deprecateProductPayload(productId),
        sourceWorkflow: 'scoring',
        productId,
      },
      { suppressNotify: true },
    )

    expect(result.status).toBe('pending')
    expect(sent).toHaveLength(0)

    const [row] = await db.select().from(proposals).where(eq(proposals.id, result.id))
    expect(row).toBeDefined()
    expect(row!.actionTokenHash).toBeNull()
    expect(row!.autoApproved).toBe(false)

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'proposal.created'), eq(auditLog.entityId, result.id)))
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]).toMatchObject({
      actor: 'system',
      action: 'proposal.created',
      entityType: 'proposal',
      entityId: result.id,
      detail: { type: 'deprecate_product', sourceWorkflow: 'scoring', mode: 'manual' },
    })
  })

  it('manual mode WITHOUT suppressNotify (same payload/type): still tokens + notifies as before', async () => {
    const settings = createSettings(db)
    const { notify, sent } = createCaptureNotifier()
    const enqueue = vi.fn()
    const alert = vi.fn()
    const productId = crypto.randomUUID()

    const result = await submitProposal(
      { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
      {
        type: 'deprecate_product',
        summary: 'Deprecate: X',
        payload: deprecateProductPayload(productId),
        sourceWorkflow: 'scoring',
        productId,
      },
    )

    expect(result.status).toBe('pending')
    expect(sent).toHaveLength(1)

    const [row] = await db.select().from(proposals).where(eq(proposals.id, result.id))
    expect(row!.actionTokenHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('manual mode with suppressNotify AND no adminBaseUrl: still no notify, no notify_unconfigured alert either', async () => {
    const settings = createSettings(db)
    const { notify, sent } = createCaptureNotifier()
    const enqueue = vi.fn()
    const alert = vi.fn(async () => {})
    const productId = crypto.randomUUID()

    const result = await submitProposal(
      { db, settings, notify, enqueue, alert },
      {
        type: 'deprecate_product',
        summary: 'Deprecate: X',
        payload: deprecateProductPayload(productId),
        sourceWorkflow: 'scoring',
        productId,
      },
      { suppressNotify: true },
    )

    expect(result.status).toBe('pending')
    expect(sent).toHaveLength(0)
    expect(alert).not.toHaveBeenCalled()

    const [row] = await db.select().from(proposals).where(eq(proposals.id, result.id))
    expect(row!.actionTokenHash).toBeNull()
  })

  it('auto mode ignores suppressNotify (irrelevant on the auto path — no notify either way)', async () => {
    const settings = createSettings(db)
    const { notify, sent } = createCaptureNotifier()
    const enqueue = vi.fn(async () => {})
    const alert = vi.fn()

    await settings.set('workflow.deprecation.mode', 'auto')
    try {
      const productId = crypto.randomUUID()
      const result = await submitProposal(
        { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
        {
          type: 'deprecate_product',
          summary: 'Deprecate: X',
          payload: deprecateProductPayload(productId),
          sourceWorkflow: 'scoring',
          productId,
        },
        { suppressNotify: true },
      )

      expect(result.status).toBe('approved')
      expect(sent).toHaveLength(0)
      expect(enqueue).toHaveBeenCalledTimes(1)
    } finally {
      await settings.set('workflow.deprecation.mode', 'manual')
    }
  })

  // -- Task 8: submitProposal carries decisionContext ------------------------------------------

  it('persists a valid decisionContext on the manual path', async () => {
    const settings = createSettings(db)
    const { notify } = createCaptureNotifier()
    const enqueue = vi.fn()
    const alert = vi.fn()

    const result = await submitProposal(
      { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
      {
        type: 'new_listing',
        summary: 'New listing: Dog Snuff Pad',
        payload: newListingPayload(),
        sourceWorkflow: 'sourcing-agent',
        decisionContext: validContext,
      },
    )

    const [row] = await db.select().from(proposals).where(eq(proposals.id, result.id))
    expect(row!.decisionContext).toEqual(validContext)
  })

  it('persists decisionContext on the auto path too', async () => {
    const settings = createSettings(db)
    const { notify } = createCaptureNotifier()
    const enqueue = vi.fn(async () => {})
    const alert = vi.fn()

    await settings.set('workflow.sourcing.mode', 'auto')
    try {
      const result = await submitProposal(
        { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
        {
          type: 'new_listing',
          summary: 'New listing: Dog Snuff Pad',
          payload: newListingPayload(),
          sourceWorkflow: 'sourcing-agent',
          decisionContext: validContext,
        },
      )

      const [row] = await db.select().from(proposals).where(eq(proposals.id, result.id))
      expect(row!.decisionContext).toEqual(validContext)
    } finally {
      await settings.set('workflow.sourcing.mode', 'manual')
    }
  })

  it('inserts null when decisionContext absent (existing callers unchanged)', async () => {
    const settings = createSettings(db)
    const { notify } = createCaptureNotifier()
    const enqueue = vi.fn()
    const alert = vi.fn()

    const result = await submitProposal(
      { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
      {
        type: 'new_listing',
        summary: 'New listing: Dog Snuff Pad',
        payload: newListingPayload(),
        sourceWorkflow: 'sourcing-agent',
      },
    )

    const [row] = await db.select().from(proposals).where(eq(proposals.id, result.id))
    expect(row!.decisionContext).toBeNull()
  })

  it('throws on a decisionContext that fails its schema', async () => {
    const settings = createSettings(db)
    const { notify } = createCaptureNotifier()
    const enqueue = vi.fn()
    const alert = vi.fn()

    await expect(
      submitProposal(
        { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
        {
          type: 'new_listing',
          summary: 'New listing: Dog Snuff Pad',
          payload: newListingPayload(),
          sourceWorkflow: 'sourcing-agent',
          decisionContext: { version: 2 } as never,
        },
      ),
    ).rejects.toThrow()
  })
})
