import Fastify, { type FastifyInstance } from 'fastify'
import type pg from 'pg'

export interface ServerDeps {
  pool: pg.Pool
  isQueueReady: () => boolean
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: true })
  const startedAt = Date.now()

  app.get('/healthz', async (_req, reply) => {
    let db: 'ok' | 'error' = 'ok'
    try {
      await deps.pool.query('SELECT 1')
    } catch {
      db = 'error'
    }
    const queue = deps.isQueueReady() ? 'ok' : 'stopped'
    const status = db === 'ok' && queue === 'ok' ? 'ok' : 'degraded'
    const body = {
      status,
      db,
      queue,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    }
    // A stopped queue is a graceful-drain state, not a liveness failure — stay 200 so
    // orchestrators don't kill the service mid-drain. Only a db error is a hard failure.
    return reply.code(db === 'ok' ? 200 : 503).send(body)
  })

  return app
}
