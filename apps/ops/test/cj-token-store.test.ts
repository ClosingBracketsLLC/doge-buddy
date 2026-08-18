import { cjAuth, createDb } from '@doge-buddy/db'
import { sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { DrizzleCjTokenStore } from '../src/stores/cj-token-store.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

describe('DrizzleCjTokenStore', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  it('returns null when nothing has been saved yet', async () => {
    // Ensure a clean slate regardless of test execution order across files.
    await db.delete(cjAuth)
    const store = new DrizzleCjTokenStore(db)
    await expect(store.load()).resolves.toBeNull()
  })

  it('round-trips save -> load, and a second save overwrites the single row', async () => {
    const store = new DrizzleCjTokenStore(db)

    const first = {
      accessToken: 'access-1',
      accessExpiresAt: new Date('2026-09-01T00:00:00.000Z').toISOString(),
      refreshToken: 'refresh-1',
      refreshExpiresAt: new Date('2026-10-01T00:00:00.000Z').toISOString(),
    }
    await store.save(first)
    await expect(store.load()).resolves.toEqual(first)

    const second = {
      accessToken: 'access-2',
      accessExpiresAt: new Date('2026-09-02T00:00:00.000Z').toISOString(),
      refreshToken: 'refresh-2',
      refreshExpiresAt: new Date('2026-10-02T00:00:00.000Z').toISOString(),
    }
    await store.save(second)
    await expect(store.load()).resolves.toEqual(second)

    const rows = await db.select({ count: sql<string>`count(*)` }).from(cjAuth)
    expect(Number(rows[0]!.count)).toBe(1)
  })

  it('invalidate() discards the stored tokens so a subsequent load() returns null', async () => {
    const store = new DrizzleCjTokenStore(db)

    await store.save({
      accessToken: 'access-1',
      accessExpiresAt: new Date('2026-09-01T00:00:00.000Z').toISOString(),
      refreshToken: 'refresh-1',
      refreshExpiresAt: new Date('2026-10-01T00:00:00.000Z').toISOString(),
    })
    await expect(store.load()).resolves.not.toBeNull()

    await store.invalidate()
    await expect(store.load()).resolves.toBeNull()
  })
})
