import type { Address, ShippingOption, WarehouseStock } from '@doge-buddy/supplier'
import { describe, expect, it } from 'vitest'
import { planFulfillment, type FulfillmentInputs } from '../src/fulfillment/plan.ts'

const ADDRESS: Address = {
  name: 'Ada Lovelace',
  line1: '123 Analytical Engine Way',
  city: 'Springfield',
  state: 'IL',
  zip: '62701',
  country: 'US',
}

const VARIANT_1 = 'gid://shopify/ProductVariant/1'
const VARIANT_2 = 'gid://shopify/ProductVariant/2'

/** Fully-valid input that clears gates 1-3 (and, for now, falls through the temporary proceed stub). */
function baseInputs(): FulfillmentInputs {
  const mappings = new Map<string, { supplierVariantId: string; supplierCostCents: number }>([
    [VARIANT_1, { supplierVariantId: 'sv-1', supplierCostCents: 500 }],
    [VARIANT_2, { supplierVariantId: 'sv-2', supplierCostCents: 800 }],
  ])
  const stock = new Map<string, WarehouseStock[]>([
    ['sv-1', [{ countryCode: 'US', quantity: 50, verified: true }]],
    ['sv-2', [{ countryCode: 'US', quantity: 50, verified: true }]],
  ])
  const freightOptions: ShippingOption[] = [{ name: 'standard', priceCents: 500, minDays: 3, maxDays: 5 }]

  return {
    order: {
      isTest: false,
      totalCents: 5000,
      shippingAddress: ADDRESS,
      lineItems: [
        { variantGid: VARIANT_1, quantity: 1 },
        { variantGid: VARIANT_2, quantity: 2 },
      ],
    },
    settings: {
      killswitch: false,
      fulfillmentEnabled: true,
      pausedForFunds: false,
      spendCapPerOrderCents: 10_000,
      marginFloorBps: 2000,
      promisedMaxDays: 10,
    },
    mappings,
    stock,
    freightOptions,
    walletAvailableCents: 100_000,
  }
}

function withSettings(patch: Partial<FulfillmentInputs['settings']>): FulfillmentInputs {
  const base = baseInputs()
  return { ...base, settings: { ...base.settings, ...patch } }
}

function withoutMappingFor(variantGid: string): FulfillmentInputs {
  const base = baseInputs()
  const mappings = new Map(base.mappings)
  mappings.delete(variantGid)
  return { ...base, mappings }
}

function withStock(overrides: Record<string, WarehouseStock[]>): FulfillmentInputs {
  const base = baseInputs()
  const stock = new Map(base.stock)
  for (const [supplierVariantId, entries] of Object.entries(overrides)) {
    stock.set(supplierVariantId, entries)
  }
  return { ...base, stock }
}

function withFreightOptions(freightOptions: ShippingOption[]): FulfillmentInputs {
  return { ...baseInputs(), freightOptions }
}

function withOrderTotalCents(totalCents: number): FulfillmentInputs {
  const base = baseInputs()
  return { ...base, order: { ...base.order, totalCents } }
}

function withWalletAvailableCents(walletAvailableCents: number): FulfillmentInputs {
  return { ...baseInputs(), walletAvailableCents }
}

describe('planFulfillment', () => {
  it('gate 1: is_test wins over everything', () => {
    expect(planFulfillment({ ...baseInputs(), order: { ...baseInputs().order, isTest: true } })).toEqual({
      kind: 'skip_test',
    })
  })

  it.each([
    ['killswitch', { killswitch: true }],
    ['fulfillment_disabled', { fulfillmentEnabled: false }],
  ] as const)('gate 2: %s → requeue with 300s delay', (reason, patch) => {
    const d = planFulfillment(withSettings(patch))
    expect(d).toEqual({ kind: 'requeue', reason, delaySeconds: 300 })
  })

  // Expanded from the brief's compressed it.each third row: pausedForFunds defaults to false in
  // baseInputs(), so this case sets it to true explicitly rather than patching with `{}`.
  it('gate 2: paused_for_funds → requeue with 300s delay', () => {
    const d = planFulfillment(withSettings({ pausedForFunds: true }))
    expect(d).toEqual({ kind: 'requeue', reason: 'paused_for_funds', delaySeconds: 300 })
  })

  it('gate 3: any unmapped line item → needs_attention naming the variant', () => {
    const d = planFulfillment(withoutMappingFor(VARIANT_2))
    expect(d).toMatchObject({ kind: 'needs_attention', reason: 'unmapped_item' })
    expect((d as { detail: string }).detail).toContain(VARIANT_2)
  })

  it('happy path: gates 1-6 all pass → full proceed payload', () => {
    // supplierItemsCents = 500*1 + 800*2 = 2100; freight = 500 (only option, 5 <= promisedMaxDays 10);
    // projectedTotalCents = 2600; margin = floor((5000-2600)*10000/5000) = 4800bps >= floor 2000bps.
    const d = planFulfillment(baseInputs())
    expect(d).toEqual({
      kind: 'proceed',
      logisticName: 'standard',
      freightCents: 500,
      supplierItemsCents: 2100,
      projectedTotalCents: 2600,
      items: [
        { supplierVariantId: 'sv-1', quantity: 1 },
        { supplierVariantId: 'sv-2', quantity: 2 },
      ],
    })
  })

  describe('gate 4: US stock', () => {
    it('no US stock entry at all → no_us_stock', () => {
      const d = planFulfillment(withStock({ 'sv-1': [{ countryCode: 'CN', quantity: 999, verified: true }] }))
      expect(d).toMatchObject({ kind: 'needs_attention', reason: 'no_us_stock' })
      expect((d as { detail: string }).detail).toContain('sv-1')
    })

    it('US entry exists but quantity is insufficient → stockout', () => {
      const d = planFulfillment(withStock({ 'sv-2': [{ countryCode: 'US', quantity: 1, verified: true }] }))
      expect(d).toMatchObject({ kind: 'needs_attention', reason: 'stockout' })
      expect((d as { detail: string }).detail).toContain('sv-2')
    })

    it('sums needed quantity per supplier variant across line items before checking stock', () => {
      // Two distinct line items both map to sv-1: 3 + 4 = 7 needed, but only 6 in stock. Neither
      // line item alone (3 or 4) would exceed 6 — only the aggregated demand does.
      const base = baseInputs()
      const VARIANT_3 = 'gid://shopify/ProductVariant/3'
      const mappings = new Map(base.mappings)
      mappings.set(VARIANT_3, { supplierVariantId: 'sv-1', supplierCostCents: 500 })
      const stock = new Map(base.stock)
      stock.set('sv-1', [{ countryCode: 'US', quantity: 6, verified: true }])
      const inputs: FulfillmentInputs = {
        ...base,
        mappings,
        stock,
        order: {
          ...base.order,
          lineItems: [
            { variantGid: VARIANT_1, quantity: 3 },
            { variantGid: VARIANT_3, quantity: 4 },
          ],
        },
      }
      const d = planFulfillment(inputs)
      expect(d).toMatchObject({ kind: 'needs_attention', reason: 'stockout' })
    })
  })

  describe('gate 5: freight window', () => {
    it('no freight option lands within promisedMaxDays → no_freight_in_window', () => {
      const d = planFulfillment(withSettings({ promisedMaxDays: 2 })) // base option has maxDays 5
      expect(d).toMatchObject({ kind: 'needs_attention', reason: 'no_freight_in_window' })
    })

    it('empty freightOptions → no_freight_in_window (no silent fallback)', () => {
      const d = planFulfillment(withFreightOptions([]))
      expect(d).toMatchObject({ kind: 'needs_attention', reason: 'no_freight_in_window' })
    })

    it('boundary: maxDays === promisedMaxDays is eligible', () => {
      const d = planFulfillment(withSettings({ promisedMaxDays: 5 })) // base option maxDays is exactly 5
      expect(d).toMatchObject({ kind: 'proceed', logisticName: 'standard', freightCents: 500 })
    })

    it('cheaper-but-too-slow option is ignored in favor of the cheapest option within the window', () => {
      const d = planFulfillment(
        withFreightOptions([
          { name: 'cheap-slow', priceCents: 100, minDays: 10, maxDays: 20 },
          { name: 'pricier-fast', priceCents: 900, minDays: 2, maxDays: 5 },
        ]),
      )
      expect(d).toMatchObject({ kind: 'proceed', logisticName: 'pricier-fast', freightCents: 900 })
    })

    it('ties on priceCents among eligible options pick the first', () => {
      const d = planFulfillment(
        withFreightOptions([
          { name: 'A', priceCents: 500, minDays: 3, maxDays: 5 },
          { name: 'B', priceCents: 500, minDays: 1, maxDays: 3 },
        ]),
      )
      expect(d).toMatchObject({ kind: 'proceed', logisticName: 'A', freightCents: 500 })
    })
  })

  describe('gate 6: money', () => {
    it('projected total over spend cap → cap_exceeded', () => {
      const d = planFulfillment(withSettings({ spendCapPerOrderCents: 2000 })) // projected is 2600
      expect(d).toMatchObject({ kind: 'needs_attention', reason: 'cap_exceeded' })
    })

    it('boundary: projected total exactly == spend cap passes', () => {
      const d = planFulfillment(withSettings({ spendCapPerOrderCents: 2600 })) // projected is 2600
      expect(d.kind).toBe('proceed')
    })

    it('projected total under cap but over wallet balance → wallet_insufficient', () => {
      const d = planFulfillment(withWalletAvailableCents(2000)) // projected is 2600, cap is 10_000
      expect(d).toMatchObject({ kind: 'needs_attention', reason: 'wallet_insufficient' })
    })

    it('cap check runs before the wallet check when both would fail', () => {
      const base = baseInputs()
      const inputs: FulfillmentInputs = {
        ...base,
        settings: { ...base.settings, spendCapPerOrderCents: 100 },
        walletAvailableCents: 50,
      }
      const d = planFulfillment(inputs)
      expect(d).toMatchObject({ kind: 'needs_attention', reason: 'cap_exceeded' })
    })

    it('margin below floor → margin_below_floor (the price-drift trap)', () => {
      // projected stays 2600; totalCents 3000 → margin = floor(400*10000/3000) = 1333bps < 1500bps floor.
      const base = baseInputs()
      const inputs: FulfillmentInputs = {
        ...base,
        order: { ...base.order, totalCents: 3000 },
        settings: { ...base.settings, marginFloorBps: 1500 },
      }
      const d = planFulfillment(inputs)
      expect(d).toMatchObject({ kind: 'needs_attention', reason: 'margin_below_floor' })
    })

    it('boundary: margin exactly == floor passes', () => {
      // Base scenario's margin is exactly 4800bps (see happy-path comment); set the floor to match.
      const d = planFulfillment(withSettings({ marginFloorBps: 4800 }))
      expect(d.kind).toBe('proceed')
    })
  })
})
