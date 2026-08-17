import { auditLog, createDb, webhookEvents } from '@doge-buddy/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { webhookProcessHandler } from '../src/jobs/webhook-process.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

describe('webhookProcessHandler', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  it('sets processed_at on the event row and writes an audit_log row (shopify)', async () => {
    const externalEventId = `wh-process-${Date.now()}-1`
    const [event] = await db
      .insert(webhookEvents)
      .values({ source: 'shopify', externalEventId, topic: 'ORDERS_PAID', payload: { id: 1 } })
      .returning({ id: webhookEvents.id })
    const webhookEventId = event!.id

    const handler = webhookProcessHandler(db, 'shopify')
    await handler([
      {
        id: 'job-1',
        name: 'webhook.shopify.process',
        data: { webhookEventId },
        expireInSeconds: 900,
      },
    ])

    const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, webhookEventId))
    expect(row!.processedAt).not.toBeNull()

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'webhook_event'), eq(auditLog.entityId, webhookEventId)))
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.actor).toBe('system')
    expect(auditRows[0]!.action).toBe('webhook.processed')
    expect(auditRows[0]!.detail).toEqual({ source: 'shopify', topic: 'ORDERS_PAID' })
  })

  it('processes multiple jobs in a single batch call (cj)', async () => {
    const ids: string[] = []
    for (let i = 0; i < 2; i++) {
      const externalEventId = `wh-process-${Date.now()}-cj-${i}`
      const [event] = await db
        .insert(webhookEvents)
        .values({ source: 'cj', externalEventId, topic: 'order', payload: {} })
        .returning({ id: webhookEvents.id })
      ids.push(event!.id)
    }

    const handler = webhookProcessHandler(db, 'cj')
    await handler(
      ids.map((webhookEventId, i) => ({
        id: `job-cj-${i}`,
        name: 'webhook.cj.process',
        data: { webhookEventId },
        expireInSeconds: 900,
      })),
    )

    for (const id of ids) {
      const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, id))
      expect(row!.processedAt).not.toBeNull()

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityType, 'webhook_event'), eq(auditLog.entityId, id)))
      expect(auditRows).toHaveLength(1)
      expect(auditRows[0]!.detail).toEqual({ source: 'cj', topic: 'order' })
    }
  })
})
