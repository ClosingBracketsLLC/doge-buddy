import { createDb, proposals, orders, supportTickets } from '@doge-buddy/db'
import type { RefundPayload } from '@doge-buddy/core'
import { and, eq, inArray } from 'drizzle-orm'
import PgBoss from 'pg-boss'
import { createAlerter } from '../src/alerts.ts'
import { loadConfig } from '../src/config.ts'
import type { SendOpts } from '../src/fulfillment/types.ts'
import { loadDotEnv } from '../src/load-env.ts'
import type { NotifyOwner, OwnerNotification } from '../src/notify/notify.ts'
import { createTelegramNotifier } from '../src/notify/telegram.ts'
import { submitProposal } from '../src/proposals/submit.ts'
import { createSettings } from '../src/settings.ts'

/**
 * Manual, credential-gated Tier-2 helper (6B walk #2): seeds ONE `refund` proposal for a given
 * Shopify order through the real `submitProposal` path, so the owner gets the real Telegram
 * approve/reject pair and the DEPLOYED apply worker performs the live `refundCreate`. Exists
 * because the agent will not — correctly — draft a refund the policy doesn't cover, and a test
 * order (which never ships) supports no consistent damage/non-delivery story. Refunds are
 * hard-locked to manual, so this can never auto-apply. Idempotent on the summary.
 *
 *   DATABASE_URL='<railway>' pnpm --filter @doge-buddy/ops seed-refund-proposal <orderNumber> <amountCents> [ticketId]
 */
if (loadDotEnv(import.meta.url)) {
  console.log('seed-refund-proposal: loaded apps/ops/.env (existing environment variables take precedence)')
}
const config = loadConfig(process.env)
const [orderNumberArg, amountArg, ticketIdArg] = process.argv.slice(2)
if (!orderNumberArg || !amountArg) {
  console.error('usage: seed-refund-proposal <orderNumber> <amountCents> [ticketId]')
  process.exit(2)
}
const amountCents = Number(amountArg)
if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error(`bad amountCents: ${amountArg}`)

function teeNotifier(inner: NotifyOwner): { notify: NotifyOwner; box: { sent?: OwnerNotification } } {
  const box: { sent?: OwnerNotification } = {}
  const notify: NotifyOwner = async (n) => {
    box.sent = n
    return inner(n)
  }
  return { notify, box }
}

const { db, pool } = createDb(config.databaseUrl)
const log = {
  info: (o: unknown, m: string) => console.log(m, o),
  warn: (o: unknown, m: string) => console.warn(m, o),
  error: (o: unknown, m: string) => console.error(m, o),
}
const alert = createAlerter(db, log)
const settings = createSettings(db)
const baseNotifier: NotifyOwner = config.telegram
  ? createTelegramNotifier({ ...config.telegram, alert })
  : async (n) => {
      console.log(`[console-notify] ${n.title}\n${n.body}`)
      for (const action of n.actions ?? []) console.log(`  ${action.label}: ${action.url}`)
      return true
    }
const { notify, box } = teeNotifier(baseNotifier)

let failed = false
try {
  const [order] = await db.select().from(orders).where(eq(orders.shopifyOrderNumber, orderNumberArg))
  if (!order) throw new Error(`no order with shopify_order_number ${orderNumberArg} in this database`)
  if (ticketIdArg) {
    const [ticket] = await db.select({ id: supportTickets.id }).from(supportTickets).where(eq(supportTickets.id, ticketIdArg))
    if (!ticket) throw new Error(`no support ticket ${ticketIdArg}`)
  }
  const summary = `Seed: refund $${(amountCents / 100).toFixed(2)} order #${order.shopifyOrderNumber} — Tier-2 walk #2`
  const [existing] = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.summary, summary), inArray(proposals.status, ['pending', 'approved', 'applying', 'applied'])))
  if (existing) {
    console.log(`seed-refund-proposal: already exists — id=${existing.id} status=${existing.status}`)
  } else {
    const payload: RefundPayload = {
      type: 'refund',
      orderId: order.id,
      shopifyOrderGid: order.shopifyOrderGid,
      amountCents,
      reason: 'Tier-2 walk #2: owner-instructed full refund on the test order (cannot be replaced).',
      openCjDispute: false,
      threadSnapshotAt: new Date().toISOString(),
    }
    const boss = new PgBoss(config.databaseUrl)
    boss.on('error', (e) => console.error('[pg-boss]', e))
    await boss.start()
    try {
      const enqueue = async (name: string, data: object, opts?: SendOpts): Promise<void> => {
        if (opts) await boss.send(name, data, opts)
        else await boss.send(name, data)
      }
      const adminBaseUrl = config.adminBaseUrl ?? 'http://localhost:3001'
      const result = await submitProposal(
        { db, settings, notify, enqueue, alert, adminBaseUrl },
        { type: 'refund', summary, payload, sourceWorkflow: 'seed-refund-proposal-script', ticketId: ticketIdArg, orderId: order.id },
      )
      console.log(`seed-refund-proposal: created — id=${result.id} status=${result.status}`)
      for (const action of box.sent?.actions ?? []) console.log(`seed-refund-proposal: ${action.label} -> ${action.url}`)
    } finally {
      await boss.stop()
    }
  }
} catch (err) {
  failed = true
  console.error('seed-refund-proposal: FAILED —', err instanceof Error ? err.message.slice(0, 500) : String(err))
} finally {
  await pool.end()
}
process.exit(failed ? 1 : 0)
