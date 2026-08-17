import { auditLog, type createDb, webhookEvents } from '@doge-buddy/db'
import { eq } from 'drizzle-orm'
import type PgBoss from 'pg-boss'

type Db = ReturnType<typeof createDb>['db']

/**
 * Batch handler for the `webhook.shopify.process` / `webhook.cj.process` queues. For each job,
 * marks the corresponding webhook_events row processed and records an audit_log entry.
 *
 * Real routing/dispatch semantics (acting on the webhook's contents) arrive in Phase 3 — this
 * only proves the enqueue -> process -> audit pipeline works end-to-end.
 */
export function webhookProcessHandler(db: Db, source: 'shopify' | 'cj') {
  return async (jobs: PgBoss.Job<{ webhookEventId: string }>[]): Promise<void> => {
    for (const job of jobs) {
      const { webhookEventId } = job.data

      const [updated] = await db
        .update(webhookEvents)
        .set({ processedAt: new Date() })
        .where(eq(webhookEvents.id, webhookEventId))
        .returning({ topic: webhookEvents.topic })

      await db.insert(auditLog).values({
        actor: 'system',
        action: 'webhook.processed',
        entityType: 'webhook_event',
        entityId: webhookEventId,
        detail: { source, topic: updated?.topic ?? null },
      })
    }
  }
}
