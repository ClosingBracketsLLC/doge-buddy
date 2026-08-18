import { createDb, orders, supplierOrders } from '@doge-buddy/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  applyTransition,
  canTransition,
  IllegalTransitionError,
  StaleStatusError,
  type SupplierOrderStatusDb,
} from '../src/fulfillment/transitions.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

const ALL_STATUSES: SupplierOrderStatusDb[] = [
  'pending', 'created', 'confirmed', 'paid', 'shipped', 'delivered',
  'cancelled', 'failed', 'needs_attention', 'awaiting_funds',
]

// Independent transcription of the brief's exhaustive legal matrix (not derived from the
// module under test), so the table-driven test below is a real black-box check.
const LEGAL: Record<SupplierOrderStatusDb, SupplierOrderStatusDb[]> = {
  pending: ['created', 'needs_attention', 'failed'],
  created: ['confirmed', 'needs_attention', 'failed'],
  confirmed: ['paid', 'awaiting_funds', 'needs_attention', 'failed'],
  awaiting_funds: ['paid', 'needs_attention', 'failed'],
  paid: ['shipped', 'needs_attention'],
  shipped: ['delivered', 'needs_attention'],
  needs_attention: ['pending', 'created', 'confirmed', 'paid', 'cancelled'],
  delivered: [],
  cancelled: [],
  failed: [],
}

const allPairs = ALL_STATUSES.flatMap((from) =>
  ALL_STATUSES.map((to) => ({ from, to, legal: LEGAL[from].includes(to) })),
)

describe('canTransition', () => {
  it('covers every from x to pair exactly once (10 statuses -> 100 pairs)', () => {
    expect(ALL_STATUSES).toHaveLength(10)
    expect(allPairs).toHaveLength(100)
  })

  it.each(allPairs)('$from -> $to is legal=$legal', ({ from, to, legal }) => {
    expect(canTransition(from, to)).toBe(legal)
  })

  it('is always false for a same-status self-transition', () => {
    for (const status of ALL_STATUSES) {
      expect(canTransition(status, status)).toBe(false)
    }
  })
})

describe('applyTransition', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  beforeEach(async () => {
    // Children before parent — supplier_orders.order_id FKs to orders.id.
    await db.delete(supplierOrders)
    await db.delete(orders)
  })

  async function seedOrder(): Promise<string> {
    const [order] = await db
      .insert(orders)
      .values({
        shopifyOrderGid: `gid://shopify/Order/${crypto.randomUUID()}`,
        isTest: false,
      })
      .returning({ id: orders.id })
    return order!.id
  }

  async function seedSupplierOrder(status: SupplierOrderStatusDb): Promise<string> {
    const orderId = await seedOrder()
    const [row] = await db
      .insert(supplierOrders)
      .values({
        orderId,
        supplier: 'mock',
        idempotencyKey: crypto.randomUUID(),
        status,
      })
      .returning({ id: supplierOrders.id })
    return row!.id
  }

  it('happy path: persists the new status and the patch fields', async () => {
    const id = await seedSupplierOrder('confirmed')
    const paidAt = new Date('2026-08-18T00:00:00.000Z')

    await applyTransition(db, id, 'confirmed', 'paid', {
      productAmountCents: 1200,
      postageAmountCents: 300,
      totalAmountCents: 1500,
      paidAt,
    })

    const [row] = await db.select().from(supplierOrders).where(eq(supplierOrders.id, id))
    expect(row?.status).toBe('paid')
    expect(row?.productAmountCents).toBe(1200)
    expect(row?.postageAmountCents).toBe(300)
    expect(row?.totalAmountCents).toBe(1500)
    expect(row?.paidAt?.toISOString()).toBe(paidAt.toISOString())
  })

  it('throws IllegalTransitionError and leaves the row untouched for an illegal pair', async () => {
    const id = await seedSupplierOrder('pending')

    await expect(applyTransition(db, id, 'pending', 'paid')).rejects.toThrow(IllegalTransitionError)

    const [row] = await db.select().from(supplierOrders).where(eq(supplierOrders.id, id))
    expect(row?.status).toBe('pending')
  })

  it('throws IllegalTransitionError before touching the DB (checked even for a non-existent row)', async () => {
    const bogusId = crypto.randomUUID()

    // If the guard ran after the DB call, a non-existent row would update 0 rows and this
    // would surface as StaleStatusError instead — proving the legality check comes first.
    await expect(applyTransition(db, bogusId, 'delivered', 'pending')).rejects.toThrow(IllegalTransitionError)
  })

  it('throws StaleStatusError when the status changed underneath (optimistic concurrency)', async () => {
    const id = await seedSupplierOrder('confirmed')

    // Simulate a concurrent writer that already moved the row on from `confirmed`.
    await db.update(supplierOrders).set({ status: 'needs_attention' }).where(eq(supplierOrders.id, id))

    await expect(applyTransition(db, id, 'confirmed', 'paid')).rejects.toThrow(StaleStatusError)

    const [row] = await db.select().from(supplierOrders).where(eq(supplierOrders.id, id))
    expect(row?.status).toBe('needs_attention')
  })

  it('error instances carry from/to fields', async () => {
    const id = await seedSupplierOrder('pending')

    try {
      await applyTransition(db, id, 'pending', 'paid')
      expect.unreachable('expected IllegalTransitionError')
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalTransitionError)
      expect((err as IllegalTransitionError).from).toBe('pending')
      expect((err as IllegalTransitionError).to).toBe('paid')
    }

    await db.update(supplierOrders).set({ status: 'needs_attention' }).where(eq(supplierOrders.id, id))
    try {
      await applyTransition(db, id, 'pending', 'created')
      expect.unreachable('expected StaleStatusError')
    } catch (err) {
      expect(err).toBeInstanceOf(StaleStatusError)
      expect((err as StaleStatusError).from).toBe('pending')
      expect((err as StaleStatusError).to).toBe('created')
    }
  })
})
