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
/** What every fake `inventoryAvailableAt()` in this file says Shopify currently holds. */
const SHOPIFY_AVAILABLE = 2

/** Frozen clock: fixes both the `stock_checked_at` writes and the unix-seconds tail of every
 * idempotency key this file asserts on. */
const NOW = new Date('2026-09-01T14:22:33.000Z')
const NOW_EPOCH_SECONDS = Math.floor(NOW.getTime() / 1000)

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
    inventoryAvailableAt: async () => SHOPIFY_AVAILABLE,
    primaryLocationId: async () => {
      self.locationCalls += 1
      return LOCATION_ID
    },
    ...overrides,
  }
  return self
}

/**
 * `getVariantStock` over a per-supplier-variant-id script: a number answers with that US quantity,
 * an Error rejects with it. Records every id it was asked for, in call order.
 *
 * An UNSCRIPTED id throws rather than answering a default. The whole-catalog test below runs an
 * unscoped cycle against the shared dev database, and any eligible variant this file didn't seed
 * (the backfill will create some) must not have its real `last_known_stock` overwritten by a
 * fixture number — a throw is counted `failed` and touches nothing.
 */
function fakeAdapter(script: Record<string, number | Error>) {
  const reads: string[] = []
  return {
    reads,
    getVariantStock: async (supplierVariantId: string): Promise<WarehouseStock[]> => {
      reads.push(supplierVariantId)
      const answer = script[supplierVariantId]
      if (answer === undefined) throw new Error(`fakeAdapter: unscripted supplier variant ${supplierVariantId}`)
      if (answer instanceof Error) throw answer
      return stock(answer)
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
    // The unscoped cycle in (a) reads every eligible variant in the shared database, not just the
    // seeded ones; any it can't answer for is counted failed and audited under an id this file
    // never tracked. Clear the action wholesale rather than leaking those rows.
    await db.delete(auditLog).where(eq(auditLog.action, 'inventory_sync.variant_failed'))
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

    // Whole-catalog cycle. Exactness is scoped to the rows this file seeded (by prefix): the
    // shared database may hold other eligible variants — the backfill will create some — and this
    // test must keep meaning what it says when it does.
    const result = await executeInventorySync(deps, {})
    expect(result.updated).toBeGreaterThanOrEqual(1)
    expect(adapter.reads.filter((id) => id.includes(PREFIX))).toEqual([live.supplierVariantId])
    expect(shopify.calls.filter((c) => JSON.stringify(c.input).includes(PREFIX))).toHaveLength(1)
    expect((await mappingRow(live.variantId))!.lastKnownStock).toBe(4)

    // Scoped runs pin the exact `skipped` count per product without depending on the rest of the DB.
    expect(await executeInventorySync(deps, { productId: draftId })).toEqual({ updated: 0, unchanged: 0, failed: 0, skipped: 1 })
    expect(await executeInventorySync(deps, { productId: deprecatedId })).toEqual({ updated: 0, unchanged: 0, failed: 0, skipped: 1 })
    expect(await executeInventorySync(deps, { productId: noMappingProductId })).toEqual({ updated: 0, unchanged: 0, failed: 0, skipped: 1 })
    // The active product still has its one gid-less variant skipped alongside the synced one.
    const activeAgain = await executeInventorySync(deps, { productId: activeId })
    expect(activeAgain).toEqual({ updated: 0, unchanged: 1, failed: 0, skipped: 1 })
    expect(adapter.reads.filter((id) => id.includes(PREFIX))).toEqual([live.supplierVariantId, live.supplierVariantId])
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
      quantities: [{ inventoryItemId: v.inventoryItemGid, locationId: LOCATION_ID, quantity: 4, changeFromQuantity: SHOPIFY_AVAILABLE }],
    })
    // `changeFromQuantity` is Shopify's CURRENT `available` (the fake says 2) — NOT the cache
    // (1). The 2026-07 API requires the field (INVALID_FIELD_ARGUMENTS without it, seen live), and
    // it is a CAS against what Shopify holds; `last_known_stock` caches CJ's last READING, and the
    // two diverge the moment a customer buys one (Shopify moves available -> committed, CJ still
    // says 7, and nothing pushes because the job sees no change). A CAS fed from the cache would
    // then be rejected on every later cycle forever, in the oversell direction and below the
    // degraded-alert ratio. Concurrency between our own two producers is the row lock's job — (c2).
    const quantity = (shopify.calls[0]!.input as { quantities: Record<string, unknown>[] }).quantities[0]!
    expect(Object.keys(quantity).sort()).toEqual(['changeFromQuantity', 'inventoryItemId', 'locationId', 'quantity'])
    // `inv-<variantRowId>-<quantity>-<unix seconds>`: the quantity is in the key so a real change
    // can never replay a previous push's result (an hour-bucketed key would let a :40 push of 2
    // replay a :05 push of 4 — the store stays wrong, in the oversell direction, forever).
    expect(shopify.calls[0]!.key).toBe(`inv-${v.variantId}-4-${NOW_EPOCH_SECONDS}`)
    expect(shopify.calls[0]!.key).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(shopify.locationCalls).toBe(1)

    const row = await mappingRow(v.variantId)
    expect(row!.lastKnownStock).toBe(4)
    expect(row!.stockCheckedAt?.toISOString()).toBe(NOW.toISOString())

    // Same variant, same frozen second, different quantity ⇒ different key. (This is the property
    // the hour-bucketed key lacked: there, this second push would have replayed the first's result
    // while we recorded the new number locally.)
    const shopifyAgain = fakeShopify()
    const { deps: depsAgain } = makeDeps(fakeAdapter({ [v.supplierVariantId]: 7 }), shopifyAgain)
    await executeInventorySync(depsAgain, { productId })
    expect(shopifyAgain.calls[0]!.key).toBe(`inv-${v.variantId}-7-${NOW_EPOCH_SECONDS}`)
    expect(shopifyAgain.calls[0]!.key).not.toBe(shopify.calls[0]!.key)
  })

  // (c2) ------------------------------------------------------------------------------------
  it('c2. two concurrent cycles on the same variant leave Shopify and the cache consistent', async () => {
    const productId = await seedProduct('active')
    const v = await seedVariant(productId, { lastKnownStock: null })

    // CJ's answer MOVES between the two reads: whichever cycle reads this variant first gets 7,
    // the other gets 3.
    //
    // The SECOND reader then holds until the first cycle's push has actually been issued, so the
    // store receives 7 before it receives 3. Bounded by a timeout, for the same reason the push
    // hold below is: once the variant is serialized the second reader is blocked on the row lock
    // and the thing it waits for can never arrive, and a bare `await` would deadlock the very fix
    // this test exists to prove.
    const answers = [7, 3]
    const pushes: { inventoryItemId: string; quantity: number }[] = []
    let readCount = 0
    const adapter = {
      reads: [] as string[],
      getVariantStock: async (supplierVariantId: string): Promise<WarehouseStock[]> => {
        adapter.reads.push(supplierVariantId)
        if (supplierVariantId !== v.supplierVariantId) {
          // Same stance as `fakeAdapter`: an id this test didn't seed (the unscoped cycle sweeps
          // the shared database) throws, so it is counted failed and touches nothing.
          throw new Error(`unscripted supplier variant ${supplierVariantId}`)
        }
        const answer = answers[Math.min(readCount, answers.length - 1)]!
        readCount += 1
        if (readCount > 1) {
          for (let waited = 0; waited < 300 && pushes.length === 0; waited += 10) {
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
        }
        return stock(answer)
      },
    }

    // Records what Shopify RECEIVED, in receive order. The 7 — the first reader's push — then
    // HOLDS its caller until the other cycle has written 3 to the cache (bounded, for the same
    // deadlock reason as the read gate: once the variant is serialized, that can never happen
    // while the lock is held). Unserialized, that pins the exact interleave the lost update is
    // made of: Shopify receives 7, then 3 (so the store holds 3), while the 7-cycle's cache write
    // lands LAST (so the cache claims 7). Nothing ever corrects that split — every later cycle
    // compares CJ against the cache, agrees, and pushes nothing.
    const shopify = (): InventorySyncShopifyOps => ({
      inventorySetQuantities: async (input: Record<string, unknown>) => {
        const entry = (input as { quantities: { inventoryItemId: string; quantity: number }[] }).quantities[0]!
        pushes.push(entry)
        if (entry.quantity !== 7) return
        for (let waited = 0; waited < 300; waited += 10) {
          if ((await mappingRow(v.variantId))?.lastKnownStock === 3) return
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      },
      inventoryAvailableAt: async () => SHOPIFY_AVAILABLE,
      primaryLocationId: async () => LOCATION_ID,
    })

    const { deps: cronDeps } = makeDeps(adapter, shopify())
    const { deps: onDemandDeps } = makeDeps(adapter, shopify())

    // The two real producers: the 6-hourly whole-catalog cron and the post-listing per-product
    // job. They sit on two different queue names, so pg-boss's stately singleton cannot serialize
    // them against each other — only the row lock can.
    await Promise.all([
      executeInventorySync(cronDeps, {}),
      executeInventorySync(onDemandDeps, { productId }),
    ])

    // Both cycles read this variant, so they genuinely contended for it.
    expect(adapter.reads.filter((id) => id === v.supplierVariantId)).toHaveLength(2)

    const mine = pushes.filter((p) => p.inventoryItemId === v.inventoryItemGid)
    expect(mine.length).toBeGreaterThanOrEqual(1)
    // The invariant: whatever Shopify was left holding is exactly what our cache claims it holds.
    const cached = (await mappingRow(v.variantId))!.lastKnownStock
    expect(mine[mine.length - 1]!.quantity).toBe(cached)
    expect(answers).toContain(cached)
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
      quantities: [{ inventoryItemId: a.inventoryItemGid, locationId: LOCATION_ID, quantity: 4, changeFromQuantity: SHOPIFY_AVAILABLE }],
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

  // (k) -------------------------------------------------------------------------------------
  it('k. the per-cycle cap rotates — least-recently-checked variants go first', async () => {
    const productId = await seedProduct('active')
    const never = await seedVariant(productId, { lastKnownStock: 1, stockCheckedAt: null })
    const old = await seedVariant(productId, { lastKnownStock: 1, stockCheckedAt: new Date('2026-08-01T00:00:00.000Z') })
    const recent = await seedVariant(productId, { lastKnownStock: 1, stockCheckedAt: new Date('2026-08-15T00:00:00.000Z') })
    const script = { [never.supplierVariantId]: 4, [old.supplierVariantId]: 4, [recent.supplierVariantId]: 4 }

    const adapterOne = fakeAdapter(script)
    const one = makeDeps(adapterOne, fakeShopify(), { maxVariantsPerCycle: 2 })
    const firstCycle = await executeInventorySync(one.deps, { productId })
    expect(firstCycle).toEqual({ updated: 2, unchanged: 0, failed: 0, skipped: 1 })
    // Never-checked first, then the oldest check; the newest-checked variant is deferred.
    expect(adapterOne.reads).toEqual([never.supplierVariantId, old.supplierVariantId])
    expect(one.alert.mock.calls.filter((c) => c[1] === 'inventory_sync_cap_exceeded')).toHaveLength(1)

    // Next cycle the deferred variant is the least-recently-checked, so it is served FIRST — the
    // cap rotates instead of starving the tail forever.
    const adapterTwo = fakeAdapter(script)
    const two = makeDeps(adapterTwo, fakeShopify(), { maxVariantsPerCycle: 2 })
    const secondCycle = await executeInventorySync(two.deps, { productId })
    expect(adapterTwo.reads[0]).toBe(recent.supplierVariantId)
    expect(adapterTwo.reads).toHaveLength(2)
    expect(secondCycle).toEqual({ updated: 1, unchanged: 1, failed: 0, skipped: 1 })
    expect((await mappingRow(recent.variantId))!.lastKnownStock).toBe(4)
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
