import { describe, expect, it } from 'vitest'
import { deterministicVerdict, type ScoreMetrics, type VerdictThresholds } from '../src/scoring/verdict.js'

// deprecateAfterDays=21, minUnits28d=1, maxRefundRateBps=2500 (25%), refundRateMinOrders=4
const THRESHOLDS: VerdictThresholds = {
  deprecateAfterDays: 21,
  minUnits28d: 1,
  maxRefundRateBps: 2500,
  refundRateMinOrders: 4,
}

// A profile with no red flags on any rule: young product, decent volume, zero refunds.
const HEALTHY: ScoreMetrics = {
  unitsSold28d: 50,
  ordersWithProduct28d: 50,
  refundCount28d: 0,
  daysLive: 5,
  hasNullGidVariant: false,
}

describe('deterministicVerdict', () => {
  describe('rule 1: null-gid guard (checked before anything else)', () => {
    it('overrides a metrics profile that would otherwise be keep', () => {
      expect(deterministicVerdict(HEALTHY, THRESHOLDS)).toBe('keep')
      expect(deterministicVerdict({ ...HEALTHY, hasNullGidVariant: true }, THRESHOLDS)).toBe('watch')
    })

    it('overrides a metrics profile that would otherwise be deprecate', () => {
      const wouldDeprecate: ScoreMetrics = { ...HEALTHY, daysLive: 30, unitsSold28d: 0 }
      // Sanity check: without the null-gid flag this profile hits rule 2 and deprecates.
      expect(deterministicVerdict(wouldDeprecate, THRESHOLDS)).toBe('deprecate')
      expect(deterministicVerdict({ ...wouldDeprecate, hasNullGidVariant: true }, THRESHOLDS)).toBe('watch')
    })
  })

  describe('rule 2: deprecate on days-live + low units (first-match order, so results below can land in the rule 4 near-miss band instead of a clean keep)', () => {
    it('day 20 (below deprecateAfterDays) at units=1 does not hit the deprecate edge — falls into the near-miss band', () => {
      expect(deterministicVerdict({ ...HEALTHY, daysLive: 20, unitsSold28d: 1 }, THRESHOLDS)).toBe('watch')
    })

    it('day 21 (== deprecateAfterDays) at units=1 deprecates', () => {
      expect(deterministicVerdict({ ...HEALTHY, daysLive: 21, unitsSold28d: 1 }, THRESHOLDS)).toBe('deprecate')
    })

    it('units=2 (> minUnits28d) at day 21 does not deprecate — falls into the near-miss band', () => {
      expect(deterministicVerdict({ ...HEALTHY, daysLive: 21, unitsSold28d: 2 }, THRESHOLDS)).toBe('watch')
    })

    it('units=4 (clear of the near-miss band too) at day 21 is a clean keep', () => {
      expect(deterministicVerdict({ ...HEALTHY, daysLive: 21, unitsSold28d: 4 }, THRESHOLDS)).toBe('keep')
    })
  })

  describe('rule 3: deprecate on refund rate, guarded by min-orders', () => {
    it('24% refund rate (below the 25% max) does not deprecate — falls into the near-miss band', () => {
      expect(
        deterministicVerdict({ ...HEALTHY, refundCount28d: 24, ordersWithProduct28d: 100 }, THRESHOLDS),
      ).toBe('watch')
    })

    it('25% refund rate (== max, rule requires strictly >) does not deprecate — falls into the near-miss band', () => {
      expect(
        deterministicVerdict({ ...HEALTHY, refundCount28d: 25, ordersWithProduct28d: 100 }, THRESHOLDS),
      ).toBe('watch')
    })

    it('26% refund rate (> max) deprecates', () => {
      expect(
        deterministicVerdict({ ...HEALTHY, refundCount28d: 26, ordersWithProduct28d: 100 }, THRESHOLDS),
      ).toBe('deprecate')
    })

    it('min-orders guard: a high refund rate at 3 orders (< refundRateMinOrders) does not deprecate or watch', () => {
      // Guards the classic small-sample trap (e.g. 1 order + 1 refund reading as a 100%
      // refund rate): a rate computed from too few orders isn't trusted for rule 3 or 4.
      expect(
        deterministicVerdict({ ...HEALTHY, refundCount28d: 1, ordersWithProduct28d: 3 }, THRESHOLDS),
      ).toBe('keep')
    })

    it('min-orders guard boundary: the same rate at 4 orders (== refundRateMinOrders) is now trusted, landing in the near-miss band', () => {
      expect(
        deterministicVerdict({ ...HEALTHY, refundCount28d: 1, ordersWithProduct28d: 4 }, THRESHOLDS),
      ).toBe('watch')
    })
  })

  describe('rule 4: watch on near-miss bands', () => {
    describe('days-live + units band: daysLive >= deprecateAfterDays-7 && unitsSold28d <= minUnits28d+2', () => {
      it('both at the boundary (daysLive=14, units=3) → in band', () => {
        expect(deterministicVerdict({ ...HEALTHY, daysLive: 14, unitsSold28d: 3 }, THRESHOLDS)).toBe('watch')
      })

      it('daysLive one below the boundary (13) → not in band', () => {
        expect(deterministicVerdict({ ...HEALTHY, daysLive: 13, unitsSold28d: 3 }, THRESHOLDS)).toBe('keep')
      })

      it('units one above the boundary (4) → not in band', () => {
        expect(deterministicVerdict({ ...HEALTHY, daysLive: 14, unitsSold28d: 4 }, THRESHOLDS)).toBe('keep')
      })
    })

    describe('refund-rate band: [maxRefundRateBps/2, maxRefundRateBps] with enough orders', () => {
      it('just below the lower bound (12.49%) → not in band', () => {
        expect(
          deterministicVerdict({ ...HEALTHY, refundCount28d: 1249, ordersWithProduct28d: 10_000 }, THRESHOLDS),
        ).toBe('keep')
      })

      it('exactly the lower bound (12.50%) → in band', () => {
        expect(
          deterministicVerdict({ ...HEALTHY, refundCount28d: 1250, ordersWithProduct28d: 10_000 }, THRESHOLDS),
        ).toBe('watch')
      })

      it('exactly the upper bound (25.00%, == max) → in band, not deprecate', () => {
        expect(
          deterministicVerdict({ ...HEALTHY, refundCount28d: 2500, ordersWithProduct28d: 10_000 }, THRESHOLDS),
        ).toBe('watch')
      })
    })
  })

  describe('rule 5: keep', () => {
    it('a healthy product with no red flags keeps', () => {
      expect(deterministicVerdict(HEALTHY, THRESHOLDS)).toBe('keep')
    })
  })
})
