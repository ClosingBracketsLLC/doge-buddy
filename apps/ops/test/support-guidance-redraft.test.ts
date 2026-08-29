import { describe, expect, it, afterAll } from 'vitest'
import { createDb } from '@doge-buddy/db'
import { sql } from 'drizzle-orm'

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
