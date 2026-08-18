import { createDb } from '@doge-buddy/db'
import PgBoss from 'pg-boss'
import type { SendOpts } from './fulfillment/types.ts'
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

  // pg-boss's 3-arg `send` overload requires a real SendOptions object (not `undefined`), so
  // this only forwards `opts` when the caller actually passed one.
  const enqueue = async (name: string, data: object, opts?: SendOpts): Promise<void> => {
    if (opts) {
      await boss.send(name, data, opts)
    } else {
      await boss.send(name, data)
    }
  }

  await boss.createQueue('demo.ping')
  await boss.work('demo.ping', demoPingHandler(db))

  await boss.createQueue('webhook.shopify.process')
  await boss.work('webhook.shopify.process', webhookProcessHandler({ db, enqueue }, 'shopify'))

  await boss.createQueue('webhook.cj.process')
  await boss.work('webhook.cj.process', webhookProcessHandler({ db, enqueue }, 'cj'))

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
