import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { fileURLToPath } from 'node:url'
import * as schema from './schema.ts'

export function createDb(
  connectionString: string,
  poolConfig?: Omit<pg.PoolConfig, 'connectionString'>,
): { db: NodePgDatabase<typeof schema>; pool: pg.Pool } {
  const pool = new pg.Pool({ ...poolConfig, connectionString })
  return { db: drizzle(pool, { schema }), pool }
}

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url))

export async function runMigrations(connectionString: string): Promise<void> {
  const { db, pool } = createDb(connectionString)
  try {
    await migrate(db, { migrationsFolder })
  } finally {
    await pool.end()
  }
}
