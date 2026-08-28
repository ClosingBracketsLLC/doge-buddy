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
    expect(replyNotification.body).toContain('decide the refund first or together')
    expect(replyNotification.body).toContain('rejecting it cancels this reply')
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

  it('refund auto-cap fallback: over cap falls back to manual, under cap stays auto', async () => {
    const settings = createSettings(db)
    const { notify, sent } = createCaptureNotifier()
    const enqueue = vi.fn(async () => {})
    const alert = vi.fn()

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
      expect(overRow!.actionTokenHash).toMatch(/^[a-f0-9]{64}$/)
      expect(sent).toHaveLength(1)

      const underCap = await submitProposal(
        { db, settings, notify, enqueue, alert, adminBaseUrl: 'https://ops.test' },
        {
          type: 'refund',
          summary: 'Refund under cap',
          payload: refundPayload(1000),
          sourceWorkflow: 'support-agent',
        },
      )
      expect(underCap.status).toBe('approved')
      const [underRow] = await db.select().from(proposals).where(eq(proposals.id, underCap.id))
      expect(underRow!.autoApproved).toBe(true)
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
})
