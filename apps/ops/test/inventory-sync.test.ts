import { auditLog, createDb, products, productVariants, supplierVariantMappings } from '@doge-buddy/db'
import type { WarehouseStock } from '@doge-buddy/supplier'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { PointsAllowance } from '../src/agents/points.ts'
import {
  executeInventorySync,
  INVENTORY_SYNC_QUEUE,
  inventorySyncHandler,
  type InventorySyncDeps,
  type InventorySyncShopifyOps,
} from '../src/jobs/inventory-sync.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

/** Every row this file creates carries this prefix in its natural key (product handle, variant
 * sku, supplier ids), so a crashed run's leftovers are identifiable and the `afterEach` below can
 * delete exactly what it made — the same cleanup-by-prefix discipline the other job tests use. */
const PREFIX = 'inv-sync-test'

let uidCounter = 0
function uid(): string {
  uidCounter += 1
  return `${PREFIX}-${Date.now()}-${uidCounter}`
}

/** The single active location every `primaryLocationId()` in this file resolves to. */
const LOCATION_ID = 'gid://shopify/Location/inv-sync-test'

/** Frozen clock: fixes both the `stock_checked_at` writes and the `yyyymmddHH` half of every
 * idempotency key this file asserts on. */
const NOW = new Date('2026-09-01T14:22:33.000Z')
const NOW_STAMP = '2026090114'

/** Two US warehouses plus a CN one — the largest SINGLE US entry (4) is the sellable quantity,
 * never the sum (7) and never CN's 99. Same fixture shape as the listing worker's tests. */
function stock(quantity: number): WarehouseStock[] {
  return [
    { countryCode: 'US', quantity, verified: true },
    { countryCode: 'US', quantity: Math.max(0, quantity - 1), verified: true },
    { countryCode: 'CN', quantity: 99, verified: true },
  ]
}

interface ShopifyCall {
  input: Record<string, unknown>
  key: string
}

function fakeShopify(overrides: Partial<InventorySyncShopifyOps> = {}): InventorySyncShopifyOps & {
  calls: ShopifyCall[]
  locationCalls: number
} {
  const calls: ShopifyCall[] = []
  const self = {
    calls,
    locationCalls: 0,
    inventorySetQuantities: async (input: Record<string, unknown>, key: string) => {
      calls.push({ input, key })
    },
    primaryLocationId: async () => {
      self.locationCalls += 1
      return LOCATION_ID
    },
    ...overrides,
  }
  return self
}

/** `getVariantStock` over a per-supplier-variant-id script: a number answers with that US
 * quantity, an Error rejects with it. Records every id it was asked for, in call order. */
function fakeAdapter(script: Record<string, number | Error>) {
  const reads: string[] = []
  return {
    reads,
    getVariantStock: async (supplierVariantId: string): Promise<WarehouseStock[]> => {
      reads.push(supplierVariantId)
      const answer = script[supplierVariantId]
      if (answer instanceof Error) throw answer
      return stock(answer ?? 0)
    },
  }
}

describe('executeInventorySync', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  let createdProductIds: string[] = []
  let createdVariantIds: string[] = []

  afterEach(async () => {
    if (createdVariantIds.length > 0) {
      await db.delete(supplierVariantMappings).where(inArray(supplierVariantMappings.variantId, createdVariantIds))
      await db.delete(auditLog).where(inArray(auditLog.entityId, createdVariantIds))
      await db.delete(productVariants).where(inArray(productVariants.id, createdVariantIds))
    }
    if (createdProductIds.length > 0) {
      await db.delete(auditLog).where(inArray(auditLog.entityId, createdProductIds))
      await db.delete(products).where(inArray(products.id, createdProductIds))
    }
    // Every unscoped cycle audits itself under the sentinel entity id `'all'` (there is no single
    // entity a whole-catalog cycle belongs to) — those rows carry no created-id to delete by, so
    // they're cleaned by their action + sentinel instead.
    await db.delete(auditLog).where(and(eq(auditLog.action, 'inventory.synced'), eq(auditLog.entityId, 'all')))
    createdVariantIds = []
    createdProductIds = []
    vi.restoreAllMocks()
  })

  async function seedProduct(status: 'active' | 'draft' | 'deprecated'): Promise<string> {
    const handle = uid()
    const [row] = await db
      .insert(products)
      .values({ shopifyProductGid: `gid://shopify/Product/${handle}`, handle, title: handle, status, categoryTag: 'toys' })
      .returning({ id: products.id })
    createdProductIds.push(row!.id)
    return row!.id
  }

  async function seedVariant(
    productId: string,
    opts: { inventoryItemGid?: string | null; mapping?: boolean; lastKnownStock?: number | null; stockCheckedAt?: Date | null } = {},
  ): Promise<{ variantId: string; supplierVariantId: string; inventoryItemGid: string | null }> {
    const sku = uid()
    const inventoryItemGid = opts.inventoryItemGid === undefined ? `gid://shopify/InventoryItem/${sku}` : opts.inventoryItemGid
    const [row] = await db
      .insert(productVariants)
      .values({ productId, sku, shopifyVariantGid: `gid://shopify/ProductVariant/${sku}`, shopifyInventoryItemGid: inventoryItemGid, priceCents: 2999 })
      .returning({ id: productVariants.id })
    createdVariantIds.push(row!.id)
    const supplierVariantId = `cjv-${sku}`
    if (opts.mapping !== false) {
      await db.insert(supplierVariantMappings).values({
        variantId: row!.id,
        supplier: 'cj',
        supplierProductId: `cjp-${sku}`,
        supplierVariantId,
        lastKnownStock: opts.lastKnownStock ?? null,
        stockCheckedAt: opts.stockCheckedAt ?? null,
      })
    }
    return { variantId: row!.id, supplierVariantId, inventoryItemGid }
  }

  function makeDeps(
    adapter: ReturnType<typeof fakeAdapter>,
    shopify: InventorySyncShopifyOps | null,
    extra: Partial<InventorySyncDeps> = {},
  ): { deps: InventorySyncDeps; alert: ReturnType<typeof vi.fn> } {
    const alert = vi.fn(async () => {})
    const deps: InventorySyncDeps = { db, adapter, shopify, alert, now: () => NOW, ...extra }
    return { deps, alert }
  }

  async function mappingRow(variantId: string) {
    const [row] = await db.select().from(supplierVariantMappings).where(eq(supplierVariantMappings.variantId, variantId))
    return row
  }

  async function syncedAudits(entityId: string) {
    return db.select().from(auditLog).where(and(eq(auditLog.action, 'inventory.synced'), eq(auditLog.entityId, entityId)))
  }

  // (a) -------------------------------------------------------------------------------------
  it('a. selects only ACTIVE products\' variants with a mapping and an inventory-item gid', async () => {
    const activeId = await seedProduct('active')
    const live = await seedVariant(activeId, { lastKnownStock: 1 })
    await seedVariant(activeId, { inventoryItemGid: null }) // no gid → skipped (backfill fixes it)
    const draftId = await seedProduct('draft')
    const draftVariant = await seedVariant(draftId, { lastKnownStock: 1 })
    const deprecatedId = await seedProduct('deprecated')
    const deprecatedVariant = await seedVariant(deprecatedId, { lastKnownStock: 1 })
    const noMappingProductId = await seedProduct('active')
    await seedVariant(noMappingProductId, { mapping: false })

    const adapter = fakeAdapter({
      [live.supplierVariantId]: 4,
      [draftVariant.supplierVariantId]: 4,
      [deprecatedVariant.supplierVariantId]: 4,
    })
    const shopify = fakeShopify()
    const { deps } = makeDeps(adapter, shopify)

    // Whole-catalog cycle: the only eligible variant anywhere is `live`, so updated/unchanged/
    // failed are exact here regardless of what else the shared test DB holds.
    const result = await executeInventorySync(deps, {})
    expect({ updated: result.updated, unchanged: result.unchanged, failed: result.failed }).toEqual({
      updated: 1, unchanged: 0, failed: 0,
    })
    expect(adapter.reads).toEqual([live.supplierVariantId])
    expect(shopify.calls).toHaveLength(1)

    // Scoped runs pin the exact `skipped` count per product without depending on the rest of the DB.
    expect(await executeInventorySync(deps, { productId: draftId })).toEqual({ updated: 0, unchanged: 0, failed: 0, skipped: 1 })
    expect(await executeInventorySync(deps, { productId: deprecatedId })).toEqual({ updated: 0, unchanged: 0, failed: 0, skipped: 1 })
    expect(await executeInventorySync(deps, { productId: noMappingProductId })).toEqual({ updated: 0, unchanged: 0, failed: 0, skipped: 1 })
    // The active product still has its one gid-less variant skipped alongside the synced one.
    const activeAgain = await executeInventorySync(deps, { productId: activeId })
    expect(activeAgain.skipped).toBe(1)
    expect(adapter.reads).toEqual([live.supplierVariantId, live.supplierVariantId])
  })

  // (b) -------------------------------------------------------------------------------------
  it('b. unchanged stock makes no Shopify call but still bumps stock_checked_at', async () => {
    const productId = await seedProduct('active')
    const v = await seedVariant(productId, { lastKnownStock: 4, stockCheckedAt: new Date('2026-08-01T00:00:00.000Z') })
    const adapter = fakeAdapter({ [v.supplierVariantId]: 4 })
    const shopify = fakeShopify()
    const { deps } = makeDeps(adapter, shopify)

    const result = await executeInventorySync(deps, { productId })
    expect(result).toEqual({ updated: 0, unchanged: 1, failed: 0, skipped: 0 })
    expect(shopify.calls).toEqual([])
    // A cycle where nothing moved must not even pay for the location lookup.
    expect(shopify.locationCalls).toBe(0)
    const row = await mappingRow(v.variantId)
    expect(row!.lastKnownStock).toBe(4)
    expect(row!.stockCheckedAt?.toISOString()).toBe(NOW.toISOString())
  })

  // (c) -------------------------------------------------------------------------------------
  it('c. changed stock sends exactly one inventorySetQuantities with the live-verified input shape', async () => {
    const productId = await seedProduct('active')
    const v = await seedVariant(productId, { lastKnownStock: 1 })
    const adapter = fakeAdapter({ [v.supplierVariantId]: 4 })
    const shopify = fakeShopify()
    const { deps } = makeDeps(adapter, shopify)

    const result = await executeInventorySync(deps, { productId })
    expect(result).toEqual({ updated: 1, unchanged: 0, failed: 0, skipped: 0 })
    expect(shopify.calls).toHaveLength(1)
    expect(shopify.calls[0]!.input).toEqual({
      name: 'available',
      reason: 'correction',
      quantities: [{ inventoryItemId: v.inventoryItemGid, locationId: LOCATION_ID, quantity: 4 }],
    })
    // 2026-07 has no `ignoreCompareQuantity`, and the per-entry CAS `changeFromQuantity` is
    // omitted on purpose — this is an unconditional set.
    const quantity = (shopify.calls[0]!.input as { quantities: Record<string, unknown>[] }).quantities[0]!
    expect(Object.keys(quantity).sort()).toEqual(['inventoryItemId', 'locationId', 'quantity'])
    expect(shopify.calls[0]!.key).toBe(`inv-${v.variantId}-${NOW_STAMP}`)
    expect(shopify.locationCalls).toBe(1)

    const row = await mappingRow(v.variantId)
    expect(row!.lastKnownStock).toBe(4)
    expect(row!.stockCheckedAt?.toISOString()).toBe(NOW.toISOString())
  })

  // (d) -------------------------------------------------------------------------------------
  it('d. one variant\'s stock read throwing is counted failed; the others still sync', async () => {
    const productId = await seedProduct('active')
    const bad = await seedVariant(productId, { lastKnownStock: 1 })
    const good = await seedVariant(productId, { lastKnownStock: 1 })
    const adapter = fakeAdapter({ [bad.supplierVariantId]: new Error('CJ 500'), [good.supplierVariantId]: 4 })
    const shopify = fakeShopify()
    const { deps } = makeDeps(adapter, shopify)

    const result = await executeInventorySync(deps, { productId })
    expect(result).toEqual({ updated: 1, unchanged: 0, failed: 1, skipped: 0 })
    expect(shopify.calls).toHaveLength(1)
    // The failed variant's cached stock is untouched — "CJ was unreachable" is not an observation.
    expect((await mappingRow(bad.variantId))!.lastKnownStock).toBe(1)
    expect((await mappingRow(good.variantId))!.lastKnownStock).toBe(4)
    const failedAudit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'inventory_sync.variant_failed'), eq(auditLog.entityId, bad.variantId)))
    expect(failedAudit).toHaveLength(1)
  })

  // (e) -------------------------------------------------------------------------------------
  it('e. 1-of-4 failures alerts nothing; 2-of-4 fires one inventory_sync_degraded warning', async () => {
    const productId = await seedProduct('active')
    const vs = [
      await seedVariant(productId, { lastKnownStock: 1 }),
      await seedVariant(productId, { lastKnownStock: 1 }),
      await seedVariant(productId, { lastKnownStock: 1 }),
      await seedVariant(productId, { lastKnownStock: 1 }),
    ]
    const oneBad = fakeAdapter({
      [vs[0]!.supplierVariantId]: new Error('CJ 500'),
      [vs[1]!.supplierVariantId]: 4, [vs[2]!.supplierVariantId]: 4, [vs[3]!.supplierVariantId]: 4,
    })
    const first = makeDeps(oneBad, fakeShopify())
    const oneResult = await executeInventorySync(first.deps, { productId })
    expect(oneResult.failed).toBe(1)
    expect(first.alert.mock.calls.filter((c) => c[1] === 'inventory_sync_degraded')).toEqual([])

    const twoBad = fakeAdapter({
      [vs[0]!.supplierVariantId]: new Error('CJ 500'),
      [vs[1]!.supplierVariantId]: new Error('CJ 500'),
      [vs[2]!.supplierVariantId]: 4, [vs[3]!.supplierVariantId]: 4,
    })
    const second = makeDeps(twoBad, fakeShopify())
    const twoResult = await executeInventorySync(second.deps, { productId })
    expect(twoResult.failed).toBe(2)
    const degraded = second.alert.mock.calls.filter((c) => c[1] === 'inventory_sync_degraded')
    expect(degraded).toHaveLength(1)
    expect(degraded[0]![0]).toBe('warning')
  })

  // (f) -------------------------------------------------------------------------------------
  it('f. scope.productId limits the cycle to that product', async () => {
    const mine = await seedProduct('active')
    const other = await seedProduct('active')
    const a = await seedVariant(mine, { lastKnownStock: 1 })
    const b = await seedVariant(other, { lastKnownStock: 1 })
    const adapter = fakeAdapter({ [a.supplierVariantId]: 4, [b.supplierVariantId]: 4 })
    const shopify = fakeShopify()
    const { deps } = makeDeps(adapter, shopify)

    const result = await executeInventorySync(deps, { productId: mine })
    expect(result).toEqual({ updated: 1, unchanged: 0, failed: 0, skipped: 0 })
    expect(adapter.reads).toEqual([a.supplierVariantId])
    expect(shopify.calls[0]!.input).toMatchObject({
      quantities: [{ inventoryItemId: a.inventoryItemGid, locationId: LOCATION_ID, quantity: 4 }],
    })
    expect((await mappingRow(b.variantId))!.lastKnownStock).toBe(1)
  })

  // (g) -------------------------------------------------------------------------------------
  it('g. a null shopify (dev boot without creds) returns all-skipped with one info alert', async () => {
    const productId = await seedProduct('active')
    const v = await seedVariant(productId, { lastKnownStock: 1 })
    const adapter = fakeAdapter({ [v.supplierVariantId]: 4 })
    const { deps, alert } = makeDeps(adapter, null)

    const result = await executeInventorySync(deps, { productId })
    expect(result).toEqual({ updated: 0, unchanged: 0, failed: 0, skipped: 1 })
    // No CJ points burned on a cycle that can push nothing.
    expect(adapter.reads).toEqual([])
    const infos = alert.mock.calls.filter((c) => c[1] === 'inventory_sync_no_shopify')
    expect(infos).toHaveLength(1)
    expect(infos[0]![0]).toBe('info')
  })

  // (h) -------------------------------------------------------------------------------------
  it('h. the CJ points cap stops the cycle early with one inventory_sync_points_capped warning', async () => {
    const productId = await seedProduct('active')
    const a = await seedVariant(productId, { lastKnownStock: 1 })
    const b = await seedVariant(productId, { lastKnownStock: 1 })
    const adapter = fakeAdapter({ [a.supplierVariantId]: 4, [b.supplierVariantId]: 4 })
    const shopify = fakeShopify()
    // Exactly one stock read's worth of points.
    const { deps, alert } = makeDeps(adapter, shopify, { points: new PointsAllowance(10) })

    const result = await executeInventorySync(deps, { productId })
    expect(result).toEqual({ updated: 1, unchanged: 0, failed: 0, skipped: 1 })
    expect(adapter.reads).toHaveLength(1)
    expect(shopify.calls).toHaveLength(1)
    const capped = alert.mock.calls.filter((c) => c[1] === 'inventory_sync_points_capped')
    expect(capped).toHaveLength(1)
    expect(capped[0]![0]).toBe('warning')
  })

  // (i) -------------------------------------------------------------------------------------
  it('i. audits one inventory.synced row carrying the cycle\'s counts', async () => {
    const productId = await seedProduct('active')
    const changed = await seedVariant(productId, { lastKnownStock: 1 })
    const same = await seedVariant(productId, { lastKnownStock: 4 })
    const bad = await seedVariant(productId, { lastKnownStock: 1 })
    await seedVariant(productId, { inventoryItemGid: null })
    const adapter = fakeAdapter({
      [changed.supplierVariantId]: 4,
      [same.supplierVariantId]: 4,
      [bad.supplierVariantId]: new Error('CJ 500'),
    })
    const { deps } = makeDeps(adapter, fakeShopify())

    const result = await executeInventorySync(deps, { productId })
    expect(result).toEqual({ updated: 1, unchanged: 1, failed: 1, skipped: 1 })
    const rows = await syncedAudits(productId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.detail).toMatchObject({ updated: 1, unchanged: 1, failed: 1, skipped: 1, productId })
    expect(rows[0]!.actor).toBe('system')
  })

  // (j) -------------------------------------------------------------------------------------
  it('j. the handler runs one cycle per job, and a thrown cycle rethrows only after the batch', async () => {
    const productA = await seedProduct('active')
    const productB = await seedProduct('active')
    const a = await seedVariant(productA, { lastKnownStock: 1 })
    const b = await seedVariant(productB, { lastKnownStock: 1 })
    const adapter = fakeAdapter({ [a.supplierVariantId]: 4, [b.supplierVariantId]: 7 })
    const shopify = fakeShopify()
    const { deps } = makeDeps(adapter, shopify)
    const job = (id: string, productId: string) => ({
      id, name: INVENTORY_SYNC_QUEUE, data: { productId }, retryCount: 0, retryLimit: 3,
    })

    await inventorySyncHandler(deps)([job('j1', productA), job('j2', productB)])
    expect(shopify.calls.map((c) => (c.input as { quantities: { quantity: number }[] }).quantities[0]!.quantity)).toEqual([4, 7])
    // The location memo is per cycle, not per process: two cycles, two lookups.
    expect(shopify.locationCalls).toBe(2)

    // A cycle that throws outright (an infrastructure failure, not a per-variant one — those are
    // counted, never thrown) must not cost the rest of the batch its run: the error is held and
    // rethrown afterwards so pg-boss still fails/retries the job.
    let selects = 0
    const flakyDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'select') {
          selects += 1
          if (selects === 1) {
            return () => {
              throw new Error('db down')
            }
          }
        }
        return Reflect.get(target, prop, receiver) as unknown
      },
    })
    const retry = fakeShopify()
    const { deps: flakyDeps } = makeDeps(fakeAdapter({ [b.supplierVariantId]: 12 }), retry, { db: flakyDb })
    await expect(inventorySyncHandler(flakyDeps)([job('j3', productA), job('j4', productB)])).rejects.toThrow('db down')
    expect(retry.calls).toHaveLength(1)
    expect((await mappingRow(b.variantId))!.lastKnownStock).toBe(12)
  })
})
