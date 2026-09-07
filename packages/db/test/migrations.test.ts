import { Client } from 'pg'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { createDb, runMigrations, settings } from '@doge-buddy/db'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'
// Isolated database per run so the test always starts fresh.
const testDbName = `migration_test_${Date.now()}`
const adminUrl = url
const testUrl = url.replace(/\/[^/]+$/, `/${testDbName}`)

const EXPECTED_TABLES = [
  'products', 'product_variants', 'supplier_variant_mappings',
  'orders', 'supplier_orders', 'webhook_events',
  'support_tickets', 'support_messages', 'gmail_sync_state',
  'proposals', 'product_scores', 'sourcing_signals',
  'agent_runs', 'agent_run_events', 'audit_log',
  'settings', 'cj_auth', 'admin_sessions', 'agent_sessions', 'deprecation_queue',
  'agent_session_entries',
].sort()

describe('migrations', () => {
  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl })
    await admin.connect()
    await admin.query(`CREATE DATABASE ${testDbName}`)
    await admin.end()
  })

  it('applies cleanly to a fresh database and creates all 21 tables', async () => {
    await runMigrations(testUrl)
    const c = new Client({ connectionString: testUrl })
    await c.connect()
    const res = await c.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       AND table_name NOT LIKE '\\_\\_drizzle%' ESCAPE '\\'
       ORDER BY table_name`,
    )
    await c.end()
    expect(res.rows.map((r) => r.table_name)).toEqual(EXPECTED_TABLES)
  })

  it('is idempotent (running twice is a no-op)', async () => {
    await expect(runMigrations(testUrl)).resolves.not.toThrow()
  })

  it('enforces the supplier_orders idempotency uniques', async () => {
    const c = new Client({ connectionString: testUrl })
    await c.connect()
    const { rows: orderRows } = await c.query(
      `INSERT INTO orders (shopify_order_gid, is_test, email) VALUES ('gid://shopify/Order/1', false, 'x@y.z') RETURNING id`,
    )
    const orderId = orderRows[0].id
    await c.query(
      `INSERT INTO supplier_orders (order_id, supplier, idempotency_key, status) VALUES ($1, 'cj', 'DB-1', 'pending')`,
      [orderId],
    )
    await expect(
      c.query(
        `INSERT INTO supplier_orders (order_id, supplier, idempotency_key, status) VALUES ($1, 'cj', 'DB-other', 'pending')`,
        [orderId],
      ),
    ).rejects.toThrow(/unique|duplicate/i)
    await c.end()
  })

  it('allows two legs of one order (migration 0013) and still rejects a duplicate leg', async () => {
    const c = new Client({ connectionString: testUrl })
    await c.connect()
    const { rows: orderRows } = await c.query(
      `INSERT INTO orders (shopify_order_gid, is_test, email) VALUES ('gid://shopify/Order/legs', false, 'x@y.z') RETURNING id`,
    )
    const orderId = orderRows[0].id
    // A mixed-origin cart is one supplier order per warehouse — the split the affordable-catalog
    // pivot needs, and the reason the unique key carries the warehouse.
    for (const origin of ['US', 'CN']) {
      await c.query(
        `INSERT INTO supplier_orders (order_id, supplier, idempotency_key, status, warehouse_country)
         VALUES ($1, 'cj', $2, 'pending', $3)`,
        [orderId, `db-legs-${origin}`, origin],
      )
    }
    const { rows: legs } = await c.query(`SELECT warehouse_country FROM supplier_orders WHERE order_id = $1 ORDER BY 1`, [orderId])
    expect(legs.map((r) => r.warehouse_country)).toEqual(['CN', 'US'])

    // The same (order, supplier, warehouse) is still exactly one row.
    await expect(
      c.query(
        `INSERT INTO supplier_orders (order_id, supplier, idempotency_key, status, warehouse_country)
         VALUES ($1, 'cj', 'db-legs-dup', 'pending', 'US')`,
        [orderId],
      ),
    ).rejects.toThrow(/unique|duplicate/i)
    await c.end()
  })

  it('supplier_variant_mappings carries the origin and the buyer window (migration 0013)', async () => {
    const c = new Client({ connectionString: testUrl })
    await c.connect()
    const res = await c.query(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'supplier_variant_mappings'
       AND column_name IN ('warehouse_country', 'delivery_max_days') ORDER BY column_name`,
    )
    await c.end()
    expect(res.rows).toEqual([
      // Nullable: every pre-pivot row has no stored window and falls back to the setting.
      { column_name: 'delivery_max_days', data_type: 'integer', is_nullable: 'YES', column_default: null },
      { column_name: 'warehouse_country', data_type: 'text', is_nullable: 'NO', column_default: "'US'::text" },
    ])
  })

  it('bumps updated_at on a drizzle update via $onUpdate', async () => {
    const { db, pool } = createDb(testUrl)
    try {
      await db.insert(settings).values({ key: 'onupdate-test', value: { n: 1 } })
      const [before] = await db.select().from(settings).where(eq(settings.key, 'onupdate-test'))

      await new Promise((resolve) => setTimeout(resolve, 20))

      await db.update(settings).set({ value: { n: 2 } }).where(eq(settings.key, 'onupdate-test'))
      const [after] = await db.select().from(settings).where(eq(settings.key, 'onupdate-test'))

      expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime())
    } finally {
      await pool.end()
    }
  })

  it('signal_source enum includes market_price (migration 0010)', async () => {
    const c = new Client({ connectionString: testUrl })
    await c.connect()
    const res = await c.query(`SELECT unnest(enum_range(NULL::signal_source))::text AS v`)
    await c.end()
    expect(res.rows.map((r) => r.v)).toContain('market_price')
  })

  it('signal_source enum includes trends_rising (migration 0011)', async () => {
    const c = new Client({ connectionString: testUrl })
    await c.connect()
    const res = await c.query(`SELECT unnest(enum_range(NULL::signal_source))::text AS v`)
    await c.end()
    expect(res.rows.map((r) => r.v)).toContain('trends_rising')
  })

  it('proposals has a nullable decision_context jsonb column (migration 0011)', async () => {
    const c = new Client({ connectionString: testUrl })
    await c.connect()
    const res = await c.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'proposals' AND column_name = 'decision_context'`,
    )
    await c.end()
    expect(res.rows).toEqual([{ data_type: 'jsonb', is_nullable: 'YES' }])
  })
})
