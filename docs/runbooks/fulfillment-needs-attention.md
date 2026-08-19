# Runbook: `supplier_orders` parked `needs_attention`

Any row in `supplier_orders.status = 'needs_attention'` has been pulled out of the automated
fulfillment pipeline for a human to look at — the queue jobs (`fulfillment.place-order`,
`fulfillment.reconcile`'s sweeps, the CJ webhook router) all deliberately stop touching it once it
lands here (`executePlaceOrder`'s resume switch: `case 'needs_attention': ... return`). It stays
parked until an operator moves it, by hand, to one of three places:

- **`pending`** — re-run the planner from scratch (gates + a fresh `placeOrder` attempt).
- **`confirmed`** — skip straight to payment (the supplier-side order already exists and is fine).
- **`cancelled`** — abandon it; nothing further will ever touch this row.

There is no admin UI for this yet (Tier-2 checklist) — recovery today means a direct
`UPDATE supplier_orders SET status = '<target>' WHERE id = '<row id>'`, followed by re-sending
`fulfillment.place-order { orderGid }` (singleton-keyed on the order gid) if you moved it to
`pending` or `confirmed` and want it to move immediately rather than waiting for the next
`fulfillment.reconcile` sweep to notice.

**Why `pending` is safe to retry, not just convenient:** `supplier_orders.idempotency_key` is
generated once (`db-<order id digits>`) and never changes. A retried `placeOrder` call against the
mock adapter returns the cached result for that key instead of creating a second order; CJ's own
adapter pre-checks `shopping/order/list` by that same key (`orderNumber`) before ever calling
create, so a resumed row can't double-place with the supplier either. Re-placement is resumable by
construction — that's what makes `needs_attention -> pending` the default recovery, not a risky one.

## Reading `lastError`

Every parked row's `lastError` starts with a short reason code, set the same way everywhere
(`parkNeedsAttention` / `resolveCjTransition` / sweep 4's overdue check — never written directly).
The table below is that reason code's meaning and the recovery it usually calls for.

| `lastError` prefix | What it means | Safe recovery |
| --- | --- | --- |
| `unmapped_item` | A line item's variant has no row in `supplier_variant_mappings` for this supplier. | Add the missing mapping, then `needs_attention -> pending`. |
| `stockout` | The supplier variant has US stock, but not enough to cover this order's quantity. | Wait for restock (check supplier stock), or source manually; then `-> pending` once covered. |
| `no_us_stock` | The supplier variant has no US warehouse entry at all (CN-only or unlisted). | Fix the mapping to a US-stocked variant, or hold; then `-> pending`. |
| `no_freight_in_window` | No freight option lands within `fulfillment.promised_max_days`. | Raise the promised-days setting, or wait for a faster option; then `-> pending`. |
| `cap_exceeded` | Pre-`placeOrder` projected total exceeds `fulfillment.spend_cap_per_order_cents`. | Confirm the order is legitimate (not a pricing bug), then raise the cap or approve manually; `-> pending`. |
| `cap_exceeded_post_create` | Same cap check, but re-run *after* a real `placeOrder` call already created the supplier-side order (`created` status) — the order exists with CJ/mock but was never confirmed/paid. | Verify the actual placed total is intentional; `-> confirmed` to pay as-is, or `-> cancelled` and dispute/cancel with the supplier if it shouldn't have been placed. |
| `wallet_insufficient` | Projected total exceeds the supplier wallet's available balance. | Top up the wallet (see `cj.wallet-monitor`), then `-> pending`. |
| `margin_below_floor` | Order margin (after supplier + freight cost) is below `fulfillment.margin_floor_bps`. | Confirm pricing is correct; lower the floor or accept the margin manually, then `-> pending`. |
| `missing_address` | The order has no usable normalized shipping address (missing/malformed at `orders/paid` time). | Get/repair the address on the Shopify order, re-sync it into `orders.shipping_address`, then `-> pending`. |
| `overdue` | Sweep 4: order was paid more than `fulfillment.promised_max_days` days ago and still isn't shipped/delivered/parked/terminal. | Investigate why it stalled (check the row's history / other reason codes first); resume with `-> pending` or `-> confirmed` once unblocked, or `-> cancelled` if it can't be fulfilled. |
| `supplier_cancelled` | CJ reported the order cancelled on their end (webhook or sweep 3 poll) while it was still active; format: `supplier_cancelled: CJ reports order cancelled (was <status>)`. | Confirm with CJ why it was cancelled. If it should still ship, `-> pending` to re-place (new idempotency key territory doesn't apply — same key, so this creates a *new* placeOrder attempt only if CJ genuinely has no record under that key anymore). If the order is truly dead, `-> cancelled` and refund/re-source via Shopify. |

## What each recovery transition actually re-enters

- **`needs_attention -> pending`**: full replan from scratch — re-checks every gate (mapping,
  stock, freight, cap, wallet, margin) against current settings/state before calling `placeOrder`
  again. Use this whenever the underlying blocker has been fixed (mapping added, wallet topped up,
  cap raised, address repaired, etc.).
- **`needs_attention -> confirmed`**: skips replanning and gate re-checks entirely — jumps straight
  to `enqueuePayOrder`. Only use this when the supplier-side order is already known-good (it exists,
  its total is acceptable) and all that's left is payment.
- **`needs_attention -> cancelled`**: terminal. No queue ever picks this row up again. Use this when
  the order will never be fulfilled through this pipeline (refund the customer / handle out of band).

Every transition above still goes through `applyTransition`'s legal-matrix check — a manual
`UPDATE` that skips the app entirely bypasses that check, so double-confirm the target status is
actually reachable (`needs_attention` can legally reach `pending`, `created`, `confirmed`, `paid`,
or `cancelled` — see `apps/ops/src/fulfillment/transitions.ts`) before writing it.
