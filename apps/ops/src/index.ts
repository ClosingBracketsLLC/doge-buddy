import { createDb } from '@doge-buddy/db'
import { loadConfig } from './config.ts'
import { startQueue } from './queue.ts'
import { buildServer } from './server.ts'

const config = loadConfig(process.env)
const { pool } = createDb(config.databaseUrl)
const queue = await startQueue(config.databaseUrl)
const app = buildServer({ pool, isQueueReady: queue.ready })

await app.listen({ port: config.port, host: config.host })
app.log.info(`ops listening on :${config.port}`)

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  app.log.info(`${signal} received, shutting down`)
  await app.close()
  await queue.stop()
  await pool.end()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
