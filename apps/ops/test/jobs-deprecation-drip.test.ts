import { createDb, deprecationQueue, products } from '@doge-buddy/db'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { deprecationDripHandler, dripBatchSize, DRIP_MAX_NIGHTS } from '../src/jobs/deprecation-drip.ts'
import type { SubmitProposalDeps } from '../src/proposals/submit.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

describe('catalog.deprecation-drip', () => {
  const { db, pool } = createDb(url)
  let createdProductIds: string[] = []

  afterEach(async () => {
    if (createdProductIds.length > 0) {
      await db.delete(deprecationQueue).where(inArray(deprecationQueue.productId, createdProductIds))
      await db.delete(products).where(inArray(products.id, createdProductIds))
      createdProductIds = []
    }
  })
  afterAll(() => pool.end())

  async function seedProduct(status: 'active' | 'deprecated' = 'active'): Promise<string> {
    const [row] = await db.insert(products).values({ title: 'Drip test product', status }).returning({ id: products.id })
    createdProductIds.push(row!.id)
    return row!.id
  }

  const submitDeps = {} as SubmitProposalDeps // the injected submit mock never touches these

  it('dripBatchSize: at least 1, scaled so the queue drains within DRIP_MAX_NIGHTS', () => {
    expect(dripBatchSize(0)).toBe(1)
    expect(dripBatchSize(1)).toBe(1)
    expect(dripBatchSize(DRIP_MAX_NIGHTS)).toBe(1)
    expect(dripBatchSize(DRIP_MAX_NIGHTS + 1)).toBe(2)
    expect(dripBatchSize(30)).toBe(Math.ceil(30 / DRIP_MAX_NIGHTS))
  })

  it('submits one deprecate_product proposal for the oldest pending entry and marks it processed', async () => {
    const productId = await seedProduct()
    await db.insert(deprecationQueue).values({ productId, reason: 'not-competitive-vs-amazon' })

    const submit = vi.fn(async () => ({ id: '11111111-2222-4333-8444-555555555555', status: 'pending' as const }))
    const alert = vi.fn(async () => {})
    await deprecationDripHandler({ db, alert, submitDeps, submit: submit as never })()

    expect(submit).toHaveBeenCalledTimes(1)
    const [, input] = submit.mock.calls[0]! as unknown as [SubmitProposalDeps, { type: string; payload: { productId: string }; sourceWorkflow: string }]
    expect(input.type).toBe('deprecate_product')
    expect(input.payload.productId).toBe(productId)
    expect(input.sourceWorkflow).toBe('catalog.deprecation-drip')

    const [row] = await db.select().from(deprecationQueue).where(eq(deprecationQueue.productId, productId))
    expect(row!.processedAt).not.toBeNull()
    expect(row!.proposalId).toBe('11111111-2222-4333-8444-555555555555')
    expect(alert).toHaveBeenCalledWith('info', 'deprecation_drip_ran', { processed: 1, remaining: 0 })
  })

  it('an already-deprecated product is marked processed WITHOUT a proposal', async () => {
    const productId = await seedProduct('deprecated')
    await db.insert(deprecationQueue).values({ productId, reason: 'not-competitive-vs-amazon' })

    const submit = vi.fn(async () => ({ id: 'nope', status: 'pending' as const }))
    await deprecationDripHandler({ db, alert: vi.fn(async () => {}), submitDeps, submit: submit as never })()

    expect(submit).not.toHaveBeenCalled()
    const [row] = await db.select().from(deprecationQueue).where(eq(deprecationQueue.productId, productId))
    expect(row!.processedAt).not.toBeNull()
  })

  it('a submit failure alerts and leaves the entry unprocessed for the next night', async () => {
    const productId = await seedProduct()
    await db.insert(deprecationQueue).values({ productId, reason: 'not-competitive-vs-amazon' })

    const submit = vi.fn(async () => {
      throw new Error('telegram down')
    })
    const alert = vi.fn(async () => {})
    await deprecationDripHandler({ db, alert, submitDeps, submit: submit as never })()

    expect(alert).toHaveBeenCalledWith('warning', 'deprecation_drip_failed', expect.objectContaining({ productId }))
    const [row] = await db.select().from(deprecationQueue).where(eq(deprecationQueue.productId, productId))
    expect(row!.processedAt).toBeNull()
  })
})
