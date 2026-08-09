import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { buildServer } from '../src/server.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

describe('GET /healthz', () => {
  const pool = new pg.Pool({ connectionString: url })
  afterAll(() => pool.end())

  it('returns 200 with db ok and queue status', async () => {
    const app = buildServer({ pool, isQueueReady: () => true })
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ok')
    expect(body.db).toBe('ok')
    expect(body.queue).toBe('ok')
    expect(typeof body.uptimeSeconds).toBe('number')
    await app.close()
  })

  it('returns 503 when the db is unreachable', async () => {
    const badPool = new pg.Pool({ connectionString: 'postgres://doge:doge@localhost:1/nope', connectionTimeoutMillis: 300 })
    const app = buildServer({ pool: badPool, isQueueReady: () => true })
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(503)
    expect(res.json().db).toBe('error')
    await app.close()
    await badPool.end()
  })
})
