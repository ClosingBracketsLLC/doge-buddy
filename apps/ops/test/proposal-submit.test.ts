import { createDb, proposals, auditLog } from '@doge-buddy/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

function refundPayload(amountCents: number) {
  return {
    type: 'refund',
    orderId: crypto.randomUUID(),
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
        { retryLimit: 5, retryBackoff: true, retryDelay: 30, singletonKey: result.id },
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
})
