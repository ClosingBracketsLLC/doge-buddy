import { type createDb, productScores } from '@doge-buddy/db'
import { sql } from 'drizzle-orm'
import { type Settings } from '../settings.ts'
import { deterministicVerdict, type Verdict, type VerdictThresholds } from './verdict.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

export interface ProductScoreRow {
  productId: string
  scoreDate: string // 'YYYY-MM-DD' UTC
  unitsSold7d: number
  unitsSold28d: number
  revenue28dCents: number
  ordersWithProduct28d: number
  refundCount28d: number
  ticketCount28d: number
  daysLive: number
  hasNullGidVariant: boolean
  verdict: Verdict
}

/** Shape of one row returned by the metric SQL (all counts already cast to int4 → JS numbers). The
 *  index signature satisfies `db.execute<T extends Record<string, unknown>>`. */
interface MetricSqlRow {
  product_id: string
  units_sold_7d: number
  units_sold_28d: number
  revenue_28d_cents: number
  orders_with_product_28d: number
  refund_count_28d: number
  ticket_count_28d: number
  days_live: number
  has_null_gid_variant: boolean
  [key: string]: unknown
}

/**
 * Computes and UPSERTS one `product_scores` row per **active** product for `now`'s UTC date, then
 * returns the rows (for the handler's health/logging). Emits a `warning` alert per null-gid product.
 *
 * Everything is UTC and clock-injected: `score_date = now.toISOString().slice(0,10)` and the 7d/28d
 * window bounds are computed in JS as absolute instants (`now − Nd`) and bound as `::timestamptz`
 * parameters — never `now()::date`, which would follow the DB session timezone and can duplicate-row
 * a UTC day.
 *
 * The metric SQL is a single bounded pass keyed on each active product's variants:
 *
 *  - **Units / revenue / orders (`line_matches`):** paid, non-test orders whose `raw_payload.line_items`
 *    reference this product's variants, within the 28d window. The order→variant join is a
 *    FIXTURE-ASSUMPTION (no real orders exist yet): the webhook line item carries Shopify's *numeric*
 *    `variant_id` (`order-upsert.ts`) while `product_variants.shopify_variant_gid` is the *gid*, so we
 *    match `(li->>'variant_id')` against the numeric tail of the gid. There is deliberately **no
 *    `financial_status` predicate** — that column is never populated; a paid-webhook order's existence
 *    plus a non-null `paid_at` in the window IS the paid signal.
 *  - **Guarded jsonb expansion:** the lateral argument is wrapped in a `CASE … jsonb_typeof(...) =
 *    'array'` so a thin/NULL `raw_payload` or a malformed (object-not-array) `line_items` yields an
 *    empty expansion and contributes 0 — it must NOT abort the whole nightly batch. (The narrower
 *    `LEFT JOIN LATERAL jsonb_array_elements(x) ON jsonb_typeof(x)='array'` does NOT work: Postgres
 *    evaluates the set-returning function *before* applying the ON filter, so it still throws
 *    `cannot extract elements from an object` — verified against PG 17.)
 *  - **`refund_count_28d`:** DISTINCT in-window orders containing this product that have an `applied`
 *    `refund` proposal. Because `line_matches` is already 28d-windowed, the numerator shares the same
 *    clock as the `orders_with_product_28d` denominator — both are ORDER counts (never units/proposals),
 *    which is what the §2 refund-rate rule expects.
 *  - **`ticket_count_28d`:** `support_tickets` (created_at in the 28d window) whose `order_id` is one of
 *    this product's in-window orders.
 *  - **`days_live`:** `floor((now − products.created_at) / 1 day)`, UTC.
 *  - **`has_null_gid_variant`:** EXISTS any variant of the product with a NULL `shopify_variant_gid`.
 *
 * The verdict is `deterministicVerdict(...)` over the settings-tuned thresholds; `product_scores.score`
 * is intentionally left NULL (the design is categorical). The upsert on `(product_id, score_date)` makes
 * a same-`now` re-run idempotent (single row per product per UTC day).
 */
export async function computeProductScores(
  deps: { db: Db; alert: Alert; settings: Settings },
  now: Date,
): Promise<ProductScoreRow[]> {
  const { db, alert, settings } = deps

  const scoreDate = now.toISOString().slice(0, 10)
  const nowIso = now.toISOString()
  const win7Iso = new Date(now.getTime() - 7 * 86_400 * 1000).toISOString()
  const win28Iso = new Date(now.getTime() - 28 * 86_400 * 1000).toISOString()

  const [deprecateAfterDays, minUnits28d, maxRefundRateBps, refundRateMinOrders] = await Promise.all([
    settings.get('scoring.deprecate_after_days'),
    settings.get('scoring.min_units_28d'),
    settings.get('scoring.max_refund_rate_bps'),
    settings.get('scoring.refund_rate_min_orders'),
  ])
  const thresholds: VerdictThresholds = { deprecateAfterDays, minUnits28d, maxRefundRateBps, refundRateMinOrders }

  const result = await db.execute<MetricSqlRow>(sql`
    WITH params AS (
      SELECT
        ${nowIso}::timestamptz AS now_ts,
        ${win7Iso}::timestamptz AS win7,
        ${win28Iso}::timestamptz AS win28
    ),
    active AS (
      SELECT p.id AS product_id, p.created_at
      FROM products p
      WHERE p.status = 'active'
    ),
    line_matches AS (
      SELECT pv.product_id, o.id AS order_id, o.paid_at,
             (li->>'quantity')::int AS qty, pv.price_cents
      FROM orders o
      LEFT JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(o.raw_payload->'line_items') = 'array'
             THEN o.raw_payload->'line_items'
             ELSE '[]'::jsonb END
      ) li ON true
      JOIN product_variants pv
        ON pv.shopify_variant_gid IS NOT NULL
       AND (li->>'variant_id') = regexp_replace(pv.shopify_variant_gid, '^.*/', '')
      JOIN active a ON a.product_id = pv.product_id
      CROSS JOIN params
      WHERE o.is_test = false
        AND o.paid_at IS NOT NULL
        AND o.paid_at >= params.win28
        AND o.paid_at <= params.now_ts
    ),
    units AS (
      SELECT lm.product_id,
        COALESCE(SUM(lm.qty) FILTER (WHERE lm.paid_at >= params.win7), 0)::int AS units_sold_7d,
        COALESCE(SUM(lm.qty), 0)::int AS units_sold_28d,
        COALESCE(SUM(lm.qty * lm.price_cents), 0)::int AS revenue_28d_cents,
        COUNT(DISTINCT lm.order_id)::int AS orders_with_product_28d
      FROM line_matches lm CROSS JOIN params
      GROUP BY lm.product_id
    ),
    refunds AS (
      SELECT lm.product_id, COUNT(DISTINCT lm.order_id)::int AS refund_count_28d
      FROM line_matches lm
      WHERE EXISTS (
        SELECT 1 FROM proposals pr
        WHERE pr.type = 'refund' AND pr.status = 'applied' AND pr.order_id = lm.order_id
      )
      GROUP BY lm.product_id
    ),
    tickets AS (
      SELECT po.product_id, COUNT(DISTINCT st.id)::int AS ticket_count_28d
      FROM (SELECT DISTINCT product_id, order_id FROM line_matches) po
      JOIN support_tickets st ON st.order_id = po.order_id
      CROSS JOIN params
      WHERE st.created_at >= params.win28 AND st.created_at <= params.now_ts
      GROUP BY po.product_id
    )
    SELECT a.product_id,
      COALESCE(u.units_sold_7d, 0) AS units_sold_7d,
      COALESCE(u.units_sold_28d, 0) AS units_sold_28d,
      COALESCE(u.revenue_28d_cents, 0) AS revenue_28d_cents,
      COALESCE(u.orders_with_product_28d, 0) AS orders_with_product_28d,
      COALESCE(r.refund_count_28d, 0) AS refund_count_28d,
      COALESCE(t.ticket_count_28d, 0) AS ticket_count_28d,
      GREATEST(0, floor(EXTRACT(EPOCH FROM (params.now_ts - a.created_at)) / 86400))::int AS days_live,
      EXISTS (
        SELECT 1 FROM product_variants v
        WHERE v.product_id = a.product_id AND v.shopify_variant_gid IS NULL
      ) AS has_null_gid_variant
    FROM active a
    CROSS JOIN params
    LEFT JOIN units u   ON u.product_id = a.product_id
    LEFT JOIN refunds r ON r.product_id = a.product_id
    LEFT JOIN tickets t ON t.product_id = a.product_id
  `)

  const rows: ProductScoreRow[] = result.rows.map((m) => {
    const hasNullGidVariant = m.has_null_gid_variant
    const verdict = deterministicVerdict(
      {
        unitsSold28d: m.units_sold_28d,
        ordersWithProduct28d: m.orders_with_product_28d,
        refundCount28d: m.refund_count_28d,
        daysLive: m.days_live,
        hasNullGidVariant,
      },
      thresholds,
    )
    return {
      productId: m.product_id,
      scoreDate,
      unitsSold7d: m.units_sold_7d,
      unitsSold28d: m.units_sold_28d,
      revenue28dCents: m.revenue_28d_cents,
      ordersWithProduct28d: m.orders_with_product_28d,
      refundCount28d: m.refund_count_28d,
      ticketCount28d: m.ticket_count_28d,
      daysLive: m.days_live,
      hasNullGidVariant,
      verdict,
    }
  })

  // Upsert one row per product per UTC day (idempotent on re-run of the same `now`). `score` stays NULL.
  for (const r of rows) {
    const values = {
      productId: r.productId,
      scoreDate: r.scoreDate,
      unitsSold7d: r.unitsSold7d,
      unitsSold28d: r.unitsSold28d,
      revenue28dCents: r.revenue28dCents,
      refundCount28d: r.refundCount28d,
      ticketCount28d: r.ticketCount28d,
      daysLive: r.daysLive,
      verdict: r.verdict,
    }
    await db
      .insert(productScores)
      .values(values)
      .onConflictDoUpdate({ target: [productScores.productId, productScores.scoreDate], set: values })
  }

  // A null-gid variant makes the unit metrics untrustworthy (they read as zero); the verdict is already
  // forced to `watch` by `deterministicVerdict`, and we page a warning so the missing gid gets backfilled.
  for (const r of rows) {
    if (r.hasNullGidVariant) {
      await alert('warning', 'scoring_null_gid_variant', { productId: r.productId })
    }
  }

  return rows
}
