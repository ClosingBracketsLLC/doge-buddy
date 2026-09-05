import { deprecationQueue, products, type createDb } from '@doge-buddy/db'
import { asc, eq, isNull } from 'drizzle-orm'
import type { SubmitProposalDeps } from '../proposals/submit.ts'
import { submitProposal } from '../proposals/submit.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

export interface DeprecationDripDeps {
  db: Db
  alert: Alert
  submitDeps: SubmitProposalDeps
  /** Injection seam; production passes the real submitProposal. */
  submit?: typeof submitProposal
  now?: () => Date
}

/** How fast the queue drains: at least DRIP_MIN_PER_NIGHT, scaled up so a long queue never tails
 *  past ~DRIP_MAX_NIGHTS nights (owner ask 2026-09-03: "at least 1 product each night"). */
export const DRIP_MIN_PER_NIGHT = 1
export const DRIP_MAX_NIGHTS = 7

export function dripBatchSize(queueLength: number): number {
  return Math.max(DRIP_MIN_PER_NIGHT, Math.ceil(queueLength / DRIP_MAX_NIGHTS))
}

/**
 * Nightly worker for `catalog.deprecation-drip` (owner ask 2026-09-03): pops the oldest
 * unprocessed queue entries and submits ONE deprecate_product proposal each, through the normal
 * `workflow.deprecation.mode` path — manual mode means a Telegram Approve per product, auto means
 * it applies immediately. Entries whose product is already deprecated (or gone) are marked
 * processed without a proposal. A submit failure alerts and leaves the entry UNPROCESSED so the
 * next night retries it; one bad entry never blocks the rest of the batch.
 */
export const deprecationDripHandler = (deps: DeprecationDripDeps) => async (): Promise<void> => {
  const { db, alert } = deps
  const submit = deps.submit ?? submitProposal
  const now = deps.now ?? (() => new Date())

  try {
    const pending = await db
      .select({
        queueId: deprecationQueue.id,
        productId: deprecationQueue.productId,
        reason: deprecationQueue.reason,
        title: products.title,
        status: products.status,
        productCreatedAt: products.createdAt,
      })
      .from(deprecationQueue)
      .innerJoin(products, eq(products.id, deprecationQueue.productId))
      .where(isNull(deprecationQueue.processedAt))
      .orderBy(asc(deprecationQueue.enqueuedAt))

    if (pending.length === 0) return

    const batch = pending.slice(0, dripBatchSize(pending.length))
    for (const entry of batch) {
      if (entry.status === 'deprecated') {
        await db.update(deprecationQueue).set({ processedAt: now() }).where(eq(deprecationQueue.id, entry.queueId))
        continue
      }
      try {
        const daysLive = Math.max(0, Math.floor((now().getTime() - entry.productCreatedAt.getTime()) / 86_400_000))
        const result = await submit(deps.submitDeps, {
          type: 'deprecate_product',
          summary: `Deprecate: ${entry.title ?? entry.productId} — ${entry.reason}`,
          payload: {
            type: 'deprecate_product',
            productId: entry.productId,
            evidence: { unitsSold28d: 0, refundCount28d: 0, ticketCount28d: 0, daysLive, reasoning: entry.reason },
          },
          sourceWorkflow: 'catalog.deprecation-drip',
          productId: entry.productId,
        })
        await db
          .update(deprecationQueue)
          .set({ processedAt: now(), proposalId: result.id })
          .where(eq(deprecationQueue.id, entry.queueId))
      } catch (err) {
        // Leave UNPROCESSED — next night retries. Alert so a persistently failing entry is seen.
        await alert('warning', 'deprecation_drip_failed', {
          productId: entry.productId,
          error: err instanceof Error ? err.message : String(err),
        }).catch(() => {})
      }
    }
    await alert('info', 'deprecation_drip_ran', {
      processed: batch.length,
      remaining: pending.length - batch.length,
    }).catch(() => {})
  } catch (err) {
    await alert('critical', 'deprecation_drip_failed', { error: err instanceof Error ? err.message : String(err) }).catch(() => {})
  }
}
