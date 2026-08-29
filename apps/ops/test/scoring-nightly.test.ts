import { createDb, products, productScores } from '@doge-buddy/db'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeScoringNightly, scoringNightlyHandler, type ScoringNightlyDeps } from '../src/jobs/scoring-nightly.ts'
import { createSettings, SETTINGS_DEFAULTS } from '../src/settings.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

describe('scoring.nightly', () => {
  const { db, pool } = createDb(url)
  const settingsStore = createSettings(db)

  const createdProductIds: string[] = []

  async function seedActiveProduct(): Promise<string> {
    const [row] = await db
      .insert(products)
      .values({
        shopifyProductGid: `gid://shopify/Product/${crypto.randomUUID()}`,
        handle: `h-${crypto.randomUUID()}`,
        title: 'scoring-nightly test product',
        status: 'active',
      })
      .returning({ id: products.id })
    createdProductIds.push(row!.id)
    return row!.id
  }

  /** Live count of currently-active products — the shared test DB may already carry active
   *  products from other spec files or a leftover manual seed, so tests that assert `scored`
   *  against a total must add to this rather than assume the table starts empty. */
  async function activeProductCount(): Promise<number> {
    const rows = await db.select({ id: products.id }).from(products).where(eq(products.status, 'active'))
    return rows.length
  }

  async function scoreRowsFor(productIds: string[]) {
    if (productIds.length === 0) return []
    return db.select().from(productScores).where(inArray(productScores.productId, productIds))
  }

  // Reset both gate settings to their code defaults (killswitch off, scoring enabled) before AND
  // after every test — same belt-and-suspenders pattern support-poll-job.test.ts uses for its own
  // killswitch/enabled pair — so a test that flips one doesn't bleed into the next.
  beforeEach(async () => {
    await settingsStore.set('killswitch.global', SETTINGS_DEFAULTS['killswitch.global'])
    await settingsStore.set('workflow.scoring.enabled', SETTINGS_DEFAULTS['workflow.scoring.enabled'])
  })

  afterEach(async () => {
    await settingsStore.set('killswitch.global', SETTINGS_DEFAULTS['killswitch.global'])
    await settingsStore.set('workflow.scoring.enabled', SETTINGS_DEFAULTS['workflow.scoring.enabled'])
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    if (createdProductIds.length) {
      await db.delete(productScores).where(inArray(productScores.productId, createdProductIds))
      await db.delete(products).where(inArray(products.id, createdProductIds))
    }
    await pool.end()
  })

  it('killswitch.global on → {scored:0}, no product_scores row written, compute never invoked', async () => {
    const productId = await seedActiveProduct()
    await settingsStore.set('killswitch.global', true)

    const alert = vi.fn(async () => {})
    const deps: ScoringNightlyDeps = { db, settings: settingsStore, alert }
    const result = await executeScoringNightly(deps)

    expect(result).toEqual({ scored: 0 })
    expect(await scoreRowsFor([productId])).toHaveLength(0)
    expect(alert).not.toHaveBeenCalled()
  })

  it('workflow.scoring.enabled=false → {scored:0}, no product_scores row written', async () => {
    const productId = await seedActiveProduct()
    await settingsStore.set('workflow.scoring.enabled', false)

    const alert = vi.fn(async () => {})
    const deps: ScoringNightlyDeps = { db, settings: settingsStore, alert }
    const result = await executeScoringNightly(deps)

    expect(result).toEqual({ scored: 0 })
    expect(await scoreRowsFor([productId])).toHaveLength(0)
    expect(alert).not.toHaveBeenCalled()
  })

  it('enabled + N active products → {scored:N} and N product_scores rows persisted', async () => {
    const baseline = await activeProductCount()
    const ids = [await seedActiveProduct(), await seedActiveProduct(), await seedActiveProduct()]

    const alert = vi.fn(async () => {})
    const now = new Date('2026-08-26T03:00:00.000Z')
    const deps: ScoringNightlyDeps = { db, settings: settingsStore, alert, now: () => now }
    const result = await executeScoringNightly(deps)

    expect(result).toEqual({ scored: baseline + ids.length })
    const rows = await scoreRowsFor(ids)
    expect(rows).toHaveLength(ids.length)
    for (const row of rows) {
      expect(row.scoreDate).toBe('2026-08-26')
      expect(row.verdict).toBeTruthy()
      expect(row.score).toBeNull()
    }
  })

  it('scoringNightlyHandler swallows a thrown compute and fires a critical scoring_nightly_failed alert', async () => {
    const alert = vi.fn(async () => {})
    // A `db` whose `execute` always throws — `settings` stays the real store (both gates pass:
    // killswitch off, scoring enabled per beforeEach), so `executeScoringNightly` reaches
    // `computeProductScores`, which calls `db.execute(...)` for the metric SQL and blows up there.
    const brokenDb = { execute: async () => { throw new Error('boom') } } as unknown as ScoringNightlyDeps['db']
    const deps: ScoringNightlyDeps = { db: brokenDb, settings: settingsStore, alert }

    const handler = scoringNightlyHandler(deps)
    await expect(handler([])).resolves.toBeUndefined()

    expect(alert).toHaveBeenCalledWith('critical', 'scoring_nightly_failed', { error: 'boom' })
    expect(alert).toHaveBeenCalledTimes(1)
  })

  it('executeScoringNightly itself still rejects on a thrown compute (the handler is what swallows it)', async () => {
    const alert = vi.fn(async () => {})
    const brokenDb = { execute: async () => { throw new Error('kaboom') } } as unknown as ScoringNightlyDeps['db']
    const deps: ScoringNightlyDeps = { db: brokenDb, settings: settingsStore, alert }

    await expect(executeScoringNightly(deps)).rejects.toThrow('kaboom')
  })
})
