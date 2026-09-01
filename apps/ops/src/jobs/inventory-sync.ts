import { auditLog, type createDb, products, productVariants, supplierVariantMappings } from '@doge-buddy/db'
import type { SupplierAdapter, WarehouseStock } from '@doge-buddy/supplier'
import { and, asc, eq, isNotNull, isNull, ne, or, type SQL, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import { PointsAllowance, PointsAllowanceExceededError } from '../agents/points.ts'
import type { SendOpts } from '../fulfillment/types.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

/**
 * `inventory.sync` — the queue that pushes CJ's per-variant US stock into Shopify's inventory
 * levels for one local product.
 *
 * The listing worker (`apply-new-listing.ts`) is the queue's first producer: a listing is born
 * inventory-tracked with whatever stock CJ reported at apply time, and that snapshot starts going
 * stale immediately. The cron (`inventory.sync-cron`, every 6h — see `index.ts`) is the other
 * producer's counterpart: it re-reads the whole active catalog on a schedule.
 */
export const INVENTORY_SYNC_QUEUE = 'inventory.sync'

/**
 * Send options for every `inventory.sync` job.
 *
 * `singletonKey` is the local product id: two syncs for the same product would race to write the
 * same inventory levels, and the later one is always the one worth keeping — collapsing them is
 * both cheaper and more correct. The retry triplet (3 attempts, 30s, backing off) matches the rest
 * of the CJ-facing jobs: a stock read that fails is nearly always a transient supplier hiccup.
 * `expireInSeconds: 600` bounds a job that somehow wedges mid-run.
 */
export const inventorySyncSendOpts = (key: string): SendOpts => ({
  singletonKey: key,
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 600,
})

/**
 * Variants one cycle will read CJ stock for (spec §4). A courtesy bound on CJ's 1-request-per-
 * second bucket, not a correctness bound: anything past the cap simply waits for the next 6-hourly
 * cycle (and is reported by the `inventory_sync_cap_exceeded` alert so the backlog is visible).
 */
export const INVENTORY_SYNC_MAX_VARIANTS_PER_CYCLE = 200

/**
 * Fraction of a cycle's ATTEMPTED variants that may fail before the cycle alerts once as degraded.
 * The comparison is strictly greater-than: exactly one failure in four is the noise floor of a
 * supplier that occasionally 500s, not a signal worth paging on; two in four is.
 */
export const INVENTORY_SYNC_DEGRADED_RATIO = 0.25

/** CJ points charged per `getVariantStock` call — the cost `CJSupplierAdapter` itself declares for
 * `/product/stock/queryByVid`, and the same number `agents/mcp-tools.ts` charges its `get_stock`
 * tool. */
export const STOCK_READ_POINTS = 10

/**
 * Per-cycle ceiling on CJ points, mirroring the sourcing agent's run-scoped allowance
 * (`agents/points.ts`). Sized to exactly the variant cap's worth of stock reads, so the two bounds
 * bite together rather than one silently masking the other; it exists so a runaway cycle (an
 * unexpectedly huge catalog, a retry storm) can never eat the shared daily CJ points budget
 * fulfillment also draws on.
 */
export const INVENTORY_SYNC_POINTS_ALLOWANCE = INVENTORY_SYNC_MAX_VARIANTS_PER_CYCLE * STOCK_READ_POINTS

/** The two Shopify ops a sync cycle needs. `null` (not a throwing stub) when Shopify isn't
 * configured — see `executeInventorySync`'s own handling: a dev boot without creds must no-op
 * loudly-once, not fail every variant. */
export interface InventorySyncShopifyOps {
  inventorySetQuantities(input: Record<string, unknown>, idempotencyKey: string): Promise<void>
  primaryLocationId(): Promise<string>
}

/** The `PointsAllowance` surface a cycle actually uses — a structural type so a test can inject a
 * tiny allowance (or a stand-in) without constructing the real class. */
export type PointsBudget = Pick<PointsAllowance, 'spend' | 'spent' | 'remaining'>

export interface InventorySyncDeps {
  db: Db
  adapter: Pick<SupplierAdapter, 'getVariantStock'>
  shopify: InventorySyncShopifyOps | null
  alert: Alert
  now?: () => Date
  /**
   * Optional per-cycle CJ points budget. OMITTED BY PRODUCTION WIRING ON PURPOSE: a
   * `PointsAllowance` accumulates for the life of the instance, so a single one shared by every
   * cycle would permanently trip after ~one cycle's worth of reads and silently no-op the sync
   * forever (the exact bug the sourcing pipeline's `trendsFactory` had to be fixed for). Left
   * unset, each cycle constructs its own fresh allowance below.
   */
  points?: PointsBudget
  /** Variants read per cycle. Defaults to `INVENTORY_SYNC_MAX_VARIANTS_PER_CYCLE`; injectable so a
   * test can prove the rotation the ordering below promises without seeding 201 rows. */
  maxVariantsPerCycle?: number
}

/** One cycle's scope: a single local product (the post-listing job) or the whole active catalog
 * (the 6-hourly cron). */
export interface InventorySyncScope {
  productId?: string
}

export interface InventorySyncResult {
  updated: number
  unchanged: number
  failed: number
  skipped: number
}

/**
 * The sellable quantity for one supplier variant: the LARGEST SINGLE US warehouse, floored at 0.
 *
 * Not the sum, and this is the whole subtlety. `fulfillment/plan.ts`'s Gate 4 refuses an order
 * unless ONE US warehouse entry covers the entire needed quantity
 * (`usEntries.some((entry) => entry.quantity >= needed)`) — CJ ships an order from a single
 * warehouse, not by splitting it. Advertising 4 + 3 = 7 units across two warehouses would
 * therefore promise stock that the fulfillment pipeline will later refuse to ship: an oversell
 * that surfaces as a `stockout` needs-attention *after* the customer has paid.
 *
 * US-only for a separate reason: a listing's own `ships_from`/delivery metafields promise a
 * US-warehouse dispatch, so CN stock is not stock we can sell against without breaking that
 * promise.
 *
 * Lives here rather than in the listing worker (which is where it was born, and which now imports
 * it from here): the number this job pushes on every later pass has to mean exactly the same thing
 * as the number the listing was born with, and the sync is the one that keeps saying it.
 */
export function usQuantity(stock: WarehouseStock[]): number {
  const us = stock.filter((w) => w.countryCode === 'US').map((w) => w.quantity)
  return us.length === 0 ? 0 : Math.max(0, ...us)
}

/**
 * The idempotency key for one push: `inv-<variantRowId>-<quantity>-<unix seconds>`.
 *
 * The QUANTITY is in the key on purpose, and it is the whole point (spec §4, amended 2026-08-31).
 * An hour-bucketed key (`inv-<variantId>-<yyyymmddHH>`, the first cut) is actively dangerous:
 * cycle A pushes 4 at :05 and cycle B pushes 2 at :40 under the SAME key, so Shopify replays A's
 * result — the store stays at 4 — while this job writes `last_known_stock = 2` and every later
 * cycle then sees "unchanged" and never corrects it. That failure is in the oversell direction and
 * is self-perpetuating. Keying on the quantity (plus the second) means a real change can never
 * replay; only an identical push repeated inside the same second dedupes, which is exactly the
 * retry case a key is for.
 *
 * Length: `inv-` (4) + uuid (36) + separators (2) + quantity + 10-digit epoch — ~58 worst case,
 * inside Shopify's 64-char `[A-Za-z0-9_-]` limit.
 */
function idempotencyKey(variantId: string, quantity: number, at: Date): string {
  return `inv-${variantId}-${quantity}-${Math.floor(at.getTime() / 1000)}`
}

/**
 * Records one variant's caught failure — same shape as `cj-wallet-monitor.ts`'s `auditRowFailure`:
 * a durable `audit_log` row plus the loop that caught it moving on to the next variant instead of
 * aborting the cycle. Deliberately NOT an alert: a per-variant CJ hiccup is noise, and the
 * cycle-level `inventory_sync_degraded` alert below is what turns a *pattern* of them into a page.
 */
async function auditVariantFailure(db: Db, variantId: string, err: unknown): Promise<void> {
  await db.insert(auditLog).values({
    actor: 'system',
    action: 'inventory_sync.variant_failed',
    entityType: 'product_variant',
    entityId: variantId,
    detail: { message: err instanceof Error ? err.message : String(err) },
  })
}

/**
 * One `inventory.sync` cycle (spec §4): make Shopify's tracked inventory equal CJ's US stock for
 * every variant in scope.
 *
 * **Selection.** Every `product_variants` row whose product is ACTIVE, that has a
 * `supplier_variant_mappings` row, and whose `shopify_inventory_item_gid` is non-null — the gid is
 * how Shopify addresses a variant's stock, so a null one simply cannot be synced (the
 * `backfill-listings` script is what fixes those). Variants failing any of those three tests are
 * counted `skipped`, not silently dropped: "how many variants can this job NOT keep honest" is the
 * number that tells an operator to run the backfill. The eligible set is inherently small (one row
 * per listed, inventory-tracked variant), so it's read whole and sliced in memory — the
 * `INVENTORY_SYNC_MAX_VARIANTS_PER_CYCLE` bound exists to cap CJ calls per cycle, not memory. It is
 * ordered LEAST-RECENTLY-CHECKED FIRST so that bound rotates: a variant deferred by the cap has the
 * oldest `stock_checked_at` next cycle and is served first, so no tail can starve.
 *
 * **Per variant.** Read CJ stock, take `usQuantity`, and compare with `last_known_stock`:
 * unchanged means NO Shopify call at all (the common case by far — most variants don't move in six
 * hours) but still a fresh `stock_checked_at`, so "we looked" and "it changed" stay separable.
 * Changed means one `inventorySetQuantities` setting the `available` quantity at the store's one
 * active location — compare-and-swapped against `last_known_stock` via the optional
 * `changeFromQuantity` whenever there is one to swap against — followed by the local cache write.
 * That ordering is deliberate: a crash between the two re-pushes the same value next cycle
 * (harmless), whereas writing the cache first would record a push that never happened and leave the
 * storefront stale until CJ's number moves again.
 *
 * **Isolation.** Every variant's work is wrapped: a throw is counted `failed`, audit-logged, and
 * the cycle moves on — one flaky supplier read must never cost the other 199 variants their sync.
 * A failed variant's `last_known_stock` is left exactly as it was; "CJ was unreachable" is not an
 * observation that the warehouse is empty. A LOST CAS arrives here as a throw too (the op turns
 * `userErrors` into one) and is treated identically — counted `failed`, cache untouched, retried
 * next cycle — and it DOES count toward the degraded ratio below, because a push that did not land
 * is a real miss however it was lost.
 */
export async function executeInventorySync(
  deps: InventorySyncDeps,
  scope: InventorySyncScope,
): Promise<InventorySyncResult> {
  const { db } = deps
  // Read fresh at every use, never once per cycle: a cycle that walks 200 variants can run for
  // minutes, and a `stock_checked_at` stamped with the cycle's START would claim every variant was
  // checked at a moment most of them weren't.
  const clock = (): Date => deps.now?.() ?? new Date()
  const cap = deps.maxVariantsPerCycle ?? INVENTORY_SYNC_MAX_VARIANTS_PER_CYCLE
  const points = deps.points ?? new PointsAllowance(INVENTORY_SYNC_POINTS_ALLOWANCE)
  const scopeFilter: SQL | undefined = scope.productId ? eq(productVariants.productId, scope.productId) : undefined

  const selected = await db
    .select({
      variantId: productVariants.id,
      inventoryItemGid: productVariants.shopifyInventoryItemGid,
      mappingId: supplierVariantMappings.id,
      supplierVariantId: supplierVariantMappings.supplierVariantId,
      lastKnownStock: supplierVariantMappings.lastKnownStock,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(supplierVariantMappings, eq(supplierVariantMappings.variantId, productVariants.id))
    .where(and(eq(products.status, 'active'), isNotNull(productVariants.shopifyInventoryItemGid), scopeFilter))
    // LEAST-RECENTLY-CHECKED FIRST (never-checked first of all), with the variant's own
    // created_at/id as a stable tiebreak. Ordering by created_at alone — the first cut — is stable
    // but does NOT rotate: with more eligible variants than the cap, the same first N are picked
    // every cycle and the tail is never synced at all while the cap alert fires forever. Sorting on
    // the column this job itself advances on every pass makes the cap a round-robin: whatever got
    // skipped this cycle has the oldest `stock_checked_at` next cycle and goes first.
    .orderBy(sql`${supplierVariantMappings.stockCheckedAt} asc nulls first`, asc(productVariants.createdAt), asc(productVariants.id))

  // A variant could in principle carry mappings for two suppliers (the unique index is on
  // (variant, supplier)), which would yield two rows here for one inventory item — two pushes of
  // two different numbers at the same inventory item, the second of which would also lose the CAS
  // against a cache the first just advanced. Only ever one supplier per variant today; take the
  // first deterministically rather than leaving that to chance.
  const byVariant = new Map<string, (typeof selected)[number]>()
  for (const row of selected) {
    if (!byVariant.has(row.variantId)) byVariant.set(row.variantId, row)
  }
  const eligible = [...byVariant.values()]

  // Everything in scope the cycle cannot sync: product not active, no mapping, or no inventory-item
  // gid. Counted in SQL (one aggregate, no rows transferred) — the catalog holds far more of these
  // than of eligible variants.
  const [skippedRow] = await db
    .select({ n: sql<string>`count(distinct ${productVariants.id})` })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(supplierVariantMappings, eq(supplierVariantMappings.variantId, productVariants.id))
    .where(
      and(
        or(
          ne(products.status, 'active'),
          isNull(supplierVariantMappings.id),
          isNull(productVariants.shopifyInventoryItemGid),
        ),
        scopeFilter,
      ),
    )
  let skipped = Number(skippedRow?.n ?? 0)
  let updated = 0
  let unchanged = 0
  let failed = 0

  /** Writes the cycle's audit row (spec §4) and hands back the counts. A whole-catalog cycle
   * belongs to no single entity, so it audits under the sentinel id `'all'` — one queryable row
   * per cycle either way, rather than a null-keyed row nothing can look up. */
  const finish = async (): Promise<InventorySyncResult> => {
    const result = { updated, unchanged, failed, skipped }
    await db.insert(auditLog).values({
      actor: 'system',
      action: 'inventory.synced',
      entityType: scope.productId ? 'product' : 'inventory_sync',
      entityId: scope.productId ?? 'all',
      detail: { ...result, ...(scope.productId ? { productId: scope.productId } : {}) },
    })
    return result
  }

  // Dev boot without Shopify creds. Nothing can be pushed, so nothing is READ either — a cycle
  // that burns CJ points to compute numbers it cannot deliver is pure waste. One info alert (not a
  // warning: on a credential-less dev box this is the expected state, and a warning here would
  // train operators to ignore the kind).
  const shopify = deps.shopify
  if (!shopify) {
    skipped += eligible.length
    await deps
      .alert('info', 'inventory_sync_no_shopify', { skipped, ...(scope.productId ? { productId: scope.productId } : {}) })
      .catch(() => {})
    return finish()
  }

  const batch = eligible.slice(0, cap)
  if (eligible.length > batch.length) {
    // Deferred, not dropped: the ordering above guarantees these go first next cycle.
    const deferred = eligible.length - batch.length
    skipped += deferred
    await deps.alert('warning', 'inventory_sync_cap_exceeded', { cap, eligible: eligible.length, deferred }).catch(() => {})
  }

  /**
   * The store's one active location, resolved at most once per cycle and only when a variant
   * actually needs a push (a cycle where nothing moved must not pay for — or fail on — a lookup it
   * has no use for). Caches the resolved VALUE only, never a failed attempt: a location lookup
   * that fails is charged to that one variant and retried by the next, exactly like the listing
   * worker's own memo.
   */
  let locationId: string | null = null
  const getLocationId = async (): Promise<string> => (locationId ??= await shopify.primaryLocationId())

  for (const [index, row] of batch.entries()) {
    // Points first, and BEFORE the read it pays for — a spend that would cross the cap is rejected
    // without consuming any of the allowance, so the cycle stops on the boundary rather than
    // overshooting it.
    try {
      points.spend(STOCK_READ_POINTS, 'inventory.sync getVariantStock')
    } catch (err) {
      if (!(err instanceof PointsAllowanceExceededError)) throw err
      const remaining = batch.length - index
      skipped += remaining
      await deps
        .alert('warning', 'inventory_sync_points_capped', {
          spentPoints: points.spent(),
          synced: updated + unchanged,
          remaining,
        })
        .catch(() => {})
      break
    }

    try {
      const quantity = usQuantity(await deps.adapter.getVariantStock(row.supplierVariantId))
      if (quantity === row.lastKnownStock) {
        // Nothing to push, but the observation is still worth recording: `stock_checked_at` is how
        // an operator tells "CJ says 4" from "nobody has looked since Tuesday".
        await db
          .update(supplierVariantMappings)
          .set({ stockCheckedAt: clock() })
          .where(eq(supplierVariantMappings.id, row.mappingId))
        unchanged += 1
        continue
      }
      await shopify.inventorySetQuantities(
        {
          name: 'available',
          reason: 'correction',
          // LIVE-VERIFIED 2026-08-31 against the 2026-07 Admin API: there is no
          // `ignoreCompareQuantity` field on `InventorySetQuantitiesInput`; the optional per-entry
          // `changeFromQuantity` is its compare-and-swap, and it is SENT whenever this variant has
          // a cached value to swap against (whole-branch review, I1).
          //
          // The two producers of this job — the 6-hourly cron and the on-demand post-listing job —
          // sit on two different queue names by design, so pg-boss's `stately` singleton cannot
          // serialize them against each other. Without the CAS their read -> push -> cache
          // sequences interleave into a plain lost update: A reads 7, B reads 5 and pushes 5, A
          // pushes 7 and caches 7 while CJ says 5 — and every later cycle agrees with the cache and
          // never corrects the oversell. With it, the loser's push is rejected by Shopify (a
          // userError, which the op turns into a throw), the variant is counted `failed`, its cache
          // is left alone, and the next cycle retries from whatever is true then.
          //
          // Omitted when the cache is null: there is nothing to compare against (a brand-new or
          // resume-path listing), and sending nothing makes that push unconditional on purpose.
          quantities: [
            {
              inventoryItemId: row.inventoryItemGid,
              locationId: await getLocationId(),
              quantity,
              ...(row.lastKnownStock === null ? {} : { changeFromQuantity: row.lastKnownStock }),
            },
          ],
        },
        idempotencyKey(row.variantId, quantity, clock()),
      )
      await db
        .update(supplierVariantMappings)
        .set({ lastKnownStock: quantity, stockCheckedAt: clock() })
        .where(eq(supplierVariantMappings.id, row.mappingId))
      updated += 1
    } catch (err) {
      failed += 1
      await auditVariantFailure(db, row.variantId, err).catch(() => {})
    }
  }

  const attempted = updated + unchanged + failed
  if (attempted > 0 && failed / attempted > INVENTORY_SYNC_DEGRADED_RATIO) {
    await deps
      .alert('warning', 'inventory_sync_degraded', {
        failed,
        attempted,
        ratio: INVENTORY_SYNC_DEGRADED_RATIO,
        ...(scope.productId ? { productId: scope.productId } : {}),
      })
      .catch(() => {})
  }

  return finish()
}

/**
 * Only the fields this handler reads off a pg-boss job — the same strict structural subset of
 * `PgBoss.JobWithMetadata<T>` `fulfillment-pay-order.ts` documents, so test fixtures don't have to
 * fake out a dozen metadata fields nothing here looks at.
 */
type InventorySyncJob = Pick<
  PgBoss.JobWithMetadata<InventorySyncScope>,
  'id' | 'name' | 'data' | 'retryCount' | 'retryLimit'
>

/**
 * Worker callback for the `inventory.sync` queue (the on-demand, post-listing producer; the
 * 6-hourly cron calls `executeInventorySync` directly through its own queue — see `index.ts`).
 *
 * A cycle only throws on an infrastructure failure — per-variant supplier/Shopify errors are
 * counted, never thrown — so a throw here is a real "retry this job" signal. The first one is HELD
 * rather than thrown immediately: pg-boss can hand a batch of jobs to one call, and the second
 * product's sync must not lose its run because the first product's happened to fail. It is
 * rethrown once the batch is done so pg-boss still fails (and retries) the job.
 */
export function inventorySyncHandler(deps: InventorySyncDeps) {
  return async (jobs: InventorySyncJob[]): Promise<void> => {
    let firstError: unknown
    let threw = false
    for (const job of jobs) {
      try {
        await executeInventorySync(deps, job.data?.productId ? { productId: job.data.productId } : {})
      } catch (err) {
        if (!threw) {
          threw = true
          firstError = err
        }
      }
    }
    if (threw) throw firstError
  }
}
