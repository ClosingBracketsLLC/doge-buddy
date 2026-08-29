import { auditLog, proposals, supportTickets } from '@doge-buddy/db'
import { and, eq } from 'drizzle-orm'
import { applyDeprecateProduct } from './apply-deprecate-product.ts'
import { applyNewListing } from './apply-new-listing.ts'
import { applyRefund } from './apply-refund.ts'
import { capNotifyBody, type ApplyProposalDeps, type ProposalRow } from './apply-shared.ts'
import { applySupportReply } from './apply-support-reply.ts'
import { applyProposalTransition, StaleProposalStatusError } from './transitions.ts'

/**
 * Backward-compatible re-exports: these declarations now live in `apply-shared.ts` (a leaf module
 * that imports no executor), because this file imports every executor to build its dispatch map
 * below and each executor needs `ApplyProposalDeps`/`ProposalRow` — importing them back out of
 * here formed a two-way ESM cycle. See `apply-shared.ts`'s own doc comment. Existing importers
 * (tests included) keep working unchanged.
 */
export { proposalHandle } from './apply-shared.ts'
export type { ApplyProposalDeps, OrderRefundState, ProposalRow, ProposalShopifyOps, RefundOps } from './apply-shared.ts'

/**
 * Type-keyed apply-executor dispatch (Task 14). Every `proposal_type` enum value now has an
 * executor (Task 10 added `deprecate_product`), so the `unimplemented proposal type` throw below is
 * now a purely defensive backstop — unreachable through a valid DB row, but kept for a future enum
 * value that lands before its executor does (or a programming error that drops one from this map).
 */
const executors: Record<string, (deps: ApplyProposalDeps, row: ProposalRow) => Promise<void>> = {
  new_listing: applyNewListing,
  support_reply: applySupportReply,
  refund: applyRefund,
  deprecate_product: applyDeprecateProduct,
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

  // Type-keyed dispatch (Task 14): every `proposal_type` enum value has an entry in the `executors`
  // map above (Task 10 filled the last one, `deprecate_product`), so this throw is now a defensive
  // backstop only — it fires for a type that reaches here with no registered executor (a future
  // enum value added ahead of its executor, or a map regression), never for today's valid data.
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
        // FR6: defensively bounded — `row.summary` is already capped at the source, but a dropped
        // dead-letter page (notify false → alert-only) is exactly the failure §4 forbids here.
        body: capNotifyBody(row.summary),
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
