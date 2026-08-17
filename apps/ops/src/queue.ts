import { createDb } from '@doge-buddy/db'
import PgBoss from 'pg-boss'
import { demoPingHandler } from './jobs/demo-ping.ts'

export interface Queue {
  boss: PgBoss
  ready: () => boolean
  stop: () => Promise<void>
}

export async function startQueue(connectionString: string): Promise<Queue> {
  const boss = new PgBoss(connectionString)
  const { db, pool } = createDb(connectionString)
  let running = false

  boss.on('error', (e) => console.error('[pg-boss]', e))
  await boss.start()
  running = true

  await boss.createQueue('demo.ping')
  await boss.work('demo.ping', demoPingHandler(db))

  // Workers land in Task 12; creating the queues now keeps webhook enqueue-then-ack safe
  // to call as soon as the ops service boots.
  await boss.createQueue('webhook.shopify.process')
  await boss.createQueue('webhook.cj.process')

  return {
    boss,
    ready: () => running,
    stop: async () => {
      running = false
      await boss.stop({ graceful: true, wait: true })
      await pool.end()
    },
  }
}
