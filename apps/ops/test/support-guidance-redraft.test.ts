import { describe, expect, it, afterAll, afterEach } from 'vitest'
import { createDb, settings as settingsTable } from '@doge-buddy/db'
import { eq, sql } from 'drizzle-orm'
import { createSettings } from '../src/settings.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

describe('migration 0007: support_tickets redraft columns', () => {
  const { db, pool } = createDb(url)

  afterAll(() => pool.end())

  it('adds owner_redraft_feedback and redraft_count with correct defaults', async () => {
    const { rows } = await db.execute(sql`
      select column_name, data_type, column_default, is_nullable
      from information_schema.columns
      where table_name = 'support_tickets'
        and column_name in ('owner_redraft_feedback', 'redraft_count')
      order by column_name`)
    const byName = Object.fromEntries((rows as any[]).map((r) => [r.column_name, r]))
    expect(byName['owner_redraft_feedback'].is_nullable).toBe('YES')
    expect(byName['redraft_count'].data_type).toBe('integer')
    expect(byName['redraft_count'].is_nullable).toBe('NO')
    expect(String(byName['redraft_count'].column_default)).toContain('0')
  })
})

describe('settings: support.agent_guidance', () => {
  const { db, pool } = createDb(url)

  afterAll(() => pool.end())

  afterEach(async () => {
    // Settings hygiene (same idiom as admin-settings.test.ts): `settings` is a shared table
    // across the whole test suite. Deleting the row restores `get()` to the code default
    // regardless of what this test wrote, and is safe to run unconditionally every time.
    await db.delete(settingsTable).where(eq(settingsTable.key, 'support.agent_guidance'))
  })

  it('defaults to empty string and round-trips a string', async () => {
    const settings = createSettings(db)
    expect(await settings.get('support.agent_guidance')).toBe('')
    await settings.set('support.agent_guidance', 'No returns just because the dog disliked it.')
    expect(await settings.get('support.agent_guidance')).toBe('No returns just because the dog disliked it.')
  })
})
