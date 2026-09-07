# Origin-aware fulfillment: making the CN lane sellable — Design

**Status: written 2026-09-06 on Robert's directive, after the affordable-catalog pivot part 1
landed (merge `d7ed7fd`).** Two owner rulings were taken during design and are recorded in §2.

**Parents:** `2026-09-03-affordable-catalog-pivot-design.md` (part 1 made CN products *listable*;
this makes them *sellable*) · `ROADMAP.md` Phase A3b · `OWNER-CHECKLIST.md` §Now, where the CJ
duty/DDP/IOR verification is the other half of the same gate.

---

## 1. The problem: the US assumption is a dimension, not a line

Part 1 made sourcing origin-aware end to end. Everything *after* the listing still assumes US.
Read live 2026-09-06:

| Where | The assumption | What it does to a CN product |
|---|---|---|
| `proposals/apply-new-listing.ts` (~line 376) | never writes `supplier_variant_mappings.warehouse_country` — the column has existed since migration 0000, defaults `'US'`, and **nothing in the repo reads or writes it** | order time cannot learn the origin at all |
| `jobs/inventory-sync.ts` `usQuantity()` | counts US warehouse rows only | CN stock reads 0 → Shopify shows sold out → **the product is unbuyable**, so nothing below it ever runs |
| `fulfillment/plan.ts` gate 4 | requires US stock; reason `no_us_stock` | order parks, never ships |
| `fulfillment/plan.ts` gate 5 | freight must land within `fulfillment.promised_max_days` = **7**, one site-wide number | a 7–14 day CN order is rejected as `no_freight_in_window` |
| `fulfillment/run-place-order.ts` (~262, ~380) | `quoteShipping` and `placeOrder` hard-code `fromCountry: 'US'` | quotes and orders the wrong warehouse |
| `fulfillment/run-reconcile.ts` `sweepOverdue` | overdue measured against the same global 7 days | every CN order parked "overdue" on day 7 of a 14-day window |

Two observations shape the design.

**Today's behaviour fails safe.** A CN order parks (`no_us_stock`) rather than shipping wrong. So
this is a build that *unblocks* revenue, not one that fixes a live money bug. It does not gate a
US-only launch.

**`fulfillment.promised_max_days` is the same blanket promise part 1 deleted from the storefront**,
still alive inside the gates. The storefront now shows each product's own window; the gate that
decides whether we can honour it still compares against a global 7. Making that per-product is not
scope creep — it is the same honesty rule, applied where it is enforced rather than displayed.

## 2. Owner rulings taken during design

**R1 — a mixed-origin cart splits into two supplier orders**, one per warehouse, each with its own
freight quote, carrier, tracking and Shopify fulfillment. (Rejected: parking mixed orders for
manual handling — smaller, but it makes an ordinary cart a manual job.)

**R2 — partial failure places what it can.** If the US leg is placeable and the CN leg is not
(stockout, no freight in its window, wallet short), the US leg ships and the CN leg parks as
`needs_attention` for Robert. The buyer already sees two windows on two products and is expecting
two arrivals. (Rejected: all-or-nothing, which delays a perfectly placeable shipment; and
auto-refunding the failed leg, which makes a money decision without the owner and collides with
the existing refund proposal flow.)

**R3 — the spend cap AND the margin floor stay per CUSTOMER order, summed across legs.**
`fulfillment.spend_cap_per_order_cents` (7500) is a promise about what one customer order may cost
us; enforcing it per leg would silently double it on every split order. The margin gate has the
same flaw and it is the more dangerous one: `plan.ts` gate 6 compares a leg's cost against the
**whole order's** revenue, so two legs each costing 45% of revenue would both pass a 6000bps floor
while the order as a whole loses money. Both checks therefore take a `committedCents` input — what
this order's other legs have already committed — and gate on the total. The wallet check is the
exception and stays per leg: the balance is re-read before each leg (R4), so leg 1's spend is
already reflected in the number leg 2 sees, and adding it again would double-count it.

**R4 — the wallet is re-read before each leg.** A balance that covers leg 1 need not cover leg 2,
and leg 1's placement is what drained it. Leg 2 then takes the planner's existing
`wallet_insufficient` path (gate 6) and parks — the same outcome an unaffordable single order gets
today, reached with a balance read that is actually current rather than one taken before any money
moved.

## 3. The origin dimension in the data model

One migration (`0013`), two columns, one widened index.

**`supplier_variant_mappings`** — written by `apply-new-listing.ts` from the approved payload, so
the numbers order time uses are exactly the numbers the buyer was shown:
- `warehouse_country` — **already exists**; start writing it from `payload.shipsFrom`.
- `delivery_max_days integer` (new, nullable) — from `payload.deliveryMaxDays`, which since part 1
  is the carrier's real quoted window, not an agent guess. Nullable because every pre-pivot row
  has no such value; those fall back to `fulfillment.promised_max_days` (§5).

**`supplier_orders`** — gains the leg identity:
- `warehouse_country text NOT NULL DEFAULT 'US'` (new).
- unique index `(order_id, supplier)` → **`(order_id, supplier, warehouse_country)`**. This is the
  one structural change; everything that already operates per supplier-order row — the status
  machine, `applyTransition`, tracking sync, reconcile, the pay-order job — keeps working unchanged
  because it never cared how many rows an order had. (Rejected: one row owning N shipment children.
  It refactors live, working, money-critical code to buy nothing this design needs.)
- `idempotency_key` becomes `db-<digits>-<origin>` (e.g. `db-123-US`, `db-123-CN`). Today's key is
  `db-<digits>`; existing single-leg rows keep theirs — the key is only generated at row creation,
  and no live row is rewritten. **CJ-side consequence:** two legs of one customer order are two
  independent CJ orders with distinct keys, which is exactly what they are.

**Backfill:** none needed. Every product listed to date is US, and `'US'` is the column default on
both tables. A `warehouse_country` backfill would be a no-op by construction.

## 4. The split executor (`run-place-order.ts`)

The job is currently *order-scoped*: one `orders` row → one `supplier_orders` row → one plan → one
`placeOrder`. It becomes *leg-scoped*, with the order-level work done once and the rest per leg.

```
executePlaceOrder(orderGid)
  ├── order-level, once: test guard, shipping-address guard, load mappings
  ├── group line items by mapping.warehouse_country   → legs: [US, CN]
  └── for each leg (deterministic order: US, then CN):
        ├── loadOrCreateSupplierOrder(order, supplier, origin)   ← claim/resume, per leg
        ├── resume switch on THAT leg's status (unchanged semantics)
        ├── gather: stock + freight quoted fromCountry = leg origin
        ├── plan(leg inputs, capRemaining = cap − other legs' committed totals)
        └── dispatch: place / requeue / park — a parked leg never stops its siblings
```

**Each leg is independently resumable.** The existing resume switch (`pending` → proceed,
`created` → `confirmOrPark`, `confirmed` → enqueue pay, parked → operator owns it) is exactly right
per leg; it just runs once per leg instead of once per order. A crash between leg 1's placement and
leg 2's is recovered by re-running the job: leg 1 resumes at `created`/`confirmed` and is not
re-placed, leg 2 starts at `pending`.

**Per R2, a leg's failure is contained.** `parkNeedsAttention` already takes the supplier-order row
as an argument, so parking one leg is the existing code path with no new shape. The loop continues
to the next leg; the job itself only throws for order-level failures (missing order row).

**Ordering is deterministic (US first, then CN)** so that under a tight wallet or cap the *fast*
leg is the one that gets placed — the customer sees something arrive quickly while the slow leg is
resolved by hand.

## 5. Planner gates become origin-aware (`plan.ts`)

`FulfillmentInputs` gains the leg's `origin` and its `promisedMaxDays`; the planner stays pure.

- **Gate 4 (stock)**: `entry.countryCode === 'US'` → `=== inputs.origin`. Reason renames
  `no_us_stock` → `no_origin_stock`, detail naming the warehouse checked. (The reason string is
  operator-facing and appears in `last_error`; renaming it is honest, and no code branches on it.)
- **Gate 5 (freight window)**: the ceiling is **the leg's own promised window** — the maximum
  `delivery_max_days` across that leg's mapped variants — falling back to
  `fulfillment.promised_max_days` when every variant in the leg is a pre-pivot row with no stored
  window. Max, not min: the leg ships together, so the leg's promise is its slowest item, which is
  precisely what the buyer was shown for that item.
- **Gate 5 keeps rejecting**, never stretching: a leg with no freight option inside the window the
  buyer was shown parks. We do not silently ship something slower than promised — that is the FTC
  mail-order exposure part 1's policy copy was written to avoid.

`fulfillment.promised_max_days` survives **only** as the legacy fallback, and its comment says so.

## 6. Inventory sync (`jobs/inventory-sync.ts`)

`usQuantity(stock)` → `originQuantity(stock, origin)`, taking the largest single warehouse row for
*that* origin (the existing "largest single warehouse, not the sum" rule is unchanged — it matches
what the fulfillment planner can actually draw from). The sync already reads the mapping row it
locks, so the origin is in hand; no extra query.

**This is the load-bearing change of the whole spec.** Without it a CN product syncs to quantity 0,
Shopify shows it sold out, and no order is ever created for the rest of this design to fulfil.

## 7. Reconcile and tracking

**`sweepOverdue`** measures each row against its own leg's promised window rather than one global
cutoff. The current single-cutoff SQL (`orders.paid_at < now − promised_max_days`) becomes a join
that carries each leg's window; rows with no stored window keep using the setting. Without this,
every CN order is parked "overdue" on day 7 of a window the buyer was told was 14.

**`run-sync-tracking.ts` must scope its fulfillment to the leg's line items.** Today it calls
`fulfillmentCreate` against the first creatable Shopify *fulfillment order* with no line-item
selection. On a split order, leg 1 would close the whole fulfillment order and leg 2 would find a
`CLOSED` node — tripping `hasSuspiciousClosedNode` and parking a leg that shipped perfectly well.
Each leg must pass only its own line items (`lineItemsByFulfillmentOrder`), so Shopify records two
fulfillments with two tracking numbers, which is what the customer should see.

## 8. Explicitly NOT in scope

- **The comfort system** (pivot spec §5 — post-purchase reassurance emails). Separate plan.
- **The CJ duty/DDP/IOR verification.** Robert's, empirical, and it still gates the first CN sale
  independently of this build. Code cannot answer it.
- **Splitting by anything other than origin.** Not by supplier (there is one), not by carrier.
- **Customer-facing "two shipments" messaging** beyond the two tracking numbers Shopify already
  emails. If that reads badly in the canary, it becomes a comfort-system item.

## 9. Risks

| Risk | Handling |
|---|---|
| Splitting is money-critical code, and a bug double-places an order | Per-leg idempotency keys are deterministic (`db-<digits>-<origin>`); the resume switch is unchanged and already the tested guard against double placement. Tests cover crash-between-legs explicitly. |
| The cap is enforced per leg by accident, doubling the real cap | R3: the cap check subtracts the order's other legs' committed totals. A test asserts a two-leg order cannot exceed the single cap. |
| Leg 1 ships, leg 2 parks, and the parked leg is forgotten | It parks as `needs_attention` with an alert — the same path Robert already watches on `/admin`. |
| A CN order ships slower than the window the buyer saw | Gate 5 rejects rather than stretches; reconcile measures the real window. |
| Pre-pivot rows have no stored window | Nullable column, documented fallback to the existing setting. Every current row is US/7, i.e. exactly today's behaviour. |

## 10. Test plan (all vitest, TDD per task)

- **Migration/schema**: the widened unique index accepts two legs of one order and still rejects a
  duplicate `(order, supplier, origin)`.
- **`apply-new-listing`**: a CN payload writes `warehouse_country: 'CN'` and its `delivery_max_days`.
- **`originQuantity`**: CN stock with no US rows returns the CN quantity (today returns 0).
- **Planner**: origin stock gate both ways (CN winner with only US stock parks, and vice versa);
  gate 5 honours a per-leg 14-day window where the global setting is 7; falls back to the setting
  when no stored window exists.
- **Executor**: a mixed cart produces two legs quoted `fromCountry` US and CN respectively; leg 2
  failing leaves leg 1 placed (R2); re-running after a crash between legs does not re-place leg 1;
  a two-leg order whose combined total exceeds the cap parks the second leg (R3); the wallet is
  re-read per leg (R4).
- **Reconcile**: a 14-day leg is not overdue on day 8; a 7-day leg is.
- **Tracking**: two legs create two fulfillments with their own line items, and leg 2 does not trip
  the closed-node guard.
- Known-benign dev-DB failures stay as they are: `admin-dashboard` #8/#13, `scoring-weekly-digest`.
