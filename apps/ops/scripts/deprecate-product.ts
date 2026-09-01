import { createDb, products, proposals } from '@doge-buddy/db'
import type { DeprecateProductPayload } from '@doge-buddy/core'
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
 * Manual, credential-gated: submits ONE `deprecate_product` proposal for a product the owner (or
 * a supplier) has decided is done — the case the weekly scoring judge cannot see, e.g. CJ answering
 * "Variant has been removed from shelves" on a stock read (first seen live 2026-08-31, on the
 * seed-proposal Snuff Pad). The proposal goes through the normal approval path
 * (`workflow.deprecation.mode`: manual → Telegram/admin Approve; auto → applied at once) and the
 * existing executor does the work: product → DRAFT, unpublished everywhere, local row
 * `deprecated`, CJ webhooks torn down. Nothing is deleted.
 *
 * Run where the deployed worker's DB and Telegram bot are configured (inside Railway, like
 * `backfill-listings`):
 *
 *   pnpm --filter @doge-buddy/ops deprecate-product --product <uuid> --reason "<why>"
 *
 * Idempotent: a pending/approved/applying/applied deprecation for the same product is printed
 * and left alone rather than duplicated.
 */

if (loadDotEnv(import.meta.url)) {
  console.log('deprecate-product: loaded apps/ops/.env (existing environment variables take precedence)')
}

const config = loadConfig(process.env)

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const productId = argValue('--product')
const reason = argValue('--reason')
if (!productId || !/^[0-9a-f-]{36}$/i.test(productId) || !reason?.trim()) {
  console.error('usage: deprecate-product --product <product uuid> --reason "<why>"')
  process.exit(2)
}

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
      console.log(`[console-notify] ${n.title}`)
      console.log(n.body)
      for (const action of n.actions ?? []) console.log(`  ${action.label}: ${action.url}`)
      return true
    }
const { notify, box } = teeNotifier(baseNotifier)

let failed = false
try {
  const [product] = await db.select().from(products).where(eq(products.id, productId)).limit(1)
  if (!product) throw new Error(`no product row ${productId}`)
  if (product.status === 'deprecated') {
    console.log(`deprecate-product: ${product.title} is already deprecated — nothing to do`)
  } else {
    const [existing] = await db
      .select({ id: proposals.id, status: proposals.status })
      .from(proposals)
      .where(
        and(
          eq(proposals.type, 'deprecate_product'),
          eq(proposals.productId, productId),
          inArray(proposals.status, ['pending', 'approved', 'applying', 'applied']),
        ),
      )
      .limit(1)
    if (existing) {
      console.log(`deprecate-product: a deprecation already exists — id=${existing.id} status=${existing.status}`)
    } else {
      const daysLive = Math.max(0, Math.floor((Date.now() - product.createdAt.getTime()) / 86_400_000))
      // The evidence block is the judge's shape; a manual deprecation has no 28-day scoring
      // window behind it, so the counters are 0 and `reasoning` carries the operator's reason.
      const payload: DeprecateProductPayload = {
        type: 'deprecate_product',
        productId,
        evidence: { unitsSold28d: 0, refundCount28d: 0, ticketCount28d: 0, daysLive, reasoning: reason.trim() },
      }
      const boss = new PgBoss(config.databaseUrl)
      boss.on('error', (e) => console.error('[pg-boss]', e))
      await boss.start()
      try {
        const enqueue = async (name: string, data: object, opts?: SendOpts): Promise<void> => {
          if (opts) await boss.send(name, data, opts)
          else await boss.send(name, data)
        }
        const result = await submitProposal(
          { db, settings, notify, enqueue, alert, adminBaseUrl: config.adminBaseUrl ?? 'http://localhost:3001' },
          {
            type: 'deprecate_product',
            summary: `Deprecate: ${product.title} — ${reason.trim()}`,
            payload,
            sourceWorkflow: 'deprecate-product-script',
            productId,
          },
        )
        console.log(`deprecate-product: submitted — id=${result.id} status=${result.status}`)
        for (const action of box.sent?.actions ?? []) console.log(`deprecate-product: ${action.label} -> ${action.url}`)
        console.log(
          result.status === 'approved'
            ? 'deprecate-product: auto-approved — the worker applies it next (product → DRAFT, unpublished, row deprecated).'
            : 'deprecate-product: approve it on Telegram or /admin/proposals; the worker then applies it.',
        )
      } finally {
        await boss.stop({ graceful: false })
      }
    }
  }
} catch (err) {
  failed = true
  console.error(`deprecate-product: FAILED — ${err instanceof Error ? err.message : String(err)}`)
} finally {
  await pool.end()
}
process.exit(failed ? 1 : 0)
