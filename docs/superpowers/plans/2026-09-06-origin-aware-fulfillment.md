# Origin-Aware Fulfillment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a CN-warehouse product sellable end to end — synced to Shopify with real stock, planned against its own warehouse and its own promised window, placed with CJ from the right origin, and split into one supplier order per warehouse when a cart mixes origins.

**Architecture:** The origin becomes a stored dimension (`supplier_variant_mappings.warehouse_country`, a column that has existed since migration 0000 and has never been written) and a leg dimension on `supplier_orders`, whose unique index widens from `(order_id, supplier)` to `(order_id, supplier, warehouse_country)`. `run-place-order.ts` becomes leg-scoped: group the order's line items by origin, then run the existing claim → plan → place → confirm cycle once per leg. The planner stays pure and gains two inputs: the leg's `origin` and the `committedCents` its sibling legs already spent.

**Tech Stack:** TypeScript monorepo (pnpm), drizzle-kit migrations against Postgres 17, vitest, pg-boss job queue, CJ supplier adapter, Shopify Admin GraphQL.

**Spec:** `docs/superpowers/specs/2026-09-06-origin-aware-fulfillment-design.md`

> **EXECUTED 2026-09-07** on branch `origin-aware-fulfillment`, all 8 tasks TDD. Suites: core 64/64,
> db 9/9, supplier 124/125 (1 skipped), shopify-admin 79/79, ops 1644/1647 (the 3 known dev-DB
> failures), storefront 97/97, `pnpm -r typecheck` clean. Four deviations from the plan as written,
> each a correction the code demanded:
> 1. **A second migration (0014).** Task 6 planned to re-derive a leg's promised window by joining
>    back through the order's JSON line items. Instead the window is STAMPED on the leg at
>    placement (`supplier_orders.promised_max_days`) — less code, no JSON gymnastics, and it judges
>    the promise we actually made rather than one a later mapping edit could move.
> 2. **The overdue sweep's pre-filter cutoff was inverted in the plan.** Casting the net with the
>    LONGEST window misses rows with shorter promises; it must use the SHORTEST promise on record
>    and judge each row against its own. Caught by the failing test, not by review.
> 3. **`legsToProcess` — a resume guarantee the plan missed.** Legs are the union of what the
>    current line items group into AND any leg that already has a row. Without it an order whose
>    line items are empty or unreadable would leave an already-`created` row unconfirmed forever,
>    with money spent and nothing to pick it up.
> 4. **Tracking falls back to whole-fulfillment-order** when an order has one leg, or when a leg's
>    items cannot be resolved — the pre-split behaviour, strictly better than refusing to send
>    tracking for a parcel that really shipped.

## Global Constraints

- Commands: `pnpm --filter @doge-buddy/<pkg> test`, `pnpm -r typecheck`. The dev Postgres must be up (`pnpm db:up`, port 5433) — DB-backed suites fail with `ECONNREFUSED 127.0.0.1:5433` otherwise.
- **Every status write goes through `applyTransition`** (`fulfillment/transitions.ts`), the sole legal writer. Never assign `.status` directly. This is the most safety-critical path in the app: it spends real money.
- **Money rules (spec R3):** the spend cap and the margin floor are per CUSTOMER order — both add `committedCents` (the order's other legs' committed totals). The wallet check stays per leg, because the balance is re-read before each leg (R4) and already reflects earlier spend.
- **Partial failure places what it can (spec R2):** a leg that cannot proceed parks as `needs_attention`; its siblings still place. One exception, Task 5: an UNMAPPED line item parks the whole order without placing anything — we do not spend money on an order whose contents we cannot fully resolve.
- **Legs are processed US first, then CN** (deterministic), so under a tight wallet or cap the fast leg is the one that gets placed.
- Gates reject, never stretch: a leg with no freight inside its promised window parks. Never ship slower than the window the buyer was shown.
- Money is integer cents; ratio math is integer bps, floored.
- Known-benign local failures (dev-DB state, pre-existing): `admin-dashboard` tests 8 and 13, `scoring-weekly-digest` freshness. Everything else must pass.
- No backfill anywhere: every product listed to date is US and `'US'` is the column default on both tables.

---

### Task 1: Migration 0013 — the origin columns and the widened leg index

**Files:**
- Modify: `packages/db/src/schema.ts` (`supplierVariantMappings` ~line 57, `supplierOrders` ~line 88)
- Create: `packages/db/migrations/0013_*.sql` (generated, do not hand-write)
- Test: `packages/db/test/schema.test.ts`

**Interfaces:**
- Produces: `supplierVariantMappings.deliveryMaxDays: number | null`; `supplierOrders.warehouseCountry: string`; unique index `supplier_orders_order_supplier_origin_uq` on `(order_id, supplier, warehouse_country)`. Tasks 2–7 all read one of these.

- [x] **Step 1: Write the failing test**

In `packages/db/test/schema.test.ts` (follow the file's existing `createDb`/cleanup idiom):

```ts
it('supplier_orders allows two legs of one order and still rejects a duplicate leg', async () => {
  const [order] = await db.insert(orders).values({
    shopifyOrderGid: `gid://shopify/Order/${Date.now()}`, isTest: true,
  }).returning({ id: orders.id })
  const legs = ['US', 'CN'] as const
  for (const origin of legs) {
    await db.insert(supplierOrders).values({
      orderId: order!.id, supplier: 'mock',
      idempotencyKey: `test-${order!.id}-${origin}`, warehouseCountry: origin,
    })
  }
  const rows = await db.select().from(supplierOrders).where(eq(supplierOrders.orderId, order!.id))
  expect(rows).toHaveLength(2)

  // The same (order, supplier, origin) is still exactly one row.
  await expect(
    db.insert(supplierOrders).values({
      orderId: order!.id, supplier: 'mock',
      idempotencyKey: `test-${order!.id}-US-dup`, warehouseCountry: 'US',
    }),
  ).rejects.toThrow()

  await db.delete(supplierOrders).where(eq(supplierOrders.orderId, order!.id))
  await db.delete(orders).where(eq(orders.id, order!.id))
})

it('supplier_variant_mappings carries an origin and the window the buyer was shown', async () => {
  const [product] = await db.insert(products).values({ title: 'origin test', status: 'active' }).returning({ id: products.id })
  const [variant] = await db.insert(productVariants).values({
    productId: product!.id, sku: `sku-${Date.now()}`, priceCents: 1499,
  }).returning({ id: productVariants.id })
  const [mapping] = await db.insert(supplierVariantMappings).values({
    variantId: variant!.id, supplier: 'cj', supplierProductId: 'p1', supplierVariantId: 'v1',
    warehouseCountry: 'CN', deliveryMaxDays: 14,
  }).returning()
  expect(mapping!.warehouseCountry).toBe('CN')
  expect(mapping!.deliveryMaxDays).toBe(14)

  // Default stays US with no window — exactly today's behaviour for every existing row.
  const [legacy] = await db.insert(supplierVariantMappings).values({
    variantId: variant!.id, supplier: 'mock', supplierProductId: 'p2', supplierVariantId: 'v2',
  }).returning()
  expect(legacy!.warehouseCountry).toBe('US')
  expect(legacy!.deliveryMaxDays).toBeNull()

  await db.delete(supplierVariantMappings).where(eq(supplierVariantMappings.variantId, variant!.id))
  await db.delete(productVariants).where(eq(productVariants.id, variant!.id))
  await db.delete(products).where(eq(products.id, product!.id))
})
```

- [x] **Step 2: Run to verify they fail**

Run: `pnpm --filter @doge-buddy/db test`
Expected: FAIL — `deliveryMaxDays`/`warehouseCountry` are not properties of the insert type, and the two-leg insert violates `supplier_orders_order_supplier_uq`.

- [x] **Step 3: Implement**

`schema.ts`, in `supplierVariantMappings` right after `warehouseCountry`:

```ts
  // The delivery window the BUYER was shown for this variant, in days (the payload's
  // deliveryMaxDays, which since the 2026-09-03 pivot is the carrier's real quoted window).
  // Fulfillment gate 5 and the overdue sweep measure against THIS, not a site-wide constant.
  // Nullable: every pre-pivot row has no stored window and falls back to
  // `fulfillment.promised_max_days`.
  deliveryMaxDays: integer('delivery_max_days'),
```

`schema.ts`, in `supplierOrders` right after `supplier`:

```ts
  // Which warehouse this supplier order ships FROM. A customer order whose cart mixes origins
  // becomes one supplier_orders row per origin — see the widened unique index below.
  warehouseCountry: text('warehouse_country').notNull().default('US'),
```

and replace the unique index:

```ts
  uniqueIndex('supplier_orders_order_supplier_origin_uq').on(t.orderId, t.supplier, t.warehouseCountry),
```

Then generate the migration (never hand-write it):

```bash
pnpm --filter @doge-buddy/db generate
DATABASE_URL=postgres://doge:doge@localhost:5433/doge_buddy pnpm --filter @doge-buddy/db migrate
```

Read the generated SQL before continuing: it must ADD both columns, DROP `supplier_orders_order_supplier_uq`, and CREATE the three-column index. If it drops and recreates a table, stop — that is data loss, and the fix is to adjust `schema.ts`, not the SQL.

- [x] **Step 4: Run to verify they pass**

Run: `pnpm --filter @doge-buddy/db test` → PASS. Then `pnpm -r typecheck`.

- [x] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): migration 0013 — origin on supplier_orders (one leg per warehouse) and the buyer's window on mappings"
```

---

### Task 2: Listing time records the origin and the promised window

**Files:**
- Modify: `apps/ops/src/proposals/apply-new-listing.ts` (`readUsStock` ~line 90, the mapping insert ~line 376)
- Test: `apps/ops/test/proposal-apply.test.ts`

**Interfaces:**
- Consumes: `supplierVariantMappings.deliveryMaxDays` (Task 1); `NewListingPayload.shipsFrom` / `.deliveryMaxDays` (already `'US' | 'CN'` and a number since the pivot).
- Produces: mapping rows carrying `warehouseCountry` + `deliveryMaxDays`. Tasks 3–6 read them. `readOriginStock(deps, supplierVariantId, origin)` replaces `readUsStock`.

- [x] **Step 1: Write the failing test**

In `apps/ops/test/proposal-apply.test.ts`, alongside the existing new_listing apply tests (reuse that file's proposal-seeding helper and its `applyProposal` call):

```ts
it('a CN listing records its origin and the window the buyer was shown', async () => {
  const proposalId = await seedNewListingProposal({
    shipsFrom: 'CN', deliveryMinDays: 7, deliveryMaxDays: 14,
  })
  await applyProposal(deps, proposalId)

  const [mapping] = await db
    .select()
    .from(supplierVariantMappings)
    .innerJoin(productVariants, eq(supplierVariantMappings.variantId, productVariants.id))
    .where(eq(productVariants.sku, EXPECTED_SKU))
  expect(mapping!.supplier_variant_mappings.warehouseCountry).toBe('CN')
  expect(mapping!.supplier_variant_mappings.deliveryMaxDays).toBe(14)
})
```

(`seedNewListingProposal` / `EXPECTED_SKU` = whatever that file already uses; pass the three payload fields through its overrides parameter rather than writing a new fixture.)

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run --root apps/ops test/proposal-apply.test.ts`
Expected: FAIL — `warehouseCountry` is `'US'` (the column default) and `deliveryMaxDays` is null.

- [x] **Step 3: Implement**

Rename and re-aim the stock read (the export is used by `catalog/backfill.ts` too — update that call site in the same edit):

```ts
/** Largest single warehouse row for `origin`, floored at 0, or null when the read itself failed.
 *  Origin-aware since the 2026-09-03 pivot: a CN product read for US stock returns 0, which
 *  Shopify would publish as "sold out" and no amount of later syncing would correct. */
export async function readOriginStock(
  deps: StockReadDeps,
  supplierVariantId: string,
  origin: string,
): Promise<number | null> {
  try {
    return originQuantity(await deps.adapter.getVariantStock(supplierVariantId), origin)
  } catch (err) {
    await deps
      .alert('warning', 'listing_stock_read_failed', { supplierVariantId, origin, error: err instanceof Error ? err.message : String(err) })
      .catch(() => {})
    return null
  }
}
```

(`originQuantity` arrives in Task 3. If Task 3 has not landed yet, add it there first — the two tasks share that one function and it belongs in `jobs/inventory-sync.ts`, which owns the "largest single warehouse" rule.)

At the `readOriginStock` call site inside the apply, pass `payload.shipsFrom`. In the mapping insert, add both columns:

```ts
    await db.insert(supplierVariantMappings).values({
      variantId: variantRow!.id, supplier: v.supplier,
      supplierProductId: v.supplierProductId, supplierVariantId: v.supplierVariantId,
      warehouseCountry: payload.shipsFrom,
      deliveryMaxDays: payload.deliveryMaxDays,
      lastKnownStock: observed, stockCheckedAt: observed === null ? null : stockCheckedAt,
    }).onConflictDoUpdate({
      target: [supplierVariantMappings.variantId, supplierVariantMappings.supplier],
      set: {
        // Identity-ish columns are re-asserted on conflict, unlike the first-write-wins ids above:
        // a re-apply of an edited listing must be able to correct an origin or a window.
        warehouseCountry: sql`excluded.warehouse_country`,
        deliveryMaxDays: sql`excluded.delivery_max_days`,
        lastKnownStock: sql`coalesce(excluded.last_known_stock, ${supplierVariantMappings.lastKnownStock})`,
        stockCheckedAt: sql`coalesce(excluded.stock_checked_at, ${supplierVariantMappings.stockCheckedAt})`,
      },
    })
```

- [x] **Step 4: Run to verify it passes**

Run: `npx vitest run --root apps/ops test/proposal-apply.test.ts test/catalog-backfill.test.ts` → PASS. Then `pnpm --filter @doge-buddy/ops typecheck`.

- [x] **Step 5: Commit**

```bash
git add apps/ops/src/proposals/apply-new-listing.ts apps/ops/src/catalog/backfill.ts apps/ops/test
git commit -m "feat(listing): record warehouse_country and the buyer's delivery window on the mapping row"
```

---

### Task 3: Inventory sync reads the product's own warehouse

**Files:**
- Modify: `apps/ops/src/jobs/inventory-sync.ts` (`usQuantity` ~line 131, the sync loop's locked select ~line 379 and its `usQuantity` call ~line 390)
- Test: `apps/ops/test/inventory-sync.test.ts`

**Interfaces:**
- Produces: `originQuantity(stock: WarehouseStock[], origin: string): number`, replacing `usQuantity`. Task 2 imports it.

**Why this task is load-bearing:** without it a CN product syncs to quantity 0, Shopify shows it sold out, no order is ever created, and every other task in this plan is unreachable.

- [x] **Step 1: Write the failing test**

```ts
import { originQuantity } from '../src/jobs/inventory-sync.ts'

describe('originQuantity', () => {
  const stock = [
    { countryCode: 'US', quantity: 3, verified: true },
    { countryCode: 'CN', quantity: 40, verified: true },
  ]
  it('takes the largest single warehouse row for the requested origin', () => {
    expect(originQuantity(stock, 'US')).toBe(3)
    expect(originQuantity(stock, 'CN')).toBe(40)
  })
  it('returns 0 when the origin has no row (never another origin’s number)', () => {
    expect(originQuantity([{ countryCode: 'CN', quantity: 40, verified: true }], 'US')).toBe(0)
  })
  it('floors negative supplier values at 0', () => {
    expect(originQuantity([{ countryCode: 'CN', quantity: -5, verified: true }], 'CN')).toBe(0)
  })
})
```

Plus, in the sync-cycle describe of the same file (reuse its existing seeding helper):

```ts
it('syncs a CN mapping from its CN stock, not from US', async () => {
  const { mappingId, supplierVariantId } = await seedSyncableVariant({ warehouseCountry: 'CN' })
  const getVariantStock = vi.fn(async () => [{ countryCode: 'CN', quantity: 12, verified: true }])
  await runInventorySync(makeDeps({ adapter: { ...baseAdapter, getVariantStock } }))

  const [row] = await db.select().from(supplierVariantMappings).where(eq(supplierVariantMappings.id, mappingId))
  expect(row!.lastKnownStock).toBe(12) // today: 0
  expect(supplierVariantId).toBeDefined()
})
```

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run --root apps/ops test/inventory-sync.test.ts`
Expected: FAIL — `originQuantity` is not exported; the CN cycle test caches 0.

- [x] **Step 3: Implement**

```ts
/** The quantity we are willing to promise Shopify for one variant: the LARGEST SINGLE warehouse
 *  row in the product's OWN origin, floored at 0 — never the sum, because the fulfillment planner
 *  can only draw from one warehouse per order (it matches gate 4's rule exactly).
 *
 *  Origin-aware since the 2026-09-03 pivot. Reading a CN product's US rows returns 0, which
 *  publishes "sold out" to the storefront for a product that is in stock. */
export function originQuantity(stock: WarehouseStock[], origin: string): number {
  const rows = stock.filter((w) => w.countryCode === origin).map((w) => w.quantity)
  return rows.length === 0 ? 0 : Math.max(0, ...rows)
}
```

Delete `usQuantity` and update both call sites (this file's sync loop, and `apply-new-listing.ts` from Task 2). In the sync loop, add `warehouseCountry` to the locked select and pass it:

```ts
        const [locked] = await tx
          .select({
            lastKnownStock: supplierVariantMappings.lastKnownStock,
            warehouseCountry: supplierVariantMappings.warehouseCountry,
          })
          .from(supplierVariantMappings)
          .where(eq(supplierVariantMappings.id, row.mappingId))
          .limit(1)
          .for('update')
        if (!locked) return 'gone' as const

        const quantity = originQuantity(await deps.adapter.getVariantStock(row.supplierVariantId), locked.warehouseCountry)
```

- [x] **Step 4: Run to verify they pass**

Run: `npx vitest run --root apps/ops test/inventory-sync.test.ts test/proposal-apply.test.ts` → PASS. Then `pnpm --filter @doge-buddy/ops typecheck`.

- [x] **Step 5: Commit**

```bash
git add apps/ops/src/jobs/inventory-sync.ts apps/ops/src/proposals/apply-new-listing.ts apps/ops/test
git commit -m "feat(inventory): sync each variant from its own warehouse (originQuantity replaces usQuantity)"
```

---

### Task 4: The planner gates on the leg's origin, its window, and the order's committed spend

**Files:**
- Modify: `apps/ops/src/fulfillment/plan.ts` (`FulfillmentInputs` ~line 8, `NeedsAttentionReason` ~line 29, gate 4 ~line 102, gate 5 ~line 131, gate 6 ~line 148)
- Test: `apps/ops/test/fulfillment-plan.test.ts`

**Interfaces:**
- Produces: `FulfillmentInputs.origin: string`, `FulfillmentInputs.committedCents: number`; `NeedsAttentionReason` gains `'no_origin_stock'` and loses `'no_us_stock'`. `settings.promisedMaxDays` keeps its name but now carries the LEG's window. Task 5 supplies all three.

- [x] **Step 1: Write the failing tests**

```ts
it('gate 4 checks stock in the leg’s own origin, both directions', () => {
  const cn = planFulfillment(inputsFor({
    origin: 'CN',
    stock: new Map([['sv-1', [{ countryCode: 'US', quantity: 10, verified: true }]]]),
  }))
  expect(cn).toMatchObject({ kind: 'needs_attention', reason: 'no_origin_stock' })

  const us = planFulfillment(inputsFor({
    origin: 'US',
    stock: new Map([['sv-1', [{ countryCode: 'CN', quantity: 10, verified: true }]]]),
  }))
  expect(us).toMatchObject({ kind: 'needs_attention', reason: 'no_origin_stock' })

  const ok = planFulfillment(inputsFor({
    origin: 'CN',
    stock: new Map([['sv-1', [{ countryCode: 'CN', quantity: 10, verified: true }]]]),
  }))
  expect(ok.kind).toBe('proceed')
})

it('gate 5 honours the leg’s own 14-day window where the global setting says 7', () => {
  const decision = planFulfillment(inputsFor({
    origin: 'CN',
    stock: new Map([['sv-1', [{ countryCode: 'CN', quantity: 10, verified: true }]]]),
    settings: { promisedMaxDays: 14 },
    freightOptions: [{ name: 'CJPacket', priceCents: 494, minDays: 7, maxDays: 14 }],
  }))
  expect(decision).toMatchObject({ kind: 'proceed', logisticName: 'CJPacket' })
})

it('gate 5 still rejects freight slower than the leg’s own window', () => {
  const decision = planFulfillment(inputsFor({
    origin: 'CN',
    stock: new Map([['sv-1', [{ countryCode: 'CN', quantity: 10, verified: true }]]]),
    settings: { promisedMaxDays: 14 },
    freightOptions: [{ name: 'Slow Boat', priceCents: 100, minDays: 20, maxDays: 35 }],
  }))
  expect(decision).toMatchObject({ kind: 'needs_attention', reason: 'no_freight_in_window' })
})

it('the spend cap counts the whole order: a second leg cannot spend the cap again', () => {
  // cap 7500; this leg projects 5000; a sibling leg already committed 5000.
  const decision = planFulfillment(inputsFor({ committedCents: 5000, settings: { spendCapPerOrderCents: 7500 } }))
  expect(decision).toMatchObject({ kind: 'needs_attention', reason: 'cap_exceeded' })
})

it('the margin floor counts the whole order: two legs that jointly lose money are rejected', () => {
  // order revenue 10000c, floor 6000bps. This leg costs 3000c and a sibling already committed
  // 4000c -> real margin 3000bps. Per-leg math would have seen 7000bps and passed.
  const decision = planFulfillment(inputsFor({
    committedCents: 4000,
    order: { totalCents: 10_000 },
    settings: { marginFloorBps: 6000 },
  }))
  expect(decision).toMatchObject({ kind: 'needs_attention', reason: 'margin_below_floor' })
})

it('the wallet check does NOT add committedCents (the balance is re-read per leg)', () => {
  const decision = planFulfillment(inputsFor({ committedCents: 5000, walletAvailableCents: 6000 }))
  expect(decision.kind).toBe('proceed')
})
```

(`inputsFor(overrides)` = a small local builder over that file's existing valid-inputs fixture, deep-merging `order`/`settings`. If the file has no such builder, write one at the top of the describe from its current inline fixture — the neighbouring tests keep passing unchanged.)

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run --root apps/ops test/fulfillment-plan.test.ts`
Expected: FAIL — `origin`/`committedCents` are not inputs, and `no_origin_stock` is not a reason.

- [x] **Step 3: Implement**

`FulfillmentInputs`:

```ts
  /** The warehouse THIS leg ships from ('US' | 'CN'). Gate 4 checks stock here and nowhere else;
   *  the caller quotes freight from the same origin. */
  origin: string
  /** Cents this customer order's OTHER legs have already committed (spec R3). Gate 6 adds it to
   *  this leg's projected total for the cap and the margin floor — checking either per leg would
   *  let a two-leg order spend the cap twice, or pass a margin floor it jointly fails. NOT added
   *  to the wallet check: the balance is re-read before each leg and already reflects that spend. */
  committedCents: number
```

and in `settings`, replace the `promisedMaxDays` comment with:

```ts
    /** The window THIS leg's buyer was shown — the max `delivery_max_days` across the leg's
     *  variants, falling back to the `fulfillment.promised_max_days` setting for pre-pivot rows
     *  that have no stored window. Never a site-wide promise. */
    promisedMaxDays: number
```

`NeedsAttentionReason`: replace `'no_us_stock'` with `'no_origin_stock'`.

Gate 4 (and update the numbered gate list in the function's doc comment from "US stock" to "origin stock"):

```ts
  for (const [supplierVariantId, needed] of neededBySupplierVariant) {
    const originEntries = (inputs.stock.get(supplierVariantId) ?? []).filter((entry) => entry.countryCode === inputs.origin)
    if (originEntries.length === 0) {
      return {
        kind: 'needs_attention',
        reason: 'no_origin_stock',
        detail: `No ${inputs.origin} stock entry for supplier variant ${supplierVariantId}`,
      }
    }
    if (!originEntries.some((entry) => entry.quantity >= needed)) {
      return {
        kind: 'needs_attention',
        reason: 'stockout',
        detail: `Insufficient ${inputs.origin} stock for supplier variant ${supplierVariantId}: need ${needed}`,
      }
    }
  }
```

Gate 6's cap and margin (the wallet check between them is unchanged):

```ts
  // Spec R3: the cap and the floor are promises about the whole CUSTOMER order, so both gate on
  // this leg's cost PLUS what the order's other legs already committed.
  const orderCommittedCents = inputs.committedCents + projectedTotalCents

  if (orderCommittedCents > inputs.settings.spendCapPerOrderCents) {
    return {
      kind: 'needs_attention',
      reason: 'cap_exceeded',
      detail: `Order total ${orderCommittedCents}c (this leg ${projectedTotalCents}c + ${inputs.committedCents}c already committed) exceeds spend cap ${inputs.settings.spendCapPerOrderCents}c`,
    }
  }
  if (projectedTotalCents > inputs.walletAvailableCents) {
    return {
      kind: 'needs_attention',
      reason: 'wallet_insufficient',
      detail: `Projected total ${projectedTotalCents}c exceeds wallet balance ${inputs.walletAvailableCents}c`,
    }
  }
  const marginBps = Math.floor(((inputs.order.totalCents - orderCommittedCents) * 10_000) / inputs.order.totalCents)
```

- [x] **Step 4: Run to verify they pass**

Run: `npx vitest run --root apps/ops test/fulfillment-plan.test.ts` → PASS (expect type errors elsewhere until Task 5; that is the next task's job). Then `pnpm --filter @doge-buddy/ops typecheck` and note which call sites break — they should be exactly `run-place-order.ts` and its tests.

- [x] **Step 5: Commit**

```bash
git add apps/ops/src/fulfillment/plan.ts apps/ops/test/fulfillment-plan.test.ts
git commit -m "feat(fulfillment): planner gates on the leg's origin and window; cap+margin count the whole order"
```

---

### Task 5: The executor splits an order into one supplier order per warehouse

**Files:**
- Modify: `apps/ops/src/fulfillment/run-place-order.ts` (`idempotencyKeyFor` ~line 44, `loadOrCreateSupplierOrder` ~line 72, `loadMappings` ~line 118, `confirmOrPark` ~line 203, `dispatchDecision` ~line 224, `executePlaceOrder` ~line 293)
- Test: `apps/ops/test/fulfillment-place-order.test.ts`

**Interfaces:**
- Consumes: `FulfillmentInputs.origin` / `.committedCents` (Task 4); `supplier_variant_mappings.warehouse_country` / `.delivery_max_days` (Tasks 1–2); `supplier_orders.warehouse_country` (Task 1).
- Produces: one `supplier_orders` row per (order, supplier, origin), idempotency key `db-<digits>-<origin>`.

**This is the money path.** Every status write stays inside `applyTransition`; the resume switch keeps its exact semantics, it just runs per leg.

- [x] **Step 1: Write the failing tests**

In `apps/ops/test/fulfillment-place-order.test.ts` (reuse its `seedMapping`, `paidPayload` and deps builders; `seedMapping` gains a `warehouseCountry` option in this same edit):

```ts
it('a mixed cart becomes two legs, each quoted and placed from its own warehouse', async () => {
  const orderGid = orderGidFor()
  await seedMapping(db, { variantGid: usGid, supplierVariantId: 'sv-us', supplierCostCents: 620, warehouseCountry: 'US' })
  await seedMapping(db, { variantGid: cnGid, supplierVariantId: 'sv-cn', supplierCostCents: 180, warehouseCountry: 'CN' })
  const quoteShipping = vi.fn(async (q: { fromCountry: string }) => [
    { name: q.fromCountry === 'CN' ? 'CJPacket' : 'Standard', priceCents: 499, minDays: 3, maxDays: q.fromCountry === 'CN' ? 14 : 7 },
  ])
  const getVariantStock = vi.fn(async (vid: string) => [
    { countryCode: vid === 'sv-cn' ? 'CN' : 'US', quantity: 20, verified: true },
  ])
  const placeOrder = vi.fn(async () => ({ supplierOrderId: `cj-${Math.random()}`, productAmountCents: 620, postageAmountCents: 499, totalAmountCents: 1119 }))
  const deps = makeDeps({ adapter: makeAdapter({ quoteShipping, getVariantStock, placeOrder }) })
  await seedPaidOrder(db, orderGid, [{ variantGid: usGid, quantity: 1 }, { variantGid: cnGid, quantity: 1 }])

  await executePlaceOrder(deps, orderGid)

  const rows = await loadSupplierOrderLegs(db, orderGid)
  expect(rows.map((r) => r.warehouseCountry).sort()).toEqual(['CN', 'US'])
  expect(rows.every((r) => r.status === 'confirmed')).toBe(true)
  expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(2)
  expect(quoteShipping.mock.calls.map(([q]) => q.fromCountry).sort()).toEqual(['CN', 'US'])
  expect(placeOrder.mock.calls.map(([a]) => a.fromCountry).sort()).toEqual(['CN', 'US'])
})

it('a leg that cannot place does not stop its sibling (spec R2)', async () => {
  // Same setup, but CN has no CN stock -> that leg parks while the US leg still places.
  const getVariantStock = vi.fn(async () => [{ countryCode: 'US', quantity: 20, verified: true }])
  // ...
  const rows = await loadSupplierOrderLegs(db, orderGid)
  const cn = rows.find((r) => r.warehouseCountry === 'CN')!
  const us = rows.find((r) => r.warehouseCountry === 'US')!
  expect(cn.status).toBe('needs_attention')
  expect(cn.lastError).toContain('no_origin_stock')
  expect(us.status).toBe('confirmed')
})

it('re-running after a crash between legs does not re-place the first leg', async () => {
  // First run: CN leg's placeOrder throws.
  // Second run with a working adapter: the US leg resumes from 'confirmed' (no second placeOrder
  // for it) and only the CN leg is placed.
  await executePlaceOrder(deps, orderGid).catch(() => {})
  const usPlacements = placeOrder.mock.calls.filter(([a]) => a.fromCountry === 'US').length
  await executePlaceOrder(depsWorking, orderGid)
  expect(placeOrder.mock.calls.filter(([a]) => a.fromCountry === 'US').length).toBe(usPlacements)
})

it('the spend cap counts both legs: the second leg parks rather than spending it again', async () => {
  // cap 1500; each leg projects 1119 -> leg 1 places, leg 2 parks 'cap_exceeded'.
  const rows = await loadSupplierOrderLegs(db, orderGid)
  expect(rows.find((r) => r.warehouseCountry === 'US')!.status).toBe('confirmed')
  const cn = rows.find((r) => r.warehouseCountry === 'CN')!
  expect(cn.status).toBe('needs_attention')
  expect(cn.lastError).toContain('cap_exceeded')
})

it('the wallet is re-read for each leg', async () => {
  await executePlaceOrder(deps, orderGid)
  expect(getBalance).toHaveBeenCalledTimes(2)
})

it('an unmapped line item parks the order without placing any leg', async () => {
  // Cart: one mapped US item + one item with no mapping row at all.
  await executePlaceOrder(deps, orderGid)
  const rows = await loadSupplierOrderLegs(db, orderGid)
  expect(rows).toHaveLength(1)
  expect(rows[0]!.status).toBe('needs_attention')
  expect(rows[0]!.lastError).toContain('unmapped_item')
  expect(placeOrder).not.toHaveBeenCalled()
})

it('a single-origin order still produces exactly one leg (unchanged behaviour)', async () => {
  const rows = await loadSupplierOrderLegs(db, orderGid)
  expect(rows).toHaveLength(1)
  expect(rows[0]!.warehouseCountry).toBe('US')
  expect(rows[0]!.status).toBe('confirmed')
})
```

Add the multi-leg loader to `apps/ops/test/helpers/fulfillment-harness.ts` (the existing `loadSupplierOrderByOrderGid` returns one arbitrary row and is now ambiguous on a split order — leave it for single-leg callers, add this beside it):

```ts
/** Every supplier_orders leg for an order gid, ordered by warehouse so assertions are stable. */
export async function loadSupplierOrderLegs(
  db: Db,
  orderGid: string,
): Promise<(typeof supplierOrders.$inferSelect)[]> {
  const [orderRow] = await db.select().from(orders).where(eq(orders.shopifyOrderGid, orderGid))
  if (!orderRow) return []
  return db
    .select()
    .from(supplierOrders)
    .where(eq(supplierOrders.orderId, orderRow.id))
    .orderBy(supplierOrders.warehouseCountry)
}
```

and give `seedMapping` the option:

```ts
  opts: { variantGid: string; supplierVariantId: string; supplierCostCents: number; supplier?: 'mock' | 'cj'; warehouseCountry?: string; deliveryMaxDays?: number },
  // ...
    warehouseCountry: opts.warehouseCountry ?? 'US',
    deliveryMaxDays: opts.deliveryMaxDays ?? null,
```

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run --root apps/ops test/fulfillment-place-order.test.ts`
Expected: FAIL — one leg is created, `fromCountry` is always `'US'`, and the second mapping's origin is ignored.

- [x] **Step 3: Implement**

Keys and row claim become origin-scoped:

```ts
/** `supplier_orders.idempotency_key` = `db-` + digits of the Shopify order gid + the leg's
 *  warehouse, e.g. `gid://shopify/Order/123` CN leg -> `db-123-CN`. Deterministic, short,
 *  CJ-safe, and distinct per leg — two legs of one customer order ARE two CJ orders. */
function idempotencyKeyFor(orderGid: string, origin: string): string {
  return `db-${orderGid.replace(/\D/g, '')}-${origin}`
}

async function loadOrCreateSupplierOrder(
  db: Db,
  orderRow: OrderRow,
  supplier: SupplierAdapter['key'],
  origin: string,
): Promise<SupplierOrderRow> {
  const where = and(
    eq(supplierOrders.orderId, orderRow.id),
    eq(supplierOrders.supplier, supplier),
    eq(supplierOrders.warehouseCountry, origin),
  )
  const [existing] = await db.select().from(supplierOrders).where(where)
  if (existing) return existing

  const [inserted] = await db
    .insert(supplierOrders)
    .values({
      orderId: orderRow.id,
      supplier,
      warehouseCountry: origin,
      idempotencyKey: idempotencyKeyFor(orderRow.shopifyOrderGid, origin),
      status: 'pending',
    })
    .onConflictDoNothing({ target: [supplierOrders.orderId, supplierOrders.supplier, supplierOrders.warehouseCountry] })
    .returning()
  if (inserted) return inserted

  const [row] = await db.select().from(supplierOrders).where(where)
  return row!
}
```

`loadMappings` carries the two new columns (add them to the select and to the map's value type):

```ts
      warehouseCountry: supplierVariantMappings.warehouseCountry,
      deliveryMaxDays: supplierVariantMappings.deliveryMaxDays,
```

Add the leg grouping and the committed-spend helper:

```ts
/** One warehouse's worth of a customer order: the line items that ship from it, and the window
 *  their buyers were shown (the SLOWEST item's window — the leg ships together, so its promise is
 *  its slowest item). `promisedMaxDays` is null when every item predates the stored window. */
interface Leg {
  origin: string
  lineItems: { variantGid: string; quantity: number }[]
  promisedMaxDays: number | null
}

/** Groups mapped line items by their mapping's warehouse. US first, then everything else
 *  alphabetically: under a tight wallet or cap the FAST leg is the one that gets placed, so the
 *  customer sees something arrive while the slow leg is resolved by hand. */
function groupLegs(
  lineItems: { variantGid: string; quantity: number }[],
  mappings: Map<string, { supplierVariantId: string; supplierCostCents: number; warehouseCountry: string; deliveryMaxDays: number | null }>,
): Leg[] {
  const byOrigin = new Map<string, Leg>()
  for (const item of lineItems) {
    const mapping = mappings.get(item.variantGid)
    if (!mapping) continue // unmapped items are handled before this is called
    const leg = byOrigin.get(mapping.warehouseCountry) ?? {
      origin: mapping.warehouseCountry,
      lineItems: [],
      promisedMaxDays: null,
    }
    leg.lineItems.push(item)
    if (mapping.deliveryMaxDays != null) {
      leg.promisedMaxDays = Math.max(leg.promisedMaxDays ?? 0, mapping.deliveryMaxDays)
    }
    byOrigin.set(mapping.warehouseCountry, leg)
  }
  return [...byOrigin.values()].sort((a, b) => (a.origin === 'US' ? -1 : b.origin === 'US' ? 1 : a.origin.localeCompare(b.origin)))
}

/** What this order's OTHER legs have already committed to spend (spec R3). Rows that never
 *  reached the supplier (`pending`) and rows whose money came back (`cancelled`, `failed`) commit
 *  nothing; everything else — including a `needs_attention` row parked AFTER its placement — does. */
async function committedCentsForOtherLegs(db: Db, orderId: string, exceptRowId: string): Promise<number> {
  const rows = await db
    .select({ id: supplierOrders.id, status: supplierOrders.status, totalAmountCents: supplierOrders.totalAmountCents })
    .from(supplierOrders)
    .where(eq(supplierOrders.orderId, orderId))
  let total = 0
  for (const row of rows) {
    if (row.id === exceptRowId) continue
    if (row.status === 'cancelled' || row.status === 'failed' || row.status === 'pending') continue
    total += row.totalAmountCents ?? 0
  }
  return total
}
```

`confirmOrPark` gains the same committed figure so the post-create re-check matches the pre-place one:

```ts
async function confirmOrPark(deps: PlaceOrderDeps, orderRow: OrderRow, supplierOrderRow: SupplierOrderRow): Promise<void> {
  const spendCapCents = await deps.settings.get('fulfillment.spend_cap_per_order_cents')
  const committedCents = await committedCentsForOtherLegs(deps.db, orderRow.id, supplierOrderRow.id)
  const totalAmountCents = (supplierOrderRow.totalAmountCents ?? 0) + committedCents

  if (totalAmountCents > spendCapCents) {
    const detail = `order total ${totalAmountCents}c (incl. ${committedCents}c on other legs) exceeds spend cap ${spendCapCents}c`
    await parkNeedsAttention(deps, orderRow, supplierOrderRow, 'created', 'cap_exceeded_post_create', detail)
    return
  }
  // ...unchanged from here
}
```

`dispatchDecision` takes the leg's origin and passes it to CJ:

```ts
        fromCountry: origin,
```

`executePlaceOrder`'s body, after the shipping-address guard, becomes the leg loop. The resume switch moves into a per-leg helper and its `return`s become `return` from that helper (the loop continues to the next leg):

```ts
  const lineItems = extractLineItems(orderRow)
  const mappings = await loadMappings(deps.db, deps.adapter.key, lineItems)

  // Unmapped items park the WHOLE order without placing anything. Unlike a supply failure (spec
  // R2, where the placeable leg still ships), an unmapped item means we cannot resolve what the
  // customer bought — spending money on the half we do understand is the wrong call on incomplete
  // information. Parked on the default-origin row so the shape matches the pre-split behaviour.
  const unmapped = lineItems.filter((item) => !mappings.has(item.variantGid))
  if (unmapped.length > 0) {
    const row = await loadOrCreateSupplierOrder(deps.db, orderRow, deps.adapter.key, 'US')
    if (row.status === 'pending') {
      await parkNeedsAttention(deps, orderRow, row, 'pending', 'unmapped_item',
        `No supplier mapping for ${unmapped.map((i) => i.variantGid).join(', ')}`)
    }
    return
  }

  for (const leg of groupLegs(lineItems, mappings)) {
    await placeLeg(deps, orderRow, shippingAddress, leg)
  }
```

and `placeLeg` is the old body, leg-scoped:

```ts
/** The old order-scoped path, now run once per warehouse. A leg that parks, requeues or fails a
 *  gate returns quietly so its siblings still get their turn (spec R2). */
async function placeLeg(deps: PlaceOrderDeps, orderRow: OrderRow, shippingAddress: Address, leg: Leg): Promise<void> {
  const supplierOrderRow = await loadOrCreateSupplierOrder(deps.db, orderRow, deps.adapter.key, leg.origin)

  const status: SupplierOrderStatusDb = supplierOrderRow.status
  switch (status) {
    case 'pending': break
    case 'created': await confirmOrPark(deps, orderRow, supplierOrderRow); return
    case 'confirmed': await enqueuePayOrder(deps, supplierOrderRow.id); return
    case 'needs_attention': case 'failed': case 'cancelled': return
    case 'awaiting_funds': case 'paid': case 'shipped': case 'delivered': return
    default: { const exhaustive: never = status; throw new Error(`unhandled supplier_orders status: ${exhaustive}`) }
  }

  const mappings = await loadMappings(deps.db, deps.adapter.key, leg.lineItems)
  const neededBySupplierVariant = aggregateNeeded(leg.lineItems, mappings)

  const stock = new Map<string, WarehouseStock[]>()
  for (const supplierVariantId of neededBySupplierVariant.keys()) {
    stock.set(supplierVariantId, await deps.adapter.getVariantStock(supplierVariantId))
  }

  const freightItems = [...neededBySupplierVariant].map(([supplierVariantId, quantity]) => ({ supplierVariantId, quantity }))
  const freightOptions =
    freightItems.length === 0
      ? []
      : await deps.adapter.quoteShipping({
          // The LEG's warehouse — stock was verified there, and a quote from anywhere else prices
          // a shipment we will never make.
          fromCountry: leg.origin,
          toCountry: shippingAddress.country,
          toZip: shippingAddress.zip,
          items: freightItems,
        })

  // Re-read per leg (spec R4): leg 1's placement already moved this number.
  const { availableCents: walletAvailableCents } = await deps.adapter.getBalance()
  const committedCents = await committedCentsForOtherLegs(deps.db, orderRow.id, supplierOrderRow.id)

  const inputs: FulfillmentInputs = {
    order: { isTest: orderRow.isTest, totalCents: orderRow.totalCents ?? 0, shippingAddress, lineItems: leg.lineItems },
    origin: leg.origin,
    committedCents,
    settings: {
      killswitch: await deps.settings.get('killswitch.global'),
      fulfillmentEnabled: await deps.settings.get('workflow.fulfillment.enabled'),
      pausedForFunds: await deps.settings.get('fulfillment.paused_for_funds'),
      spendCapPerOrderCents: await deps.settings.get('fulfillment.spend_cap_per_order_cents'),
      marginFloorBps: await deps.settings.get('fulfillment.margin_floor_bps'),
      // The leg's own promise; the setting is the pre-pivot fallback and nothing else.
      promisedMaxDays: leg.promisedMaxDays ?? (await deps.settings.get('fulfillment.promised_max_days')),
    },
    mappings,
    stock,
    freightOptions,
    walletAvailableCents,
  }

  await dispatchDecision(deps, orderRow, supplierOrderRow, planFulfillment(inputs), shippingAddress, leg.origin)
}
```

Keep the `isTest` shell guard and the shipping-address guard where they are — both are order-level and must run before any leg exists.

- [x] **Step 4: Run to verify they pass**

Run: `npx vitest run --root apps/ops test/fulfillment-place-order.test.ts test/fulfillment-plan.test.ts` → PASS. Then the whole fulfillment surface, which has E2E suites that drive this executor through pg-boss: `npx vitest run --root apps/ops test/fulfillment-*.test.ts test/e2e-*.test.ts`. Then `pnpm --filter @doge-buddy/ops typecheck`.

- [x] **Step 5: Commit**

```bash
git add apps/ops/src/fulfillment/run-place-order.ts apps/ops/test
git commit -m "feat(fulfillment): split a mixed-origin order into one supplier order per warehouse"
```

---

### Task 6: Overdue is measured against the leg's own window

**Files:**
- Modify: `apps/ops/src/fulfillment/run-reconcile.ts` (`sweepOverdue` ~line 338)
- Test: `apps/ops/test/fulfillment-reconcile.test.ts`

**Interfaces:**
- Consumes: `supplier_variant_mappings.delivery_max_days` (Tasks 1–2), `supplier_orders.warehouse_country` (Task 1).

- [x] **Step 1: Write the failing tests**

```ts
it('a 14-day CN leg is not overdue on day 8, and a 7-day US leg is', async () => {
  const cn = await seedLegPaidDaysAgo(8, { warehouseCountry: 'CN', deliveryMaxDays: 14 })
  const us = await seedLegPaidDaysAgo(8, { warehouseCountry: 'US', deliveryMaxDays: 7 })

  await sweepOverdue(deps)

  expect((await reloadLeg(cn)).status).not.toBe('needs_attention')
  expect((await reloadLeg(us)).status).toBe('needs_attention')
})

it('a leg with no stored window falls back to fulfillment.promised_max_days', async () => {
  const legacy = await seedLegPaidDaysAgo(8, { warehouseCountry: 'US', deliveryMaxDays: null })
  await sweepOverdue(deps)
  expect((await reloadLeg(legacy)).status).toBe('needs_attention')
})

it('the alert names the window that was actually breached', async () => {
  await seedLegPaidDaysAgo(20, { warehouseCountry: 'CN', deliveryMaxDays: 14 })
  await sweepOverdue(deps)
  expect(alert).toHaveBeenCalledWith('warning', 'order_overdue', expect.objectContaining({ promisedMaxDays: 14 }))
})
```

(`seedLegPaidDaysAgo` / `reloadLeg` = small helpers over that file's existing seeding; the mapping's `deliveryMaxDays` must be seeded on a variant that the leg's order actually contains.)

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run --root apps/ops test/fulfillment-reconcile.test.ts`
Expected: FAIL — the CN leg is parked on day 8 against the global 7.

- [x] **Step 3: Implement**

The single-cutoff query cannot express a per-row window, so select the candidates and their windows, then filter in code (the sweep is already a per-row loop with per-row try/catch, so this changes shape, not safety):

```ts
export async function sweepOverdue(deps: ReconcileDeps): Promise<SweepResult> {
  const fallbackMaxDays = await deps.settings.get('fulfillment.promised_max_days')
  const now = deps.now()

  // Widest possible net first — the longest window any row could claim is the fallback or the
  // largest stored window — then each row is judged against its OWN promise below.
  const [{ maxStoredDays } = { maxStoredDays: null }] = await deps.db
    .select({ maxStoredDays: sql<number | null>`max(${supplierVariantMappings.deliveryMaxDays})` })
    .from(supplierVariantMappings)
  const widestDays = Math.max(fallbackMaxDays, maxStoredDays ?? 0)
  const widestCutoff = new Date(now.getTime() - widestDays * 24 * 60 * 60 * 1000)

  const rows = await deps.db
    .select({ supplierOrder: supplierOrders, order: orders })
    .from(supplierOrders)
    .innerJoin(orders, eq(supplierOrders.orderId, orders.id))
    .where(and(notInArray(supplierOrders.status, OVERDUE_EXCLUDED_STATUSES), isNotNull(orders.paidAt), lt(orders.paidAt, widestCutoff)))

  let count = 0
  let failures = 0

  for (const { supplierOrder, order } of rows) {
    if (!canTransition(supplierOrder.status, 'needs_attention')) continue

    // The leg's own promise: the slowest window among the variants IT ships, falling back to the
    // setting for pre-pivot rows. Measuring a 14-day CN leg against a 7-day site-wide number
    // would park every CN order a week before it is actually late.
    const promisedMaxDays = (await legPromisedMaxDays(deps.db, supplierOrder)) ?? fallbackMaxDays
    const cutoff = new Date(now.getTime() - promisedMaxDays * 24 * 60 * 60 * 1000)
    if (order.paidAt! >= cutoff) continue

    try {
      // ...unchanged park + alert, with `promisedMaxDays` now the leg's own number
    } catch (err) { /* unchanged */ }
  }
  return { count, failures }
}
```

and the lookup, next to it:

```ts
/** The slowest stored `delivery_max_days` across the variants this LEG ships (matched by the
 *  leg's warehouse), or null when none of them stores one. */
async function legPromisedMaxDays(db: Db, supplierOrder: typeof supplierOrders.$inferSelect): Promise<number | null> {
  const [row] = await db
    .select({ maxDays: sql<number | null>`max(${supplierVariantMappings.deliveryMaxDays})` })
    .from(supplierVariantMappings)
    .innerJoin(productVariants, eq(supplierVariantMappings.variantId, productVariants.id))
    .innerJoin(orderLineItemsSource, /* the join this file already uses to reach an order's variants */)
    .where(and(
      eq(supplierVariantMappings.supplier, supplierOrder.supplier),
      eq(supplierVariantMappings.warehouseCountry, supplierOrder.warehouseCountry),
    ))
  return row?.maxDays ?? null
}
```

**Implementer's note:** `orders.lineItems` is stored JSON, not a table, so the join above is written against however this file already resolves an order's variants (see `run-place-order.ts`'s `extractLineItems` + `loadMappings` pair — reuse them rather than inventing a join if no relational path exists; a small in-code lookup is fine and clearer than SQL gymnastics over JSON).

- [x] **Step 4: Run to verify they pass**

Run: `npx vitest run --root apps/ops test/fulfillment-reconcile.test.ts` → PASS. Then `pnpm --filter @doge-buddy/ops typecheck`.

- [x] **Step 5: Commit**

```bash
git add apps/ops/src/fulfillment/run-reconcile.ts apps/ops/test/fulfillment-reconcile.test.ts
git commit -m "feat(reconcile): overdue measured against each leg's own promised window"
```

---

### Task 7: Tracking creates one Shopify fulfillment per leg

**Files:**
- Modify: `packages/shopify-admin/src/operations.ts` (`ORDER_FULFILLMENT_ORDERS_QUERY` ~line 351, `fulfillmentCreate` ~line 390)
- Modify: `apps/ops/src/fulfillment/run-sync-tracking.ts` (`ShopifyFulfillmentOps` ~line 17, `createFulfillment` ~line 97)
- Test: `packages/shopify-admin/test/operations.test.ts`, `apps/ops/test/fulfillment-sync-tracking.test.ts`

**Interfaces:**
- Consumes: `supplier_orders.warehouse_country` (Task 1).
- Produces: `orderFulfillmentOrders` returns `lineItems: { id, remainingQuantity, variantGid }[]` per node; `fulfillmentCreate` accepts optional `fulfillmentOrderLineItems: { id: string; quantity: number }[]`.

**Why:** today `fulfillmentCreate` fulfils a whole Shopify fulfillment order with no line-item selection. On a split order leg 1 would close it, and leg 2 would find a `CLOSED` node, trip `hasSuspiciousClosedNode`, and be reported as a suspected duplicate — a leg that shipped perfectly well, parked and never tracked.

- [x] **Step 1: Write the failing tests**

`packages/shopify-admin/test/operations.test.ts`:

```ts
it('orderFulfillmentOrders returns each node’s line items with their variant gids', async () => {
  const client = fakeClient({
    order: { fulfillmentOrders: { nodes: [{ id: 'fo-1', status: 'OPEN', lineItems: { nodes: [
      { id: 'foli-1', remainingQuantity: 2, lineItem: { variant: { id: 'gid://shopify/ProductVariant/1' } } },
    ] } }] } },
  })
  const result = await orderFulfillmentOrders(client, 'gid://shopify/Order/1')
  expect(result[0]!.lineItems).toEqual([{ id: 'foli-1', remainingQuantity: 2, variantGid: 'gid://shopify/ProductVariant/1' }])
})

it('fulfillmentCreate scopes the fulfillment to the given line items when they are supplied', async () => {
  const client = fakeClient({ fulfillmentCreate: { fulfillment: { id: 'f-1' }, userErrors: [] } })
  await fulfillmentCreate(client, {
    fulfillmentOrderId: 'fo-1', notifyCustomer: true,
    fulfillmentOrderLineItems: [{ id: 'foli-1', quantity: 2 }],
  })
  expect(client.graphql).toHaveBeenCalledWith(expect.any(String), {
    fulfillment: expect.objectContaining({
      lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: 'fo-1', fulfillmentOrderLineItems: [{ id: 'foli-1', quantity: 2 }] }],
    }),
  })
})

it('fulfillmentCreate without line items still fulfils the whole fulfillment order', async () => {
  // unchanged single-leg behaviour
})
```

`apps/ops/test/fulfillment-sync-tracking.test.ts`:

```ts
it('each leg fulfils only its own line items, and the second leg is not a suspected duplicate', async () => {
  const fulfillmentCreate = vi.fn(async () => ({ fulfillmentId: 'f-1' }))
  const orderFulfillmentOrders = vi.fn(async () => [{
    id: 'fo-1', status: 'OPEN',
    lineItems: [
      { id: 'foli-us', remainingQuantity: 1, variantGid: usGid },
      { id: 'foli-cn', remainingQuantity: 1, variantGid: cnGid },
    ],
  }])
  await syncTracking(deps, cnLegRowId)
  expect(fulfillmentCreate).toHaveBeenCalledWith(expect.objectContaining({
    fulfillmentOrderLineItems: [{ id: 'foli-cn', quantity: 1 }],
  }))
})
```

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run --root packages/shopify-admin` and `npx vitest run --root apps/ops test/fulfillment-sync-tracking.test.ts`
Expected: FAIL — the query returns no line items and the mutation takes no selection.

- [x] **Step 3: Implement**

Query:

```graphql
      fulfillmentOrders(first: 50) {
        nodes {
          id
          status
          lineItems(first: 50) {
            nodes { id remainingQuantity lineItem { variant { id } } }
          }
        }
      }
```

with the return shape flattened to `{ id, status, lineItems: { id, remainingQuantity, variantGid }[] }` (a line item whose variant is null — a deleted product — maps to `variantGid: null` and is simply never matched by a leg).

Mutation:

```ts
export async function fulfillmentCreate(
  client: ShopifyAdminClient,
  args: {
    fulfillmentOrderId: string
    trackingNumber?: string
    trackingCompany?: string
    notifyCustomer: boolean
    /** Scope this fulfillment to specific line items. Omitted = the whole fulfillment order,
     *  which is right for a single-leg order and WRONG for one leg of a split order: the first
     *  leg would close the fulfillment order and the second would look like a duplicate. */
    fulfillmentOrderLineItems?: { id: string; quantity: number }[]
  },
): Promise<{ fulfillmentId: string }> {
  const fulfillment: Record<string, unknown> = {
    lineItemsByFulfillmentOrder: [
      args.fulfillmentOrderLineItems
        ? { fulfillmentOrderId: args.fulfillmentOrderId, fulfillmentOrderLineItems: args.fulfillmentOrderLineItems }
        : { fulfillmentOrderId: args.fulfillmentOrderId },
    ],
  }
  // ...rest unchanged
}
```

In `createFulfillment`, resolve the leg's line items before calling, and only treat a closed node as suspicious when this leg has nothing left to fulfil:

```ts
  // Which of this fulfillment order's line items belong to THIS leg: the ones whose variant maps
  // to a supplier variant in the leg's warehouse. A split order legitimately leaves the other
  // leg's items unfulfilled here.
  const legVariantGids = await legVariantGidsFor(deps.db, supplierOrderRow)
  const legLineItems = target.lineItems
    .filter((li) => li.variantGid != null && legVariantGids.has(li.variantGid) && li.remainingQuantity > 0)
    .map((li) => ({ id: li.id, quantity: li.remainingQuantity }))

  if (legLineItems.length === 0) {
    // Nothing of ours left to fulfil — the pre-split "suspected duplicate" case, now precise.
    await auditSkip(deps.db, 'fulfillment.sync_suspected_duplicate', orderRow, supplierOrderRow.id, { orderGid: orderRow.shopifyOrderGid })
    await deps.alert('warning', 'sync_suspected_duplicate', { supplierOrderRowId: supplierOrderRow.id })
    return
  }

  const result = await deps.shopifyOps.fulfillmentCreate({
    fulfillmentOrderId: target.id,
    trackingNumber: supplierOrderRow.trackingNumber!,
    trackingCompany: supplierOrderRow.logisticName ?? undefined,
    notifyCustomer: true,
    fulfillmentOrderLineItems: legLineItems,
  })
```

`hasSuspiciousClosedNode` is now redundant for split orders but stays for the case where NO node is creatable at all; keep it, and let the emptier `legLineItems` check above run first.

- [x] **Step 4: Run to verify they pass**

Run: `npx vitest run --root packages/shopify-admin` and `npx vitest run --root apps/ops test/fulfillment-sync-tracking.test.ts` → PASS. Then `pnpm -r typecheck`.

- [x] **Step 5: Commit**

```bash
git add packages/shopify-admin apps/ops/src/fulfillment/run-sync-tracking.ts apps/ops/test
git commit -m "feat(tracking): one Shopify fulfillment per leg, scoped to that leg's line items"
```

---

### Task 8: Full verification + docs

**Files:**
- Modify: `docs/ROADMAP.md` (Phase A3b), `docs/OWNER-CHECKLIST.md` (the blocking CN item)

- [x] **Step 1: Full suites**

```bash
pnpm --filter @doge-buddy/core test
pnpm --filter @doge-buddy/db test
pnpm --filter @doge-buddy/supplier test
pnpm --filter @doge-buddy/ops test
pnpm --filter @doge-buddy/storefront test
pnpm -r typecheck
```

Expected: green except the three known dev-DB failures (`admin-dashboard` 8 and 13, `scoring-weekly-digest` freshness).

- [x] **Step 2: Docs**

- `OWNER-CHECKLIST.md`: the blocking CN item loses its half about `run-place-order.ts` — that half is now built. What REMAINS blocking is CJ's written DDP/duty/IOR answers, confirmed empirically on the canary. Say so explicitly rather than deleting the item.
- `ROADMAP.md` Phase A3b: origin-aware fulfillment is built; the CN lane is gated on the duty verification alone. Link this plan and its spec.
- Note the new migration in the deploy path: **0013 must be applied to Railway BEFORE the code that reads the new columns is deployed** — the same strict order as 0008/0009 (a redeploy first means every place-order job throws on a missing column while `/healthz` stays green).

- [x] **Step 3: Commit**

```bash
git add docs/
git commit -m "docs: origin-aware fulfillment built — the CN lane now waits only on the CJ duty verification"
```

---

## Self-Review Notes

- **Spec coverage:** §3 data model → Task 1 · §3 listing writes → Task 2 · §6 inventory → Task 3 · §5 planner gates → Task 4 · §4 split executor + R2/R3/R4 → Tasks 4–5 · §7 reconcile → Task 6 · §7 tracking → Task 7 · §9 risks → the tests named in each task · §8 out-of-scope (comfort system, duty verification) → untouched, and Task 8 restates what still blocks.
- **Type consistency:** `originQuantity(stock, origin)` is defined in Task 3 and used in Tasks 2–3 · `FulfillmentInputs.origin`/`.committedCents` defined in Task 4, supplied in Task 5 · `Leg.promisedMaxDays: number | null` feeds `settings.promisedMaxDays: number` through the `??` fallback in Task 5 · `loadSupplierOrderLegs` added in Task 5 and used by Tasks 5–6 · `fulfillmentOrderLineItems` named identically in Task 7's two files.
- **One decision this plan makes that the spec left open:** an UNMAPPED line item parks the whole order without placing any leg (Task 5). Spec R2 covers a leg that cannot place for SUPPLY reasons; an unmapped item is a data-integrity failure where we do not know what was bought, so partial placement would be spending on incomplete information. Flagged for the owner rather than assumed.
- **Deploy order (Task 8):** migration 0013 before the code. Non-negotiable, same trap as 0008/0009.
