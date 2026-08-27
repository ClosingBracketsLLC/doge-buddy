import { auditLog, proposals, supportTickets, type createDb } from '@doge-buddy/db'
import type { GmailClient } from '@doge-buddy/gmail'
import type { SupplierAdapter } from '@doge-buddy/supplier'
import { and, eq } from 'drizzle-orm'
import type { SendOpts } from '../fulfillment/types.ts'
import type { NotifyOwner } from '../notify/notify.ts'
import { applyNewListing } from './apply-new-listing.ts'
import { applyProposalTransition, StaleProposalStatusError } from './transitions.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

/**
 * Shopify operations `executeApplyProposal`'s `new_listing` pipeline needs — a strict, hand-picked
 * subset of `@doge-buddy/shopify-admin`'s full operation surface, same spirit as
 * `ShopifyFulfillmentOps` (`fulfillment/run-sync-tracking.ts`). Curried over the client (no
 * `client` param here) so the executor — and its tests — never depend on `ShopifyAdminClient`
 * directly.
 */
export interface ProposalShopifyOps {
  findProductByHandle(handle: string): Promise<{ id: string } | null>
  productSet(input: Record<string, unknown>): Promise<{ productId: string; variants: { id: string; sku?: string }[] }>
  listPublications(): Promise<{ id: string; name: string }[]>
  publishablePublish(productId: string, publicationId: string): Promise<void>
  /**
   * Looks up a product's current variants (id + sku) directly from Shopify. Needed on every
   * *resume* path — local row already exists, or `findProductByHandle` found it — where the
   * pipeline never called `productSet` this run and so never got a fresh `variants` array back:
   * without this, `variantGids` stays empty and every `product_variants` row lands with a
   * permanently-null `shopifyVariantGid` (permanent because the insert below is a conflict-tolerant
   * upsert matched by sku, not a hard failure) — which breaks fulfillment's `loadMappings`, which
   * filters on that column being non-null. See `executeApplyProposal`'s resume branch.
   */
  productVariantsByProductId(productGid: string): Promise<{ id: string; sku?: string }[]>
}

/**
 * Local shape for Task 16's `orderRefundState` return — declared here rather than imported from
 * `@doge-buddy/shopify-admin` because that op doesn't exist yet (this pipeline is its first
 * consumer). Task 16 moves/aligns this with whatever shape the real shopify-admin op ends up
 * returning once it's built.
 */
export interface OrderRefundState {
  totalRefundedCents: number
  refunds: { id: string; note: string | null }[]
  parentTransactionId: string | null
  gateway: string | null
}

/**
 * Refund/dispute operations `applyRefund`'s pipeline needs (Task 16) — a strict, hand-picked
 * subset, same spirit as `ProposalShopifyOps` above. Declared here (not imported) for the same
 * reason `OrderRefundState` above is: the backing op doesn't exist yet.
 */
export interface RefundOps {
  orderRefundState(orderGid: string): Promise<OrderRefundState>
  refundCreate(input: Record<string, unknown>, idempotencyKey: string): Promise<{ refundId: string }>
}

export interface ApplyProposalDeps {
  db: Db
  alert: Alert
  shopify: ProposalShopifyOps
  /**
   * The supplier-adapter surface the executors need: `subscribeProductWebhook` for `new_listing`'s
   * post-apply CJ webhook subscribe, `getDisputeOptions`/`openDispute` for `refund`'s apply
   * (Task 16). A strict, hand-picked subset of `SupplierAdapter`'s full surface, same spirit as
   * `ProposalShopifyOps` above.
   */
  adapter: Pick<SupplierAdapter, 'subscribeProductWebhook' | 'getDisputeOptions' | 'openDispute'>
  /**
   * Gmail client backing `support_reply`'s apply (Task 15). `null` when Gmail isn't configured —
   * `applySupportReply` must fail loudly (alert) in that case, never throw a bare `TypeError` on a
   * missing client.
   */
  gmail: GmailClient | null
  /**
   * Refund/dispute ops backing `refund`'s apply (Task 16, `RefundOps` above). `null` when
   * unconfigured — `applyRefund` must fail loudly (alert), same contract as `gmail` above.
   */
  refundOps: RefundOps | null
  /** Config `SUPPORT_ADDRESS` — Task 15 stamps this as the outbound reply row's `fromEmail` ('' when unset). */
  supportAddress: string
  notify: NotifyOwner
  enqueue: (name: string, data: object, opts?: SendOpts) => Promise<void>
  adminBaseUrl: string
}

/** The executors' row parameter type — the full `proposals` row `executeApplyProposal` already selects. */
export type ProposalRow = typeof proposals.$inferSelect

/**
 * Deterministic Shopify handle for a proposal's product — stable across crashes/retries so
 * `findProductByHandle` can always re-find a product this pipeline created on a prior attempt.
 */
export function proposalHandle(proposalId: string): string {
  return `db-proposal-${proposalId}`
}

/**
 * Type-keyed apply-executor dispatch (Task 14). `support_reply`/`refund` are added by Tasks 15/16
 * — until then, dispatching either type falls through to `executeApplyProposal`'s own
 * `unimplemented proposal type` throw below, same as `new_listing` did before this pipeline existed.
 */
const executors: Record<string, (deps: ApplyProposalDeps, row: ProposalRow) => Promise<void>> = {
  new_listing: applyNewListing,
}

/**
 * `proposal.apply` executor: the sole entry point that turns an `approved` proposal into real
 * Shopify + local-DB state. Every status write goes through `applyProposalTransition` — nothing
 * here ever assigns `.status` directly (see `transitions.ts`'s own doc comment for why).
 *
 * Resumable by design: a crash between any two steps below is recovered by simply re-running this
 * function against the same `proposalId` — exactly what happens, since pg-boss retries the job on
 * a thrown error and `proposal.apply` is enqueued with `singletonKey: proposalId` (see
 * `submit.ts`'s `enqueueProposalApply`). Every DB write below is `onConflictDoNothing`, and Shopify
 * product resolution checks the local row first, then a handle-based Shopify lookup, before ever
 * creating a new product — so a resumed run never double-creates.
 */
export async function executeApplyProposal(deps: ApplyProposalDeps, proposalId: string): Promise<void> {
  const { db } = deps
  const [row] = await db.select().from(proposals).where(eq(proposals.id, proposalId))
  if (!row) {
    // Missing row is a hard failure — the job retries rather than silently no-op'ing (same stance
    // `executePayOrder`/`executePlaceOrder` take for a missing row).
    throw new Error(`proposals row not found: ${proposalId}`)
  }

  if (row.status === 'approved') {
    try {
      await applyProposalTransition(db, proposalId, 'approved', 'applying')
    } catch (err) {
      if (!(err instanceof StaleProposalStatusError)) throw err
      // Another writer already moved this row off `approved` between our SELECT and the guarded
      // UPDATE — re-read to see where it landed. If it's `applying`, that writer did exactly what
      // we were about to do (or a duplicate job delivery raced us here first); safe to resume from
      // here. Anything else (already `applied`/`failed`/etc.) means someone else already finished
      // this row's next move — audit and get out, no throw (stale/duplicate delivery, not an error).
      const [after] = await db.select().from(proposals).where(eq(proposals.id, proposalId))
      if (after?.status !== 'applying') {
        await db.insert(auditLog).values({
          actor: 'system',
          action: 'proposal.apply_skipped',
          entityType: 'proposal',
          entityId: proposalId,
          detail: { status: after?.status ?? 'unknown' },
        })
        return
      }
    }
  } else if (row.status !== 'applying') {
    // Anything else (pending/rejected/expired/applied/failed) is not ours to apply right now —
    // audit that we saw it and get out, no throw (stale/duplicate job delivery, not an error).
    await db.insert(auditLog).values({
      actor: 'system',
      action: 'proposal.apply_skipped',
      entityType: 'proposal',
      entityId: proposalId,
      detail: { status: row.status },
    })
    return
  }

  // Type-keyed dispatch (Task 14): `support_reply`/`refund` fall through to the same
  // `unimplemented proposal type` throw `new_listing` itself used to hit before this pipeline
  // existed, until Tasks 15/16 add their executors to the `executors` map above.
  const exec = executors[row.type]
  if (!exec) {
    throw new Error(`unimplemented proposal type: ${row.type}`)
  }
  await exec(deps, row)
}

/**
 * Called by the job wrapper (`jobs/proposal-apply.ts`) only when `executeApplyProposal` threw AND
 * pg-boss's own retry-exhaustion check says this was the last attempt — same contract as
 * `deadLetterPayOrder` (`fulfillment/run-pay-order.ts`). Re-reads the row fresh since time has
 * passed since the throw; only `approved`/`applying` are ours to dead-letter (anything else means
 * someone else already moved this row's status, or it never got that far) — and the matrix allows
 * a direct transition to `failed` from either one, so this is always a single guarded UPDATE.
 */
export async function deadLetterApplyProposal(deps: ApplyProposalDeps, proposalId: string, err: unknown): Promise<void> {
  const { db } = deps
  const [row] = await db.select().from(proposals).where(eq(proposals.id, proposalId))
  if (!row) return
  if (row.status !== 'approved' && row.status !== 'applying') return

  const message = err instanceof Error ? err.message : String(err)
  await applyProposalTransition(db, proposalId, row.status, 'failed', { applyError: String(message).slice(0, 500) })
  await deps.alert('critical', 'proposal_apply_failed', { proposalId, error: message })

  // Support dead-letter growth (Tasks 15/16, spec §4 preamble): an approved `support_reply`/
  // `refund` proposal that fails to apply must surface back to its ticket AND page the owner — a
  // `new_listing` failure has no ticket to surface to, so this branch is scoped to the two
  // ticket-originated types only.
  if (row.type === 'support_reply' || row.type === 'refund') {
    if (row.ticketId) {
      // Guarded `awaiting_approval -> escalated` — same CRITICAL-1 contract as ingest.ts's and
      // triage.ts's own escalating writes: every UPDATE that transitions a ticket INTO 'escalated'
      // must clear escalation_notified_at, or a ticket that was already escalated+notified once,
      // then resolved, then re-escalated here stays permanently invisible to
      // `notifyPendingEscalations`'s `escalation_notified_at IS NULL` selection. Guarded on
      // `awaiting_approval` specifically — a ticket some other writer already moved off that status
      // (e.g. the owner manually escalated it, or it somehow resolved) is not this dead-letter's to
      // touch; 0 rows affected is a perfectly normal, non-error outcome.
      await db
        .update(supportTickets)
        .set({ status: 'escalated', escalationReason: 'apply_failed', escalationNotifiedAt: null })
        .where(and(eq(supportTickets.id, row.ticketId), eq(supportTickets.status, 'awaiting_approval')))
    }
    // Best-effort: `NotifyOwner` never rejects by its own contract (see notify.ts), but guard here
    // anyway so a notify failure can never break dead-lettering itself — alert instead, and never
    // let it escape this function.
    await deps
      .notify({
        title: `Approved ${row.type} FAILED to apply`,
        body: row.summary,
        actions: [{ label: 'View', url: `${deps.adminBaseUrl}/admin/proposals/${row.id}` }],
      })
      .catch((notifyErr) =>
        deps.alert('warning', 'dead_letter_notify_failed', {
          proposalId,
          error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
        }).catch(() => {}),
      )
  }
}
