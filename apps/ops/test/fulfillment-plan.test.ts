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

  it('falls through to a proceed decision when gates 1-3 all pass (temporary stub for this task)', () => {
    const d = planFulfillment(baseInputs())
    expect(d.kind).toBe('proceed')
  })
})
