export interface ScoreMetrics {
  unitsSold28d: number
  ordersWithProduct28d: number
  refundCount28d: number
  daysLive: number
  hasNullGidVariant: boolean
}

export interface VerdictThresholds {
  deprecateAfterDays: number
  minUnits28d: number
  maxRefundRateBps: number
  refundRateMinOrders: number
}

/** Matches the `score_verdict` pg enum (packages/db schema) verbatim. */
export type Verdict = 'keep' | 'watch' | 'deprecate'

/**
 * Deterministic verdict rules (spec §2), evaluated in order — first match wins,
 * so `deprecate` dominates `watch` wherever both conditions would otherwise apply:
 *
 *   1. Data-quality guard: any NULL-gid variant -> 'watch' (unit metrics are
 *      untrustworthy; the caller also emits a warning alert). Checked before
 *      anything else, so it overrides what would otherwise be a 'keep' *or* a
 *      'deprecate'.
 *   2. 'deprecate' when the product has been live long enough with low sales:
 *      daysLive >= deprecateAfterDays && unitsSold28d <= minUnits28d.
 *   3. 'deprecate' when the refund rate exceeds the max, but only once there's
 *      enough order volume to trust the rate — this guards against small-sample
 *      noise (e.g. 1 order + 1 refund reading as a 100% refund rate):
 *      ordersWithProduct28d >= refundRateMinOrders && refundRate(bps) > maxRefundRateBps.
 *   4. 'watch' on a near-miss of either deprecate rule:
 *        - daysLive >= deprecateAfterDays-7 && unitsSold28d <= minUnits28d+2, OR
 *        - refund rate in [maxRefundRateBps/2, maxRefundRateBps] with enough orders.
 *   5. otherwise 'keep'.
 *
 * Refund rate is integer bps (refundCount28d * 10000 / ordersWithProduct28d). All
 * comparisons are done via cross-multiplication rather than division, so there's
 * no float drift and no division-by-zero when ordersWithProduct28d is 0.
 */
export function deterministicVerdict(m: ScoreMetrics, t: VerdictThresholds): Verdict {
  if (m.hasNullGidVariant) return 'watch'

  if (m.daysLive >= t.deprecateAfterDays && m.unitsSold28d <= t.minUnits28d) {
    return 'deprecate'
  }

  const hasEnoughOrders = m.ordersWithProduct28d >= t.refundRateMinOrders

  // refundCount/orders > maxBps/10000  <=>  refundCount*10000 > maxBps*orders
  const refundRateAboveMax =
    hasEnoughOrders && m.refundCount28d * 10000 > t.maxRefundRateBps * m.ordersWithProduct28d

  if (refundRateAboveMax) return 'deprecate'

  const nearMissDaysUnits = m.daysLive >= t.deprecateAfterDays - 7 && m.unitsSold28d <= t.minUnits28d + 2

  // refundCount/orders in [maxBps/2, maxBps]. The lower-bound check is scaled by
  // an extra factor of 2 so it stays integer-safe without assuming maxBps is even:
  //   refundCount/orders >= maxBps/2  <=>  refundCount*20000 >= maxBps*orders
  const nearMissRefundRate =
    hasEnoughOrders &&
    m.refundCount28d * 20000 >= t.maxRefundRateBps * m.ordersWithProduct28d &&
    m.refundCount28d * 10000 <= t.maxRefundRateBps * m.ordersWithProduct28d

  if (nearMissDaysUnits || nearMissRefundRate) return 'watch'

  return 'keep'
}
