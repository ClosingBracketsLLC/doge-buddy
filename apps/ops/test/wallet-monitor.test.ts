import { auditLog, createDb, orders, supplierOrders } from '@doge-buddy/db'
import { MockSupplierAdapter } from '@doge-buddy/supplier'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAlerter } from '../src/alerts.ts'
import { FULFILLMENT_RETRY_OPTS } from '../src/fulfillment/run-place-order.ts'
import { cjWalletMonitorHandler, executeWalletMonitor, type WalletMonitorDeps } from '../src/jobs/cj-wallet-monitor.ts'
import { createSettings, SETTINGS_DEFAULTS } from '../src/settings.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

let uid = 0
function nextId(): string {
  uid += 1
  return `${Date.now()}${uid}`
}
function orderGidFor(): string {
  return `gid://shopify/Order/${nextId()}`
}

describe('executeWalletMonitor', () => {
  const { db, pool } = createDb(url)
  const settings = createSettings(db)
  afterAll(() => pool.end())

  let createdOrderIds: string[] = []
  let createdSupplierOrderIds: string[] = []

  // `executeWalletMonitor`'s awaiting_funds query is deliberately unscoped (same stance
  // `run-reconcile.ts`'s sweeps 2-4 take — a real run has to see the whole table, not just rows a
  // test created). But other test files (`fulfillment-pay-order.test.ts`'s insufficient-balance
  // tests, in particular) create real `awaiting_funds` rows — some with no `total_amount_cents`
  // set at all — and never clean them up, because this test database is shared and persistent
  // across the whole suite, not reset between files or between runs. Left alone, that leftover
  // data would make every sum/NULL-guard assertion below non-deterministic depending on what ran
  // before this file. Clearing every `awaiting_funds` row before each test here establishes a
  // clean baseline; nothing downstream of this file depends on that leftover data still existing.
  //
  // `settings` is the same story for the two keys this file touches: one shared row per key
  // across the whole suite, reset here so no earlier test's override leaks in.
  beforeEach(async () => {
    createdOrderIds = []
    createdSupplierOrderIds = []
    await db.delete(supplierOrders).where(eq(supplierOrders.status, 'awaiting_funds'))
    await settings.set('fulfillment.paused_for_funds', SETTINGS_DEFAULTS['fulfillment.paused_for_funds'])
    await settings.set(
      'fulfillment.wallet_alert_threshold_cents',
      SETTINGS_DEFAULTS['fulfillment.wallet_alert_threshold_cents'],
    )
  })

  afterEach(async () => {
    if (createdSupplierOrderIds.length > 0) {
      await db.delete(supplierOrders).where(inArray(supplierOrders.id, createdSupplierOrderIds))
    }
    if (createdOrderIds.length > 0) {
      await db.delete(orders).where(inArray(orders.id, createdOrderIds))
    }
  })

  function makeDeps(balanceCents: number): { deps: WalletMonitorDeps; enqueue: ReturnType<typeof vi.fn> } {
    const adapter = new MockSupplierAdapter()
    vi.spyOn(adapter, 'getBalance').mockResolvedValue({ availableCents: balanceCents, frozenCents: 0 })
    const enqueue = vi.fn(async () => {})
    const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const deps: WalletMonitorDeps = {
      db,
      adapter,
      settings,
      alert: createAlerter(db, mockLog),
      enqueue,
    }
    return { deps, enqueue }
  }

  async function seedOrder(): Promise<string> {
    const [row] = await db
      .insert(orders)
      .values({ shopifyOrderGid: orderGidFor(), isTest: false, totalCents: 10_000 })
      .returning({ id: orders.id })
    createdOrderIds.push(row!.id)
    return row!.id
  }

  async function seedAwaitingFunds(orderRowId: string, totalAmountCents: number | null): Promise<string> {
    const [row] = await db
      .insert(supplierOrders)
      .values({
        orderId: orderRowId,
        supplier: 'mock',
        idempotencyKey: `test-${nextId()}`,
        status: 'awaiting_funds',
        totalAmountCents,
      })
      .returning({ id: supplierOrders.id })
    createdSupplierOrderIds.push(row!.id)
    return row!.id
  }

  async function loadSupplierOrder(id: string) {
    const [row] = await db.select().from(supplierOrders).where(eq(supplierOrders.id, id))
    return row
  }

  // Audit log rows are never deleted (by this file or any other), so a raw "all rows for this
  // kind" query grows across the whole suite's lifetime — fine for `.find()`-style positive
  // assertions (as `fulfillment-reconcile.test.ts` does), but an absolute `.toHaveLength(0)` on it
  // would be a false failure the moment ANY earlier test (in this file or an earlier one) fired
  // the same alert kind. `alertIds`/`alertsSince` below turn every assertion into a before/after
  // delta instead, so it only ever reflects what THIS test's call actually did.
  async function alertRowsFor(kind: string) {
    return db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'alert'), eq(auditLog.action, `alert.${kind}`)))
  }
  async function alertIds(kind: string): Promise<Set<bigint>> {
    return new Set((await alertRowsFor(kind)).map((r) => r.id))
  }
  async function alertsSince(kind: string, before: Set<bigint>) {
    return (await alertRowsFor(kind)).filter((r) => !before.has(r.id))
  }

  it('healthy balance, not paused: no alerts, no enqueues, flag untouched', async () => {
    const { deps, enqueue } = makeDeps(50_000)
    const lowBefore = await alertIds('wallet_low')
    const recoveredBefore = await alertIds('wallet_recovered')

    await executeWalletMonitor(deps)

    expect(enqueue).not.toHaveBeenCalled()
    expect(await alertsSince('wallet_low', lowBefore)).toHaveLength(0)
    expect(await alertsSince('wallet_recovered', recoveredBefore)).toHaveLength(0)
    expect(await settings.get('fulfillment.paused_for_funds')).toBe(false)
  })

  it('balance below threshold (not paused): fires wallet_low critical alert, no resume logic runs', async () => {
    const { deps, enqueue } = makeDeps(1_000) // default threshold is 2000
    const lowBefore = await alertIds('wallet_low')

    await executeWalletMonitor(deps)

    const newAlerts = await alertsSince('wallet_low', lowBefore)
    expect(newAlerts).toHaveLength(1)
    expect(newAlerts[0]!.detail).toMatchObject({ severity: 'critical', availableCents: 1_000, thresholdCents: 2_000 })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('balance below threshold AND paused: wallet_low still fires (independent of pause state)', async () => {
    await settings.set('fulfillment.paused_for_funds', true)
    const orderRowId = await seedOrder()
    await seedAwaitingFunds(orderRowId, 50_000) // wallet can't cover this either — stays paused

    const { deps } = makeDeps(1_000)
    const lowBefore = await alertIds('wallet_low')

    await executeWalletMonitor(deps)

    const newAlerts = await alertsSince('wallet_low', lowBefore)
    expect(newAlerts).toHaveLength(1)
    expect(newAlerts[0]!.detail).toMatchObject({ severity: 'critical', availableCents: 1_000 })
  })

  it('paused + balance covers the full sum of awaiting_funds rows: clears the flag, enqueues each row, fires wallet_recovered', async () => {
    await settings.set('fulfillment.paused_for_funds', true)
    const orderA = await seedOrder()
    const orderB = await seedOrder()
    const rowAId = await seedAwaitingFunds(orderA, 3_000)
    const rowBId = await seedAwaitingFunds(orderB, 4_000)

    const { deps, enqueue } = makeDeps(10_000) // >= 3000 + 4000
    const recoveredBefore = await alertIds('wallet_recovered')

    await executeWalletMonitor(deps)

    expect(await settings.get('fulfillment.paused_for_funds')).toBe(false)

    expect(enqueue).toHaveBeenCalledTimes(2)
    expect(enqueue).toHaveBeenCalledWith(
      'fulfillment.pay-order',
      { supplierOrderRowId: rowAId },
      { singletonKey: rowAId, ...FULFILLMENT_RETRY_OPTS },
    )
    expect(enqueue).toHaveBeenCalledWith(
      'fulfillment.pay-order',
      { supplierOrderRowId: rowBId },
      { singletonKey: rowBId, ...FULFILLMENT_RETRY_OPTS },
    )

    const newAlerts = await alertsSince('wallet_recovered', recoveredBefore)
    expect(newAlerts).toHaveLength(1)
    expect(newAlerts[0]!.detail).toMatchObject({ severity: 'info', resumedCount: 2, availableCents: 10_000 })

    // Rows themselves are untouched by wallet-monitor — pay-order (the job just enqueued) is what
    // actually transitions them, not this executor.
    expect((await loadSupplierOrder(rowAId))?.status).toBe('awaiting_funds')
    expect((await loadSupplierOrder(rowBId))?.status).toBe('awaiting_funds')
  })

  it('paused + balance short of the sum: stays paused, zero enqueues, no wallet_recovered alert', async () => {
    await settings.set('fulfillment.paused_for_funds', true)
    const orderA = await seedOrder()
    const orderB = await seedOrder()
    await seedAwaitingFunds(orderA, 3_000)
    await seedAwaitingFunds(orderB, 4_000)

    const { deps, enqueue } = makeDeps(5_000) // < 3000 + 4000, but >= 2000 threshold (no wallet_low either)
    const recoveredBefore = await alertIds('wallet_recovered')
    const lowBefore = await alertIds('wallet_low')

    await executeWalletMonitor(deps)

    expect(await settings.get('fulfillment.paused_for_funds')).toBe(true)
    expect(enqueue).not.toHaveBeenCalled()
    expect(await alertsSince('wallet_recovered', recoveredBefore)).toHaveLength(0)
    expect(await alertsSince('wallet_low', lowBefore)).toHaveLength(0)
  })

  it('paused + one awaiting_funds row has a NULL total_amount_cents: skips resume entirely, alerts wallet_resume_blocked, flag stays true, zero enqueues', async () => {
    await settings.set('fulfillment.paused_for_funds', true)
    const orderA = await seedOrder()
    const orderB = await seedOrder()
    await seedAwaitingFunds(orderA, 1_000) // known amount
    await seedAwaitingFunds(orderB, null) // unknown amount — blocks resuming BOTH

    const { deps, enqueue } = makeDeps(1_000_000) // balance would trivially cover any real sum
    const blockedBefore = await alertIds('wallet_resume_blocked')
    const recoveredBefore = await alertIds('wallet_recovered')

    await executeWalletMonitor(deps)

    expect(await settings.get('fulfillment.paused_for_funds')).toBe(true)
    expect(enqueue).not.toHaveBeenCalled()

    const newAlerts = await alertsSince('wallet_resume_blocked', blockedBefore)
    expect(newAlerts).toHaveLength(1)
    expect(newAlerts[0]!.detail).toMatchObject({ severity: 'warning', reason: 'unknown_amounts' })

    expect(await alertsSince('wallet_recovered', recoveredBefore)).toHaveLength(0)
  })

  it('paused with zero awaiting_funds rows: vacuous sum (0) is trivially covered — clears the flag, zero enqueues, still alerts wallet_recovered', async () => {
    await settings.set('fulfillment.paused_for_funds', true)

    const { deps, enqueue } = makeDeps(50_000)
    const recoveredBefore = await alertIds('wallet_recovered')

    await executeWalletMonitor(deps)

    expect(await settings.get('fulfillment.paused_for_funds')).toBe(false)
    expect(enqueue).not.toHaveBeenCalled()

    const newAlerts = await alertsSince('wallet_recovered', recoveredBefore)
    expect(newAlerts).toHaveLength(1)
    expect(newAlerts[0]!.detail).toMatchObject({ severity: 'info', resumedCount: 0 })
  })

  it('not paused: awaiting_funds rows (if any exist from a stale state) are never queried/touched', async () => {
    const orderA = await seedOrder()
    const rowId = await seedAwaitingFunds(orderA, 3_000)

    const { deps, enqueue } = makeDeps(50_000)
    const recoveredBefore = await alertIds('wallet_recovered')

    await executeWalletMonitor(deps)

    expect(enqueue).not.toHaveBeenCalled()
    expect((await loadSupplierOrder(rowId))?.status).toBe('awaiting_funds')
    expect(await alertsSince('wallet_recovered', recoveredBefore)).toHaveLength(0)
  })
})

describe('cjWalletMonitorHandler', () => {
  const { db, pool } = createDb(url)
  const settings = createSettings(db)
  afterAll(() => pool.end())

  beforeEach(() => settings.set('fulfillment.paused_for_funds', false))

  it('cron job wrapper: calls executeWalletMonitor (via getBalance) once per job in the batch', async () => {
    const adapter = new MockSupplierAdapter()
    const getBalanceSpy = vi.spyOn(adapter, 'getBalance').mockResolvedValue({ availableCents: 50_000, frozenCents: 0 })
    const enqueue = vi.fn(async () => {})
    const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const deps: WalletMonitorDeps = { db, adapter, settings, alert: createAlerter(db, mockLog), enqueue }

    await cjWalletMonitorHandler(deps)([
      { id: 'job-1', name: 'cj.wallet-monitor', data: {}, expireInSeconds: 900 },
      { id: 'job-2', name: 'cj.wallet-monitor', data: {}, expireInSeconds: 900 },
    ])

    expect(getBalanceSpy).toHaveBeenCalledTimes(2)
  })
})
