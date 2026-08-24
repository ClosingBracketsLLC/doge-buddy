import { createDb, proposals } from '@doge-buddy/db'
import type { NewListingPayload } from '@doge-buddy/core'
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
 * Manual, credential-gated Tier-1 walkthrough: seeds one handcrafted `new_listing` proposal
 * against the real database (and, if configured, the real Telegram bot) so the Approve/Reject
 * flow can be exercised end-to-end by hand — pair with `pnpm --filter @doge-buddy/ops dev` in a
 * second terminal, per docs/OWNER-CHECKLIST.md "Phase 4 Tier-2 verification". Not part of the
 * automated test suite (no mocked network), same spirit as verify-live.ts and seed-store.ts.
 * Idempotent on the seed summary: rerunning while a proposal with that summary is still
 * unresolved (or already applied) prints it and exits instead of duplicating.
 */

if (loadDotEnv(import.meta.url)) {
  console.log('seed-proposal: loaded apps/ops/.env (existing environment variables take precedence)')
}

const config = loadConfig(process.env)

const MAX_ERROR_MESSAGE_LENGTH = 500

// Mirrors verify-live.ts's formatError: some underlying errors embed a raw response body, which
// can be an entire HTML error page — truncate so a misconfigured domain doesn't flood the
// terminal.
function formatError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}… (truncated)`
    : message
}

const SEED_SUMMARY = 'Seed: Dog Snuff Pad — margin 53%'

// Live-verified CJ dog-toy product (see docs/OWNER-CHECKLIST.md / verify-live.ts history).
// (2999 - 1414) / 2999 ≈ 53% margin, matching SEED_SUMMARY.
const SEED_PAYLOAD: NewListingPayload = {
  type: 'new_listing',
  title: 'Dog Snuff Pad',
  descriptionHtml:
    '<p>A snuffle-mat pad that turns mealtime into a scent-foraging game — slows down fast eaters ' +
    'and gives anxious dogs something to focus on.</p>',
  categoryTag: 'toys',
  imageUrls: ['https://cf.cjdropshipping.com/0b3c7db4-94ce-46f9-b3d9-9ff6551b29eb.png'],
  shipsFrom: 'US',
  deliveryMinDays: 3,
  deliveryMaxDays: 7,
  variants: [
    {
      sku: 'DB-SNUFFPAD-01',
      priceCents: 2999,
      supplierCostCents: 1414,
      supplier: 'cj',
      supplierProductId: '1952308304475578369',
      supplierVariantId: '1952308304731430913',
    },
  ],
}

/**
 * Tees every notification into `box.sent` before forwarding it to `inner`. With a real Telegram
 * notifier there's no way to read the Approve/Reject URLs back afterward (the proposals row only
 * stores the action-token *hash*) — this lets the script always print them itself, regardless of
 * which notifier actually delivered the message.
 */
function teeNotifier(inner: NotifyOwner): { notify: NotifyOwner; box: { sent?: OwnerNotification } } {
  const box: { sent?: OwnerNotification } = {}
  const notify: NotifyOwner = async (n) => {
    box.sent = n
    return inner(n)
  }
  return { notify, box }
}

const { db, pool } = createDb(config.databaseUrl)

// Console-backed logger for createAlerter — scripts don't pull in pino (the verify-live
// convention).
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
      for (const action of n.actions ?? []) {
        console.log(`  ${action.label}: ${action.url}`)
      }
      return true
    }

const { notify, box } = teeNotifier(baseNotifier)

let failed = false

try {
  const [existing] = await db
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.summary, SEED_SUMMARY),
        inArray(proposals.status, ['pending', 'approved', 'applying', 'applied']),
      ),
    )

  if (existing) {
    console.log(`seed-proposal: already exists — id=${existing.id} status=${existing.status}`)
    if (existing.status === 'pending') {
      console.log(
        "seed-proposal: it's pending, but action URLs can't be re-derived (only the token hash " +
          'is stored) — approve/reject it from the admin UI, or reject it and rerun this script ' +
          'for fresh URLs.',
      )
    }
  } else {
    // Short-lived PgBoss, `send` + `stop` (the deploy-check idiom, docs/deploy-railway.md) —
    // submitProposal only enqueues `proposal.apply` on the auto-approve path (this seed defaults
    // to manual, per workflow.sourcing.mode), but the dep is required either way.
    const boss = new PgBoss(config.databaseUrl)
    boss.on('error', (e) => console.error('[pg-boss]', e))
    await boss.start()

    try {
      // pg-boss's 3-arg `send` overload requires a real SendOptions object (not `undefined`), so
      // this only forwards `opts` when the caller actually passed one — mirrors src/queue.ts.
      const enqueue = async (name: string, data: object, opts?: SendOpts): Promise<void> => {
        if (opts) {
          await boss.send(name, data, opts)
        } else {
          await boss.send(name, data)
        }
      }

      const adminBaseUrl = config.adminBaseUrl ?? 'http://localhost:3001'

      const result = await submitProposal(
        { db, settings, notify, enqueue, alert, adminBaseUrl },
        {
          type: 'new_listing',
          summary: SEED_SUMMARY,
          payload: SEED_PAYLOAD,
          sourceWorkflow: 'seed-proposal-script',
        },
      )

      console.log(`seed-proposal: created — id=${result.id} status=${result.status}`)

      if (box.sent?.actions && box.sent.actions.length > 0) {
        for (const action of box.sent.actions) {
          console.log(`seed-proposal: ${action.label} -> ${action.url}`)
        }
      } else {
        console.log(
          'seed-proposal: no action URLs to print (auto-approved, or notify was never called).',
        )
      }

      console.log(
        "seed-proposal: next — run 'pnpm --filter @doge-buddy/ops dev' and click Approve; " +
          'watch the apply job take it live.',
      )
    } finally {
      await boss.stop()
    }
  }
} catch (err) {
  failed = true
  console.error('seed-proposal: FAILED —', formatError(err))
} finally {
  await pool.end()
}

process.exit(failed ? 1 : 0)
