import { auditLog, type createDb, orders, supplierOrders, webhookEvents } from '@doge-buddy/db'
import type { SupplierAdapter } from '@doge-buddy/supplier'
import { and, eq, inArray, isNotNull, isNull, lt, notInArray } from 'drizzle-orm'
import type { createAlerter } from '../alerts.ts'
import type { createSettings } from '../settings.ts'
import { mapCjStatus } from './cj-status-map.ts'
import { FULFILLMENT_RETRY_OPTS } from './run-place-order.ts'
import type { ShopifyFulfillmentOps } from './run-sync-tracking.ts'
import { applyTransition, canTransition, type SupplierOrderStatusDb } from './transitions.ts'
import type { SendOpts } from './types.ts'

type Db = ReturnType<typeof createDb>['db']

export interface ReconcileDeps {
  db: Db
  adapter: SupplierAdapter
  settings: ReturnType<typeof createSettings>
  alert: ReturnType<typeof createAlerter>
  enqueue: (name: string, data: object, opts?: SendOpts) => Promise<void>
  shopifyOps: ShopifyFulfillmentOps
  /** Injected clock — every sweep's "now" comes from here, never `new Date()` directly, so tests
   *  can control which rows land on each side of a sweep's staleness cutoff. */
  now: () => Date
}

export interface ReconcileCounts {
  orphaned: number
  strandedWebhooks: number
  driftFixed: number
  overdue: number
}

// Each sweep function below is exported individually, in addition to the combined
// `executeReconcile` — sweeps 2-4 run deliberately unscoped queries (a real reconcile sweep has
// to see the whole table, not just rows a test created), so tests exercise one sweep at a time
// through its own function rather than through `executeReconcile`, which would let another
// sweep's unrelated side effects (e.g. a stray stale row) land in the same assertion. Production
// code only ever calls `executeReconcile`.

const PLACE_ORDER_QUEUE = 'fulfillment.place-order'
const SYNC_TRACKING_QUEUE = 'fulfillment.sync-tracking'

const SWEEP1_LOOKBACK_MS = 2 * 60 * 60 * 1000 // 2h
const SWEEP2_STALE_MS = 15 * 60 * 1000 // 15min
const SWEEP2_CAP = 100
const SWEEP3_STALE_MS = 10 * 60 * 1000 // 10min

/** `supplier_orders.status` values sweep 3 polls the supplier for (already placed, not yet shipped/terminal). */
const DRIFT_STATUSES: SupplierOrderStatusDb[] = ['created', 'confirmed', 'paid', 'shipped']

/** `supplier_orders.status` values sweep 4 treats as "already shipped or otherwise done" — never overdue. */
const OVERDUE_EXCLUDED_STATUSES: SupplierOrderStatusDb[] = [
  'shipped',
  'delivered',
  'cancelled',
  'failed',
  'needs_attention',
]

/**
 * Sweep 1 — orphaned orders: Shopify says an order is paid; we have no `supplier_orders` row for
 * it at all. This is the "webhook never arrived, or arrived and got lost before place-order could
 * run" case — the system-of-record check that makes webhooks hints rather than the source of
 * truth. Two sub-cases:
 *   - An `orders` row already exists (e.g. the `orders/paid` webhook landed and upserted it, but
 *     something after that — the place-order enqueue, or the job itself — never completed): just
 *     enqueue place-order: the row has everything place-order needs.
 *   - No `orders` row at all (the webhook never landed, ever): create a minimal row from what
 *     `ordersUpdatedSince` gives us (no raw_payload, so no line items, no shipping address) and
 *     alert `reconcile_thin_order` so an operator knows this order was recovered from a poll, not
 *     a webhook. Place-order will still run against it, hit the missing-shipping-address guard,
 *     and correctly park it `needs_attention` — never silently proceed on incomplete data.
 * A row that already has a `supplier_orders` row (any status) is "already handled" and skipped —
 * this sweep only ever creates the *first* supplier_orders row for an order, same as place-order's
 * own `loadOrCreateSupplierOrder`.
 */
export async function sweepOrphanedOrders(deps: ReconcileDeps): Promise<number> {
  const sinceIso = new Date(deps.now().getTime() - SWEEP1_LOOKBACK_MS).toISOString()
  const items = await deps.shopifyOps.ordersUpdatedSince(sinceIso)

  let orphaned = 0

  for (const item of items) {
    if (item.test || item.displayFinancialStatus !== 'PAID') continue

    const [existingOrder] = await deps.db.select().from(orders).where(eq(orders.shopifyOrderGid, item.id))

    if (existingOrder) {
      const [existingSupplierOrder] = await deps.db
        .select({ id: supplierOrders.id })
        .from(supplierOrders)
        .where(eq(supplierOrders.orderId, existingOrder.id))
      if (existingSupplierOrder) continue // already handled — a supplier_orders row exists

      await deps.enqueue(
        PLACE_ORDER_QUEUE,
        { orderGid: item.id },
        { singletonKey: item.id, ...FULFILLMENT_RETRY_OPTS },
      )
      orphaned += 1
      continue
    }

    // No `orders` row at all. `onConflictDoNothing` covers the race against a webhook (or a
    // concurrent reconcile run) creating the same row between our SELECT above and this INSERT —
    // on conflict we skip this item for this run rather than fight over ownership; whoever won
    // already owns enqueueing place-order for it.
    const [inserted] = await deps.db
      .insert(orders)
      .values({
        shopifyOrderGid: item.id,
        shopifyOrderNumber: item.name,
        email: item.email ?? null,
        isTest: false,
        paidAt: null,
        shippingAddress: null,
      })
      .onConflictDoNothing({ target: orders.shopifyOrderGid })
      .returning({ id: orders.id })
    if (!inserted) continue

    await deps.alert('warning', 'reconcile_thin_order', {
      orderId: inserted.id,
      orderGid: item.id,
      shopifyOrderNumber: item.name,
    })
    await deps.enqueue(PLACE_ORDER_QUEUE, { orderGid: item.id }, { singletonKey: item.id, ...FULFILLMENT_RETRY_OPTS })
    orphaned += 1
  }

  return orphaned
}

/**
 * Sweep 2 — stranded webhooks: any `webhook_events` row that's sat unprocessed for more than 15
 * minutes almost certainly means its `webhook.<source>.process` job was lost (crash between
 * insert and enqueue, a dropped pg-boss job, etc. — the row itself is proof the webhook *arrived*,
 * just that processing never finished). Re-enqueues the same job the original ingestion path
 * would have sent, with no special opts — identical shape to `http/webhooks.ts`'s own
 * `recordAndEnqueue`, since this is just re-doing that same enqueue, not a new kind of send.
 *
 * Capped at 100 rows per run so one bad backlog can't make a single reconcile run unboundedly
 * slow; if there's more than that waiting, an `info` alert says so (never a silent truncation) —
 * the next hourly run picks up wherever this one left off.
 */
export async function sweepStrandedWebhooks(deps: ReconcileDeps): Promise<number> {
  const cutoff = new Date(deps.now().getTime() - SWEEP2_STALE_MS)
  const rows = await deps.db
    .select()
    .from(webhookEvents)
    .where(and(isNull(webhookEvents.processedAt), lt(webhookEvents.receivedAt, cutoff)))
    .limit(SWEEP2_CAP + 1)

  const capped = rows.length > SWEEP2_CAP
  const toProcess = capped ? rows.slice(0, SWEEP2_CAP) : rows

  if (capped) {
    await deps.alert('info', 'reconcile_stranded_webhooks_capped', { cap: SWEEP2_CAP })
  }

  for (const row of toProcess) {
    const queueName = row.source === 'shopify' ? 'webhook.shopify.process' : 'webhook.cj.process'
    await deps.enqueue(queueName, { webhookEventId: row.id })
    await deps.db.insert(auditLog).values({
      actor: 'system',
      action: 'fulfillment.reconcile_stranded_webhook',
      entityType: 'webhook_event',
      entityId: row.id,
      detail: { source: row.source, topic: row.topic ?? null },
    })
  }

  return toProcess.length
}

/**
 * Sweep 3 — status/tracking drift: rows sitting in an active (non-terminal) status for more than
 * 10 minutes are polled directly against the supplier, rather than waiting on a webhook that may
 * never arrive (or already did and got missed). Two independent checks per row:
 *   - `getOrderStatus` -> `mapCjStatus` -> only applied via `applyTransition` when it's both
 *     actionable (non-null) and a legal forward move from the row's current status — an
 *     unmappable/backwards/no-op result is silently ignored, exactly like the CJ ORDER webhook
 *     router (`webhook-process.ts`'s `routeCjOrder`) treats the same inputs.
 *   - `getTracking` -> a new/changed tracking number is persisted and `fulfillment.sync-tracking`
 *     is enqueued with the identical shape `webhook-process.ts`'s `routeCjLogistics` uses
 *     (singletonKey = row id, standard fulfillment retry opts) — this is the poll-driven
 *     equivalent of a CJ LOGISTICS webhook, not a new kind of send.
 * `driftFixed` counts rows where at least one of the two actually changed something (status
 * transition applied and/or tracking persisted) — not the number of individual writes.
 */
export async function sweepStatusDrift(deps: ReconcileDeps): Promise<number> {
  const cutoff = new Date(deps.now().getTime() - SWEEP3_STALE_MS)
  const rows = await deps.db
    .select()
    .from(supplierOrders)
    .where(and(inArray(supplierOrders.status, DRIFT_STATUSES), lt(supplierOrders.updatedAt, cutoff)))

  let driftFixed = 0

  for (const row of rows) {
    if (!row.supplierOrderId) continue // never actually placed with the supplier — nothing to poll
    let fixed = false

    const orderStatus = await deps.adapter.getOrderStatus(row.supplierOrderId)
    const mapped = mapCjStatus(orderStatus.value)
    if (mapped && canTransition(row.status, mapped)) {
      await applyTransition(deps.db, row.id, row.status, mapped)
      fixed = true
    }

    const tracking = await deps.adapter.getTracking(row.supplierOrderId)
    if (tracking && tracking.trackingNumber !== row.trackingNumber) {
      await deps.db
        .update(supplierOrders)
        .set({
          trackingNumber: tracking.trackingNumber,
          ...(tracking.carrier !== undefined ? { logisticName: tracking.carrier } : {}),
        })
        .where(eq(supplierOrders.id, row.id))
      await deps.enqueue(
        SYNC_TRACKING_QUEUE,
        { supplierOrderRowId: row.id },
        { singletonKey: row.id, ...FULFILLMENT_RETRY_OPTS },
      )
      fixed = true
    }

    if (fixed) driftFixed += 1
  }

  return driftFixed
}

/**
 * Sweep 4 — overdue orders: any row not already shipped/delivered/cancelled/failed/parked whose
 * *order* was paid more than `fulfillment.promised_max_days` days ago is past the window we
 * promised the customer and needs a human, not another silent retry. `canTransition` is checked
 * before every `applyTransition` call — every candidate status in practice can legally reach
 * `needs_attention` today (see `transitions.ts`'s matrix), but this sweep never assumes that will
 * stay true, exactly like sweeps 1 and 3 never assume a transition is legal without checking.
 */
export async function sweepOverdue(deps: ReconcileDeps): Promise<number> {
  const promisedMaxDays = await deps.settings.get('fulfillment.promised_max_days')
  const cutoff = new Date(deps.now().getTime() - promisedMaxDays * 24 * 60 * 60 * 1000)

  const rows = await deps.db
    .select({ supplierOrder: supplierOrders, order: orders })
    .from(supplierOrders)
    .innerJoin(orders, eq(supplierOrders.orderId, orders.id))
    .where(
      and(
        notInArray(supplierOrders.status, OVERDUE_EXCLUDED_STATUSES),
        isNotNull(orders.paidAt),
        lt(orders.paidAt, cutoff),
      ),
    )

  let overdue = 0

  for (const { supplierOrder, order } of rows) {
    if (!canTransition(supplierOrder.status, 'needs_attention')) continue

    const paidAtIso = order.paidAt!.toISOString()
    await applyTransition(deps.db, supplierOrder.id, supplierOrder.status, 'needs_attention', {
      lastError: `overdue: paid ${paidAtIso}, exceeds ${promisedMaxDays}-day promise`,
    })
    await deps.alert('warning', 'order_overdue', {
      orderId: order.id,
      orderGid: order.shopifyOrderGid,
      supplierOrderRowId: supplierOrder.id,
      paidAt: paidAtIso,
      promisedMaxDays,
    })
    overdue += 1
  }

  return overdue
}

/**
 * Hourly reconciliation: the system-of-record sweep that treats every webhook as a hint and polls
 * the actual state of the world (Shopify + the supplier) as truth. Runs all four sweeps in order,
 * unconditionally — a failure in one sweep (e.g. `ordersUpdatedSince` throwing because Shopify
 * isn't configured) fails the whole job, which is fine: this is a cron job, not a one-shot, so the
 * next hourly run starts fresh rather than needing per-sweep resume logic.
 */
export async function executeReconcile(deps: ReconcileDeps): Promise<ReconcileCounts> {
  const orphaned = await sweepOrphanedOrders(deps)
  const strandedWebhooks = await sweepStrandedWebhooks(deps)
  const driftFixed = await sweepStatusDrift(deps)
  const overdue = await sweepOverdue(deps)

  return { orphaned, strandedWebhooks, driftFixed, overdue }
}
