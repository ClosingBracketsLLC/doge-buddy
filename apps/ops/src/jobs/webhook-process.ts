import { type createDb, auditLog, webhookEvents } from '@doge-buddy/db'
import { eq } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import { type ShopifyOrderPaidPayload, upsertOrderFromPaidPayload } from '../fulfillment/order-upsert.ts'
import type { SendOpts } from '../fulfillment/types.ts'

export type { SendOpts }

type Db = ReturnType<typeof createDb>['db']

export interface WebhookProcessDeps {
  db: Db
  enqueue: (name: string, data: object, opts?: SendOpts) => Promise<void>
}

/**
 * Send options for the fulfillment queues this router enqueues into (design spec, exact):
 * 5 retries with exponential backoff starting at 30s. `singletonKey` is layered on per
 * call-site — it's the part that actually varies (and the part that gives pg-boss something
 * to dedupe on).
 */
const FULFILLMENT_RETRY_OPTS: SendOpts = { retryLimit: 5, retryBackoff: true, retryDelay: 30 }

/**
 * Processes exactly one webhook_events row: routes by (source, topic), marks the row
 * processed, and writes exactly one audit_log row. Throws on any failure (missing row,
 * malformed payload, DB error) — the caller is responsible for catching this per job so a
 * failure here can retry in isolation without skipping the row's audit entry forever.
 */
async function processOne(deps: WebhookProcessDeps, source: 'shopify' | 'cj', webhookEventId: string): Promise<void> {
  const [event] = await deps.db.select().from(webhookEvents).where(eq(webhookEvents.id, webhookEventId))
  if (!event) {
    throw new Error(`webhook_events row not found: ${webhookEventId}`)
  }

  let action = 'webhook.ignored'
  let orderGid: string | undefined

  if (source === 'shopify' && event.topic === 'orders/paid') {
    const upserted = await upsertOrderFromPaidPayload(deps.db, event.payload as ShopifyOrderPaidPayload)
    orderGid = upserted.orderGid
    await deps.enqueue('fulfillment.place-order', { orderGid }, { singletonKey: orderGid, ...FULFILLMENT_RETRY_OPTS })
    action = 'webhook.processed'
  }
  // Every other (source, topic) pair — including all CJ topics for now — is stubbed: mark
  // processed and audit as ignored. CJ ORDER/LOGISTICS routing arrives in Task 12.

  await deps.db.update(webhookEvents).set({ processedAt: new Date() }).where(eq(webhookEvents.id, webhookEventId))

  await deps.db.insert(auditLog).values({
    actor: 'system',
    action,
    entityType: 'webhook_event',
    entityId: webhookEventId,
    detail: { source, topic: event.topic ?? null, ...(orderGid ? { orderGid } : {}) },
  })
}

/**
 * Worker callback for the `webhook.shopify.process` / `webhook.cj.process` queues.
 *
 * Per-job isolation: each job in the batch gets its own try/catch. A poison job's error is
 * collected, not thrown immediately, so every other job in the same call still gets processed
 * and audited; only after the whole batch has been attempted does this re-throw (so pg-boss
 * retries the job(s) that actually failed instead of silently swallowing the error).
 *
 * This matters even though it's structurally redundant in production: `queue.ts` registers
 * these workers via `boss.work(name, handler)` with no options object, and pg-boss@10.4.2's
 * `attorney.js` (`checkWorkArgs`) defaults `options.batchSize = options.batchSize || 1` — so
 * `jobs` is always length 1 there, and a thrown error already retries exactly one job with no
 * help from this loop. The per-job try/catch is what makes the handler correct on its own
 * terms (independent of that registration detail, and exercised directly by tests that call it
 * with a multi-job batch).
 */
export function webhookProcessHandler(deps: WebhookProcessDeps, source: 'shopify' | 'cj') {
  return async (jobs: PgBoss.Job<{ webhookEventId: string }>[]): Promise<void> => {
    const failures: unknown[] = []
    for (const job of jobs) {
      try {
        await processOne(deps, source, job.data.webhookEventId)
      } catch (err) {
        failures.push(err)
      }
    }
    if (failures.length === 1) {
      throw failures[0]
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, `${failures.length} webhook job(s) failed`)
    }
  }
}
