import { createDb, products, productVariants, proposals, sourcingSignals, supplierVariantMappings } from '@doge-buddy/db'
import type { SupplierProductSummary } from '@doge-buddy/supplier'
import { inArray } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { CANDIDATE_TARGET, HARVEST_KEYWORDS, HARVEST_MAX_PAGES_TOTAL, runHarvest } from '../src/sourcing/harvest.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

let uidCounter = 0
function uid(): string {
  uidCounter += 1
  return `${Date.now()}-${uidCounter}`
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000)
}

function summary(pid: string, opts: Partial<SupplierProductSummary> = {}): SupplierProductSummary {
  return {
    supplierProductId: pid,
    title: `Test product ${pid}`,
    sellPriceCents: 1999,
    ...opts,
  }
}

type SearchCall = { keyword?: string; countryCode?: string; flag?: 'trending' | 'new'; page?: number; pageSize?: number }

/** Stub adapter: `pages` maps a harvest keyword to an array of pages (1-indexed by position), each
 * page an array of summaries (or an Error to throw for that page). Missing keywords/pages return []. */
function makeAdapter(pages: Record<string, (SupplierProductSummary[] | Error)[]>) {
  const searchProducts = vi.fn(async (q: SearchCall): Promise<SupplierProductSummary[]> => {
    const list = pages[q.keyword ?? ''] ?? []
    const entry = list[(q.page ?? 1) - 1]
    if (entry instanceof Error) throw entry
    return entry ?? []
  })
  return { searchProducts }
}

describe('runHarvest', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  let createdProposalIds: string[] = []
  let createdProductIds: string[] = []
  let seededPids: string[] = []

  afterEach(async () => {
    if (createdProposalIds.length > 0) {
      await db.delete(proposals).where(inArray(proposals.id, createdProposalIds))
    }
    if (createdProductIds.length > 0) {
      const variantRows = await db
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(inArray(productVariants.productId, createdProductIds))
      const variantIds = variantRows.map((r) => r.id)
      if (variantIds.length > 0) {
        await db.delete(supplierVariantMappings).where(inArray(supplierVariantMappings.variantId, variantIds))
        await db.delete(productVariants).where(inArray(productVariants.id, variantIds))
      }
      await db.delete(products).where(inArray(products.id, createdProductIds))
    }
    if (seededPids.length > 0) {
      await db.delete(sourcingSignals).where(inArray(sourcingSignals.supplierProductId, seededPids))
    }
    createdProposalIds = []
    createdProductIds = []
    seededPids = []
  })

  async function seedMapping(pid: string): Promise<void> {
    const [product] = await db.insert(products).values({ title: 'Harvest test product', status: 'active' }).returning({ id: products.id })
    createdProductIds.push(product!.id)
    const [variant] = await db
      .insert(productVariants)
      .values({ productId: product!.id, sku: `harvest-sku-${uid()}`, priceCents: 1999 })
      .returning({ id: productVariants.id })
    await db.insert(supplierVariantMappings).values({
      variantId: variant!.id,
      supplier: 'mock',
      supplierProductId: pid,
      supplierVariantId: `${pid}-v1`,
    })
  }

  async function seedProposal(
    pid: string,
    status: 'pending' | 'approved' | 'failed' | 'rejected' | 'expired',
    decidedAt?: Date,
  ): Promise<void> {
    const [row] = await db
      .insert(proposals)
      .values({
        type: 'new_listing',
        status,
        summary: `Harvest test proposal ${pid}`,
        payload: { variants: [{ supplierProductId: pid }] },
        sourceWorkflow: 'sourcing-agent-test',
        decidedAt: decidedAt ?? null,
      })
      .returning({ id: proposals.id })
    createdProposalIds.push(row!.id)
  }

  it('searches by dog keywords only: every call carries a HARVEST_KEYWORDS keyword, no flag; all keywords get a pass', async () => {
    const p = `h${uid()}`
    seededPids = [`${p}-a`]

    const adapter = makeAdapter({ 'dog toy': [[summary(`${p}-a`, { title: 'Squeaky Bone Toy' })], []] })
    const alert = vi.fn(async () => {})

    await runHarvest({ db, adapter, alert })

    const calls = adapter.searchProducts.mock.calls.map(([q]) => q)
    expect(calls.length).toBeGreaterThan(0)
    for (const q of calls) {
      expect(q.flag).toBeUndefined()
      expect(HARVEST_KEYWORDS).toContain(q.keyword)
    }
    // Every configured keyword got at least one pass.
    const queried = new Set(calls.map((q) => q.keyword))
    expect([...queried].sort()).toEqual([...HARVEST_KEYWORDS].sort())
  })

  it('every searchProducts call requests US-warehouse products (countryCode US)', async () => {
    const p = `h${uid()}`
    seededPids = [`${p}-a`]

    const adapter = makeAdapter({ 'dog toy': [[summary(`${p}-a`, { title: 'Squeaky Bone Toy' })], []] })
    const alert = vi.fn(async () => {})

    await runHarvest({ db, adapter, alert })

    const calls = adapter.searchProducts.mock.calls.map(([q]) => q)
    expect(calls.length).toBeGreaterThan(0)
    for (const q of calls) {
      expect(q.countryCode).toBe('US')
    }
  })

  it('candidates carry the keyword whose pass fetched them', async () => {
    const p = `h${uid()}`
    const toyPid = `${p}-toy`
    const bedPid = `${p}-bed`
    seededPids = [toyPid, bedPid]

    const adapter = makeAdapter({
      'dog toy': [[summary(toyPid, { title: 'Squeaky Bone Toy' })], []],
      'dog bed': [[summary(bedPid, { title: 'Plush Donut Bed' })], []],
    })
    const alert = vi.fn(async () => {})

    const result = await runHarvest({ db, adapter, alert })

    const byPid = new Map(result.candidates.map((c) => [c.supplierProductId, c]))
    expect(byPid.get(toyPid)?.keyword).toBe('dog toy')
    expect(byPid.get(bedPid)?.keyword).toBe('dog bed')
  })

  it('dedupe matrix: mapped, pending, 30d-rejected drop; 100d-rejected and clean survive; calming/flea guards drop', async () => {
    const p = `h${uid()}`
    const mappedPid = `${p}-mapped`
    const pendingPid = `${p}-pending`
    const rejected30Pid = `${p}-rejected30`
    const rejected100Pid = `${p}-rejected100`
    const calmingPid = `${p}-calming`
    const fleaPid = `${p}-flea`
    const cleanPid = `${p}-clean`

    await seedMapping(mappedPid)
    await seedProposal(pendingPid, 'pending')
    await seedProposal(rejected30Pid, 'rejected', daysAgo(30))
    await seedProposal(rejected100Pid, 'rejected', daysAgo(100))

    const allPids = [mappedPid, pendingPid, rejected30Pid, rejected100Pid, calmingPid, fleaPid, cleanPid]
    seededPids = allPids

    const summaries = [
      summary(mappedPid, { listedCount: undefined }),
      summary(pendingPid),
      summary(rejected30Pid),
      summary(rejected100Pid),
      summary(calmingPid, { title: 'Calming Dog Bed XL' }),
      summary(fleaPid, { title: 'Adjustable Collar', categoryName: 'Flea & Tick Collar' }),
      summary(cleanPid, { title: 'Durable Rope Tug Toy' }),
    ]

    const adapter = makeAdapter({ 'dog toy': [summaries, []] })
    const alert = vi.fn(async () => {})

    const result = await runHarvest({ db, adapter, alert })

    const candidatePids = result.candidates.map((c) => c.supplierProductId)
    expect(candidatePids).toContain(rejected100Pid)
    expect(candidatePids).toContain(cleanPid)
    expect(candidatePids).not.toContain(mappedPid)
    expect(candidatePids).not.toContain(pendingPid)
    expect(candidatePids).not.toContain(rejected30Pid)
    expect(candidatePids).not.toContain(calmingPid)
    expect(candidatePids).not.toContain(fleaPid)
    expect(candidatePids).toHaveLength(2)
  })

  it('writes one sourcing_signals row per unique pid, source cj_trending, keyword = first pass that fetched it', async () => {
    const p = `h${uid()}`
    const pidA = `${p}-a`
    const pidB = `${p}-b`
    seededPids = [pidA, pidB]

    // pidA appears under BOTH 'dog toy' and 'dog' (dedupe within run; 'dog toy' runs first);
    // pidB only under 'dog'.
    const adapter = makeAdapter({
      'dog toy': [[summary(pidA, { listedCount: 10 })], []],
      dog: [[summary(pidA, { listedCount: 10 }), summary(pidB, { listedCount: 5 })], []],
    })
    const alert = vi.fn(async () => {})

    await runHarvest({ db, adapter, alert })

    const rows = await db.select().from(sourcingSignals).where(inArray(sourcingSignals.supplierProductId, [pidA, pidB]))
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.source).toBe('cj_trending')
    }
    const rowA = rows.find((r) => r.supplierProductId === pidA)!
    expect(Number(rowA.score)).toBe(10)
    expect(rowA.keyword).toBe('dog toy')
    const rowB = rows.find((r) => r.supplierProductId === pidB)!
    expect(rowB.keyword).toBe('dog')
  })

  it('page failure: one keyword pass throws on page 2 -> alerts and ends that pass only; other passes keep fetching; candidates still returned', async () => {
    const p = `h${uid()}`
    const pidX1 = `${p}-x1`
    const pidY1 = `${p}-y1`
    const pidY2 = `${p}-y2`
    seededPids = [pidX1, pidY1, pidY2]

    const boom = new Error('CJ 429: rate limited')
    const adapter = makeAdapter({
      'dog toy': [[summary(pidX1)], boom],
      dog: [[summary(pidY1)], [summary(pidY2)], []],
    })
    const alert = vi.fn(async () => {})

    const result = await runHarvest({ db, adapter, alert })

    expect(alert).toHaveBeenCalledWith('warning', 'sourcing_harvest_page_failed', {
      pass: 'dog toy',
      page: 2,
      error: expect.stringContaining('CJ 429'),
    })

    // The 'dog' pass's third page call (which returns []) proves it kept going despite the failure.
    const dogCalls = adapter.searchProducts.mock.calls.filter(([q]) => q.keyword === 'dog')
    expect(dogCalls.map(([q]) => q.page)).toEqual([1, 2, 3])

    const candidatePids = result.candidates.map((c) => c.supplierProductId)
    expect(candidatePids).toEqual(expect.arrayContaining([pidX1, pidY1, pidY2]))
  })

  it('ranks by listedNum desc (nulls last), tiebreak sellPriceCents asc, capped at CANDIDATE_TARGET', async () => {
    const p = `h${uid()}`
    const spec: { listedNum: number | null; price: number }[] = [
      { listedNum: 50, price: 999 },
      { listedNum: null, price: 100 },
      { listedNum: 200, price: 500 },
      { listedNum: 200, price: 300 },
      { listedNum: 150, price: 700 },
      { listedNum: 140, price: 200 },
      { listedNum: 130, price: 200 },
      { listedNum: 120, price: 200 },
      { listedNum: 110, price: 200 },
      { listedNum: 100, price: 200 },
      { listedNum: 90, price: 200 },
      { listedNum: 80, price: 200 },
      { listedNum: 70, price: 200 },
      { listedNum: 60, price: 200 },
      { listedNum: 40, price: 200 },
      { listedNum: 30, price: 200 },
      { listedNum: 20, price: 200 },
      { listedNum: null, price: 50 },
    ]
    const pids = spec.map((_, i) => `${p}-r${i}`)
    seededPids = pids

    const summaries = spec.map((s, i) =>
      summary(pids[i]!, {
        title: `Ranking Toy ${i}`,
        sellPriceCents: s.price,
        listedCount: s.listedNum ?? undefined,
      }),
    )

    const adapter = makeAdapter({ 'dog toy': [summaries, []] })
    const alert = vi.fn(async () => {})

    const result = await runHarvest({ db, adapter, alert })

    expect(result.candidates).toHaveLength(CANDIDATE_TARGET)
    expect(result.candidates.map((c) => c.listedNum)).toEqual([
      200, 200, 150, 140, 130, 120, 110, 100, 90, 80, 70, 60, 50, 40, 30,
    ])
    expect(result.candidates[0]!.sellPriceCents).toBe(300)
    expect(result.candidates[1]!.sellPriceCents).toBe(500)
    expect(result.candidates.some((c) => c.listedNum === 20)).toBe(false)
    expect(result.candidates.some((c) => c.listedNum === null)).toBe(false)
  })

  it('respects HARVEST_MAX_PAGES_TOTAL as a hard cap on total pages fetched across all keyword passes', async () => {
    const p = `h${uid()}`
    // Every page of every keyword pass returns exactly one non-empty item, so the ONLY way the
    // loop ends is the total-pages cap -- never the "all passes empty" condition.
    const pages: Record<string, SupplierProductSummary[][]> = {}
    for (const [ki, keyword] of HARVEST_KEYWORDS.entries()) {
      pages[keyword] = Array.from({ length: 20 }, (_, i) => [summary(`${p}-k${ki}p${i + 1}`, { listedCount: i + 1 })])
    }
    seededPids = Object.values(pages)
      .flat(2)
      .map((s) => s.supplierProductId)

    const adapter = makeAdapter(pages)
    const alert = vi.fn(async () => {})

    const result = await runHarvest({ db, adapter, alert })

    expect(result.pagesFetched).toBe(HARVEST_MAX_PAGES_TOTAL)
  })
})
