import { auditLog, createDb } from '@doge-buddy/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAlerter } from '../src/alerts.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

describe('alerts', () => {
  const { db, pool } = createDb(url)

  beforeEach(async () => {
    await db.delete(auditLog).where(eq(auditLog.entityType, 'alert'))
  })
  afterAll(() => pool.end())

  it('alert writes exactly one audit row with correct fields', async () => {
    const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const alert = createAlerter(db, mockLog as any)

    await alert('warning', 'wallet_low', { balanceCents: 1000 })

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'alert'), eq(auditLog.action, 'alert.wallet_low')))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actor: 'system',
      action: 'alert.wallet_low',
      entityType: 'alert',
      detail: { severity: 'warning', balanceCents: 1000 },
    })
  })

  it('alert calls logger at correct level for each severity', async () => {
    const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const alert = createAlerter(db, mockLog as any)

    await alert('info', 'test_info', { msg: 'info message' })
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'test_info', severity: 'info', msg: 'info message' }),
      'alert'
    )

    await alert('warning', 'test_warning', { msg: 'warning message' })
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'test_warning', severity: 'warning', msg: 'warning message' }),
      'alert'
    )

    await alert('critical', 'test_critical', { msg: 'critical message' })
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'test_critical', severity: 'critical', msg: 'critical message' }),
      'alert'
    )
  })
})
