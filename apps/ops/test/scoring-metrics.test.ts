import {
  createDb, orders, products, productScores, productVariants, proposals, settings, supportTickets,
} from '@doge-buddy/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { computeProductScores } from '../src/scoring/metrics.ts'
import { createSettings } from '../src/settings.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

// A fixed UTC clock so every window/day-live/score_date assertion is deterministic.
const NOW = new Date('2026-08-26T12:00:00.000Z')
const SCORE_DATE = '2026-08-26'
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400 * 1000)

// The four scoring thresholds this file pins (== SETTINGS_DEFAULTS): deprecateAfterDays=21,
// minUnits28d=1, maxRefundRateBps=2500, refundRateMinOrders=4. Set explicitly in beforeAll so the
// verdicts are deterministic regardless of any leftover settings row, then removed in afterAll.
const SCORING_KEYS = [
  'scoring.deprecate_after_days', 'scoring.min_units_28d',
  'scoring.max_refund_rate_bps', 'scoring.refund_rate_min_orders',
] as const

// Unique numeric variant-id tails per run — Shopify's numeric id, mirrored into both the variant gid
// (`gid://shopify/ProductVariant/<tail>`) and the order line item's numeric `variant_id`.
let tailSeq = Math.floor(Math.random() * 1e9)
const nextTail = () => String((tailSeq += 7))

describe('computeProductScores', () => {
  const { db, pool } = createDb(url)
  const settingsStore = createSettings(db)

  const createdProductIds: string[] = []
  const createdOrderIds: string[] = []
  const createdProposalIds: string[] = []
  const createdTicketIds: string[] = []

  // Product ids + the sales product's variant tail, populated by the shared seed in beforeAll.
  let pDead = ''
  let pSales = ''
  let pNull = ''
  // FW-A / FW-B fixtures.
  let pCoA = '' // co-sold "other" product (refunded); shares 2 orders with pCoB
  let pCoB = '' // multi-product-refund victim: 4 orders, 2 shared-with-A (refunded), 2 B-only (clean)
  let pUnmapped = '' // one refunded order = this product + an UNMAPPED line item (still single-product)
  let pBadQty = '' // one matched order whose quantity is non-integer → contributes 0, no batch abort

  async function seedProduct(createdAt: Date): Promise<string> {
    const [row] = await db
      .insert(products)
      .values({
        shopifyProductGid: `gid://shopify/Product/${crypto.randomUUID()}`,
        handle: `h-${crypto.randomUUID()}`, title: 'Test Product', status: 'active', createdAt,
      })
      .returning({ id: products.id })
    createdProductIds.push(row!.id)
    return row!.id
  }

  /** Seeds a variant; a null tail seeds the NULL-gid case. Returns the numeric tail (or null). */
  async function seedVariant(productId: string, tail: string | null, priceCents: number): Promise<void> {
    await db.insert(productVariants).values({
      productId,
      shopifyVariantGid: tail === null ? null : `gid://shopify/ProductVariant/${tail}`,
      sku: `SKU-${crypto.randomUUID()}`, priceCents,
    })
  }

  /** Seeds an order carrying `rawPayload` verbatim (the real `orders/paid` shape), returns its row id. */
  async function seedOrder(opts: { isTest: boolean; paidAt: Date | null; rawPayload: unknown }): Promise<string> {
    const [row] = await db
      .insert(orders)
      .values({
        shopifyOrderGid: `gid://shopify/Order/${crypto.randomUUID()}`,
        isTest: opts.isTest, paidAt: opts.paidAt, rawPayload: opts.rawPayload as object,
      })
      .returning({ id: orders.id })
    createdOrderIds.push(row!.id)
    return row!.id
  }

  /** A realistic `orders/paid` payload with one line item for `tail` × `quantity`. */
  const payload = (tail: string, quantity: number) => ({
    admin_graphql_api_id: `gid://shopify/Order/${tail}`,
    test: false, total_price: '10.00',
    line_items: [{ variant_id: Number(tail), quantity }],
  })

  /** A payload with MULTIPLE line items (each `{ tail, qty }`) — used by the single-product-order
   *  refund-scoping tests. A `tail` with no seeded variant is an UNMAPPED line (maps to no product). */
  const payloadMulti = (items: { tail: string; qty: number }[]) => ({
    admin_graphql_api_id: `gid://shopify/Order/${crypto.randomUUID()}`,
    test: false, total_price: '10.00',
    line_items: items.map((it) => ({ variant_id: Number(it.tail), quantity: it.qty })),
  })

  async function seedAppliedRefund(orderId: string): Promise<void> {
    const [row] = await db
      .insert(proposals)
      .values({
        type: 'refund', status: 'applied', summary: 'refund', payload: {}, sourceWorkflow: 'test', orderId,
      })
      .returning({ id: proposals.id })
    createdProposalIds.push(row!.id)
  }

  async function seedTicket(orderId: string, createdAt: Date): Promise<void> {
    const [row] = await db
      .insert(supportTickets)
      .values({ gmailThreadId: `thr-${crypto.randomUUID()}`, orderId, createdAt })
      .returning({ id: supportTickets.id })
    createdTicketIds.push(row!.id)
  }

  beforeAll(async () => {
    for (const key of SCORING_KEYS) {
      const value =
        key === 'scoring.deprecate_after_days' ? 21
        : key === 'scoring.min_units_28d' ? 1
        : key === 'scoring.max_refund_rate_bps' ? 2500
        : 4
      await settingsStore.set(key, value)
    }

    const created30 = daysAgo(30)

    // 1) Dead product: 30 days live, zero in-window orders.
    pDead = await seedProduct(created30)
    await seedVariant(pDead, nextTail(), 1500)

    // 2) Sales product: 5 units across 3 paid non-test orders (A/B in the 7d window, C only in 28d),
    //    one of them (A) refunded, one ticket on B. Plus three orders that must NOT count:
    //    a test order, a thin (NULL raw_payload) order, and a malformed (object line_items) order.
    pSales = await seedProduct(created30)
    const salesTail = nextTail()
    await seedVariant(pSales, salesTail, 1000)

    const orderA = await seedOrder({ isTest: false, paidAt: daysAgo(1), rawPayload: payload(salesTail, 2) })
    await seedOrder({ isTest: false, paidAt: daysAgo(3), rawPayload: payload(salesTail, 2) }) // B
    await seedOrder({ isTest: false, paidAt: daysAgo(20), rawPayload: payload(salesTail, 1) }) // C
    const orderB = createdOrderIds[createdOrderIds.length - 2]!

    // Excluded / guarded orders in the same batch:
    await seedOrder({ isTest: true, paidAt: daysAgo(1), rawPayload: payload(salesTail, 99) }) // test → excluded
    await seedOrder({ isTest: false, paidAt: daysAgo(1), rawPayload: null }) // thin/NULL raw_payload → 0
    await seedOrder({ // malformed line_items (object, not array) → 0, must not abort the batch
      isTest: false, paidAt: daysAgo(1),
      rawPayload: { line_items: { variant_id: Number(salesTail), quantity: 99 } },
    })

    await seedAppliedRefund(orderA)
    await seedTicket(orderB, daysAgo(2))

    // 3) Null-gid product: 30 days live, a real variant AND a NULL-gid variant → forced `watch`.
    pNull = await seedProduct(created30)
    await seedVariant(pNull, nextTail(), 1000)
    await seedVariant(pNull, null, 1000)

    // 4) FW-A co-sold products. B is sold in 4 in-window orders (all 30d live). Two of those ALSO
    //    contain A and are refunded; B is never refunded on a B-only order. Under any-order refund
    //    attribution B reads 2 refunds / 4 orders = 50% → deprecate. Single-product-order scoping
    //    drops the 2 shared orders → B is 0 refunds / 2 orders → keep.
    pCoA = await seedProduct(created30)
    const tailA = nextTail()
    await seedVariant(pCoA, tailA, 1000)
    pCoB = await seedProduct(created30)
    const tailB = nextTail()
    await seedVariant(pCoB, tailB, 1000)

    await seedOrder({ isTest: false, paidAt: daysAgo(2), rawPayload: payloadMulti([{ tail: tailB, qty: 1 }]) }) // B-only
    await seedOrder({ isTest: false, paidAt: daysAgo(2), rawPayload: payloadMulti([{ tail: tailB, qty: 1 }]) }) // B-only
    const shared1 = await seedOrder({ isTest: false, paidAt: daysAgo(2), rawPayload: payloadMulti([{ tail: tailA, qty: 1 }, { tail: tailB, qty: 1 }]) })
    const shared2 = await seedOrder({ isTest: false, paidAt: daysAgo(2), rawPayload: payloadMulti([{ tail: tailA, qty: 1 }, { tail: tailB, qty: 1 }]) })
    await seedAppliedRefund(shared1)
    await seedAppliedRefund(shared2)

    // 5) FW-A unmapped-line product: one refunded order = this product + a line item whose variant_id
    //    maps to NO product. The unmapped line must NOT disqualify the order as single-product.
    pUnmapped = await seedProduct(created30)
    const tailU = nextTail()
    await seedVariant(pUnmapped, tailU, 1000)
    const unmappedTail = nextTail() // never seeded as a variant → maps to nothing
    const uOrder = await seedOrder({ isTest: false, paidAt: daysAgo(2), rawPayload: payloadMulti([{ tail: tailU, qty: 1 }, { tail: unmappedTail, qty: 1 }]) })
    await seedAppliedRefund(uOrder)

    // 6) FW-B non-integer quantity on a MATCHED line: must contribute 0 units and NOT abort the batch.
    pBadQty = await seedProduct(created30)
    const tailBad = nextTail()
    await seedVariant(pBadQty, tailBad, 1000)
    await seedOrder({
      isTest: false, paidAt: daysAgo(2),
      rawPayload: {
        admin_graphql_api_id: `gid://shopify/Order/${crypto.randomUUID()}`, test: false, total_price: '10.00',
        line_items: [{ variant_id: Number(tailBad), quantity: 'abc' }],
      },
    })
  })

  afterAll(async () => {
    if (createdProductIds.length) {
      await db.delete(productScores).where(inArray(productScores.productId, createdProductIds))
    }
    if (createdTicketIds.length) {
      await db.delete(supportTickets).where(inArray(supportTickets.id, createdTicketIds))
    }
    if (createdProposalIds.length) {
      await db.delete(proposals).where(inArray(proposals.id, createdProposalIds))
    }
    if (createdOrderIds.length) {
      await db.delete(orders).where(inArray(orders.id, createdOrderIds))
    }
    if (createdProductIds.length) {
      await db.delete(productVariants).where(inArray(productVariants.productId, createdProductIds))
      await db.delete(products).where(inArray(products.id, createdProductIds))
    }
    await db.delete(settings).where(inArray(settings.key, SCORING_KEYS as unknown as string[]))
    await pool.end()
  })

  async function run(now = NOW) {
    const alert = vi.fn(async () => {})
    const rows = await computeProductScores({ db, alert, settings: settingsStore }, now)
    return { rows, alert }
  }
  const rowFor = (rows: Awaited<ReturnType<typeof run>>['rows'], productId: string) =>
    rows.find((r) => r.productId === productId)

  async function persisted(productId: string, scoreDate = SCORE_DATE) {
    const found = await db
      .select()
      .from(productScores)
      .where(and(eq(productScores.productId, productId), eq(productScores.scoreDate, scoreDate)))
    return found
  }

  it('dead product (30d live, 0 in-window orders) → all zeros, verdict deprecate', async () => {
    const { rows } = await run()
    const r = rowFor(rows, pDead)
    expect(r).toBeDefined()
    expect(r).toMatchObject({
      scoreDate: SCORE_DATE, unitsSold7d: 0, unitsSold28d: 0, revenue28dCents: 0,
      ordersWithProduct28d: 0, refundCount28d: 0, ticketCount28d: 0, daysLive: 30,
      hasNullGidVariant: false, verdict: 'deprecate',
    })
  })

  it('sales product → units 5 (7d=4), revenue 5000, orders 3, refund 1, ticket 1, verdict keep', async () => {
    const { rows } = await run()
    const r = rowFor(rows, pSales)
    expect(r).toMatchObject({
      unitsSold7d: 4, // A(2) + B(2); C(1) is only in the 28d window
      unitsSold28d: 5, // + C(1); the is_test/thin/malformed orders contribute 0
      revenue28dCents: 5000, // 5 units × 1000c
      ordersWithProduct28d: 3, // A, B, C (distinct in-window paid orders)
      refundCount28d: 1, // only A has an applied refund proposal
      ticketCount28d: 1, // one ticket linked to B
      daysLive: 30, hasNullGidVariant: false, verdict: 'keep',
    })
  })

  it('excluded/guarded orders never inflate metrics and the batch completes (no throw)', async () => {
    // The whole seed ran (a malformed object-line_items order is in the batch); reaching here at all
    // proves the guarded lateral did not abort. The unit count nails the exclusions numerically.
    const { rows } = await run()
    expect(rowFor(rows, pSales)!.unitsSold28d).toBe(5)
  })

  it('null-gid product → hasNullGidVariant true, verdict watch, warning alert fired', async () => {
    const { rows, alert } = await run()
    const r = rowFor(rows, pNull)
    expect(r).toMatchObject({ hasNullGidVariant: true, daysLive: 30, verdict: 'watch' })
    expect(alert).toHaveBeenCalledWith('warning', 'scoring_null_gid_variant', { productId: pNull })
    // The alert fires ONLY for the null-gid product, not the clean ones.
    expect(alert).toHaveBeenCalledTimes(1)
  })

  it('persists rows with score left NULL and verdict written', async () => {
    await run()
    const [salesRow] = await persisted(pSales)
    expect(salesRow).toBeDefined()
    expect(salesRow!.score).toBeNull()
    expect(salesRow!.verdict).toBe('keep')
    expect(salesRow!.unitsSold28d).toBe(5)
    expect(salesRow!.refundCount28d).toBe(1)
  })

  it('re-running the same now is idempotent (single row per product/date)', async () => {
    await run()
    await run()
    expect(await persisted(pSales)).toHaveLength(1)
    expect(await persisted(pDead)).toHaveLength(1)
    expect(await persisted(pNull)).toHaveLength(1)
  })

  it('FW-A: a multi-product refund does NOT attribute to a co-sold, never-refunded product', async () => {
    const { rows } = await run()
    const r = rowFor(rows, pCoB)
    expect(r).toMatchObject({
      unitsSold28d: 4, // all 4 orders contain B — per-line sums are NOT single-product-scoped
      ordersWithProduct28d: 2, // only the 2 B-only orders; the 2 shared-with-A orders are excluded
      refundCount28d: 0, // the refunds sit on the shared orders, which B's single-product scope drops
      verdict: 'keep', // under any-order attribution this would read 2/4 = 50% → deprecate
    })
  })

  it('FW-A: a refund on a product\'s OWN single-product order still counts (regression)', async () => {
    const { rows } = await run()
    // pSales orderA is a single-product order AND refunded → still counted under single-product scoping.
    expect(rowFor(rows, pSales)).toMatchObject({ ordersWithProduct28d: 3, refundCount28d: 1 })
  })

  it('FW-A: an unmapped co-line does not disqualify an order as single-product', async () => {
    const { rows } = await run()
    // The order carries this product + a line mapping to no product; unmapped ≠ another product.
    expect(rowFor(rows, pUnmapped)).toMatchObject({ unitsSold28d: 1, ordersWithProduct28d: 1, refundCount28d: 1 })
  })

  it('FW-B: a non-integer quantity on a matched line contributes 0 and does not abort the batch', async () => {
    const { rows } = await run()
    // Reaching here at all proves the safe quantity cast did not throw and abort the nightly run.
    expect(rowFor(rows, pBadQty)!.unitsSold28d).toBe(0)
    expect(rowFor(rows, pSales)!.unitsSold28d).toBe(5) // other products still score
  })

  it('score_date is UTC-pinned: a non-UTC DB session timezone does not shift the day', async () => {
    // Run under a +14 session TZ with a `now` late in the UTC day. `now()::date` would read the NEXT
    // calendar day under +14; the module computes score_date in JS (UTC), so it must stay on 08-27.
    const boundaryNow = new Date('2026-08-27T23:30:00.000Z')
    const tzScoreDate = '2026-08-27'
    const { db: db2, pool: pool2 } = createDb(url, { max: 1 })
    try {
      await db2.execute(sql`SET TIME ZONE 'Pacific/Kiritimati'`)
      const alert = vi.fn(async () => {})
      const rows = await computeProductScores({ db: db2, alert, settings: createSettings(db2) }, boundaryNow)
      expect(rowFor(rows, pDead)!.scoreDate).toBe(tzScoreDate)
      const [row] = await db
        .select()
        .from(productScores)
        .where(and(eq(productScores.productId, pDead), eq(productScores.scoreDate, tzScoreDate)))
      expect(row).toBeDefined()
      // And nothing landed on the +14 local day.
      const wrongDay = await db
        .select()
        .from(productScores)
        .where(and(eq(productScores.productId, pDead), eq(productScores.scoreDate, '2026-08-28')))
      expect(wrongDay).toHaveLength(0)
    } finally {
      await pool2.end()
    }
  })
})
