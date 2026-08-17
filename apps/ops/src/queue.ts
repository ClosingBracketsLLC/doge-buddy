import { createDb } from '@doge-buddy/db'
import PgBoss from 'pg-boss'
import { demoPingHandler } from './jobs/demo-ping.ts'
import { webhookProcessHandler } from './jobs/webhook-process.ts'

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

  await boss.createQueue('webhook.shopify.process')
  await boss.work('webhook.shopify.process', webhookProcessHandler(db, 'shopify'))

  await boss.createQueue('webhook.cj.process')
  await boss.work('webhook.cj.process', webhookProcessHandler(db, 'cj'))

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

/**
 * Creates a queue (if needed), registers its worker, and schedules it on a cron. Used for
 * recurring jobs like `shopify.webhook-audit` that aren't triggered by application events.
 */
export async function registerCron<ReqData extends object = object>(
  boss: PgBoss,
  name: string,
  cron: string,
  handler: PgBoss.WorkHandler<ReqData>,
): Promise<void> {
  await boss.createQueue(name)
  await boss.work(name, handler)
  await boss.schedule(name, cron)
}
