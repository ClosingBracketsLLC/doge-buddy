import { type createDb, auditLog, supplierOrders, webhookEvents } from '@doge-buddy/db'
import { mapCjOrderStatus } from '@doge-buddy/supplier'
import { and, eq } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import { mapCjStatus } from '../fulfillment/cj-status-map.ts'
import { type ShopifyOrderPaidPayload, upsertOrderFromPaidPayload } from '../fulfillment/order-upsert.ts'
import { applyTransition, canTransition } from '../fulfillment/transitions.ts'
import type { SendOpts } from '../fulfillment/types.ts'

export type { SendOpts }

type Db = ReturnType<typeof createDb>['db']
type SupplierOrderRow = typeof supplierOrders.$inferSelect

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

const SYNC_TRACKING_QUEUE = 'fulfillment.sync-tracking'

// FIXTURE-ASSUMPTION: `webhook_events.payload` for a CJ event is the raw JSON body CJ posted
// (see http/webhooks.ts's `recordAndEnqueue`, which stores `parsePayload(rawBody)` independently
// of `cjAdapter.parseWebhook`'s own re-parse of the same bytes) — i.e. exactly the object
// `CJSupplierAdapter#parseWebhook` calls `body`. Its ORDER/LOGISTICS-specific fields are assumed
// to reuse the same field names CJ's `shopping/order/getOrderDetail` uses (see `CjOrderDetail` in
// packages/supplier/src/adapters/cj/mapping.ts, itself already flagged FIXTURE-ASSUMPTION) since
// no live CJ webhook delivery has been captured to confirm this — verify against the sandbox
// before this router depends on any field not covered here.
interface CjOrderWebhookPayload {
  orderId?: string
  orderStatus?: string
}

interface CjLogisticsWebhookPayload {
  orderId?: string
  trackNumber?: string
  logisticName?: string
}

interface RouteResult {
  action: string
  detail: Record<string, unknown>
}

function ignored(reason: string, detail: Record<string, unknown> = {}): RouteResult {
  return { action: 'webhook.ignored', detail: { reason, ...detail } }
}

/** Scoped to `supplier: 'cj'` so a CJ webhook's `orderId` namespace never collides with another
 * supplier's ids, even though CJ is the only real (non-mock) supplier wired up today. */
async function findCjSupplierOrder(db: Db, supplierOrderId: string): Promise<SupplierOrderRow | undefined> {
  const [row] = await db
    .select()
    .from(supplierOrders)
    .where(and(eq(supplierOrders.supplier, 'cj'), eq(supplierOrders.supplierOrderId, supplierOrderId)))
  return row
}

/**
 * CJ ORDER webhook: a status hint, never the source of truth. Looks up the `supplier_orders` row
 * by CJ's `orderId`; unknown id, a non-actionable status (`mapCjStatus` -> null), or an illegal/
 * backwards transition (`canTransition` -> false) all resolve to `webhook.ignored` with no throw
 * and no write. Only a legal forward move actually calls `applyTransition`.
 */
async function routeCjOrder(db: Db, payload: unknown): Promise<RouteResult> {
  const body = payload as CjOrderWebhookPayload
  if (!body.orderId) {
    return ignored('missing_order_id')
  }

  const row = await findCjSupplierOrder(db, body.orderId)
  if (!row) {
    return ignored('unknown_supplier_order', { supplierOrderId: body.orderId })
  }

  const mapped = mapCjStatus(mapCjOrderStatus(body.orderStatus ?? ''))
  if (!mapped) {
    return ignored('status_not_actionable', { supplierOrderRowId: row.id, rawStatus: body.orderStatus ?? null })
  }

  if (!canTransition(row.status, mapped)) {
    return ignored('illegal_transition', { supplierOrderRowId: row.id, from: row.status, to: mapped })
  }

  await applyTransition(db, row.id, row.status, mapped)
  return { action: 'webhook.processed', detail: { supplierOrderRowId: row.id, from: row.status, to: mapped } }
}

/**
 * CJ LOGISTICS webhook: persists `trackingNumber`/`logisticName` as a direct field update — this
 * is carrier metadata, not a `supplier_orders.status` change, so it never goes through
 * `applyTransition`. On a known order it then enqueues `fulfillment.sync-tracking` (Task 13) to
 * push the tracking number on to Shopify, singleton-keyed on the row id (same key the place/pay
 * queues use for their own per-row dedupe) with the standard fulfillment retry opts. An unknown
 * `orderId` is ignored, same as the ORDER branch.
 */
async function routeCjLogistics(deps: WebhookProcessDeps, payload: unknown): Promise<RouteResult> {
  const body = payload as CjLogisticsWebhookPayload
  if (!body.orderId) {
    return ignored('missing_order_id')
  }

  const row = await findCjSupplierOrder(deps.db, body.orderId)
  if (!row) {
    return ignored('unknown_supplier_order', { supplierOrderId: body.orderId })
  }

  const patch: Partial<Pick<SupplierOrderRow, 'trackingNumber' | 'logisticName'>> = {
    ...(body.trackNumber !== undefined ? { trackingNumber: body.trackNumber } : {}),
    ...(body.logisticName !== undefined ? { logisticName: body.logisticName } : {}),
  }
  if (Object.keys(patch).length > 0) {
    await deps.db.update(supplierOrders).set(patch).where(eq(supplierOrders.id, row.id))
  }

  await deps.enqueue(
    SYNC_TRACKING_QUEUE,
    { supplierOrderRowId: row.id },
    { singletonKey: row.id, ...FULFILLMENT_RETRY_OPTS },
  )
  return { action: 'webhook.processed', detail: { supplierOrderRowId: row.id } }
}

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
  let routeDetail: Record<string, unknown> = {}

  if (source === 'shopify' && event.topic === 'orders/paid') {
    const upserted = await upsertOrderFromPaidPayload(deps.db, event.payload as ShopifyOrderPaidPayload)
    orderGid = upserted.orderGid
    await deps.enqueue('fulfillment.place-order', { orderGid }, { singletonKey: orderGid, ...FULFILLMENT_RETRY_OPTS })
    action = 'webhook.processed'
  } else if (source === 'cj' && event.topic === 'order') {
    const result = await routeCjOrder(deps.db, event.payload)
    action = result.action
    routeDetail = result.detail
  } else if (source === 'cj' && event.topic === 'logistics') {
    const result = await routeCjLogistics(deps, event.payload)
    action = result.action
    routeDetail = result.detail
  }
  // Every other (source, topic) pair — including CJ's stock/product/other topics — is stubbed:
  // mark processed and audit as ignored.

  await deps.db.update(webhookEvents).set({ processedAt: new Date() }).where(eq(webhookEvents.id, webhookEventId))

  await deps.db.insert(auditLog).values({
    actor: 'system',
    action,
    entityType: 'webhook_event',
    entityId: webhookEventId,
    detail: { source, topic: event.topic ?? null, ...(orderGid ? { orderGid } : {}), ...routeDetail },
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
