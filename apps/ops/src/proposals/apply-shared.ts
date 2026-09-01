import { auditLog, proposals, supportTickets, type createDb } from '@doge-buddy/db'
import type { GmailClient } from '@doge-buddy/gmail'
import type { OrderRefundState } from '@doge-buddy/shopify-admin'
import type { SupplierAdapter } from '@doge-buddy/supplier'
import { and, eq } from 'drizzle-orm'
import type { SendOpts } from '../fulfillment/types.ts'
import { enqueueSupportAgentRun } from '../jobs/support-agent-run.ts'
import type { NotifyOwner } from '../notify/notify.ts'
import { applyProposalTransition } from './transitions.ts'

/**
 * Shared vocabulary for the apply-executor family (`run-apply.ts`'s dispatch + every
 * `apply-*.ts` executor it dispatches to).
 *
 * Why this file exists (Task 15 review ruling): these declarations used to live in `run-apply.ts`,
 * which *imports* every executor to build its dispatch map — so each executor importing
 * `ApplyProposalDeps`/`ProposalRow` back out of `run-apply.ts` formed a two-way ESM cycle
 * (`run-apply -> apply-new-listing -> run-apply`). One executor made that cycle merely
 * distasteful; with a second and third (`support_reply`, `refund`) it would have been the file's
 * standing shape. A leaf module that imports no executor and no dispatcher breaks it permanently —
 * and that, not "types only", is the invariant to keep: Task 16 added the two support executors'
 * shared *behaviour* here too (the stale hand-back and the owner notification), which is fine
 * because nothing it reaches for (db schema, `transitions.ts`, `jobs/support-agent-run.ts`) imports
 * an executor or the dispatcher back.
 *
 * `run-apply.ts` re-exports all of it for backward compatibility — existing importers (tests
 * included) keep working unchanged.
 */

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
  productSet(
    input: Record<string, unknown>,
  ): Promise<{ productId: string; variants: { id: string; sku?: string; inventoryItemId: string }[] }>
  listPublications(): Promise<{ id: string; name: string }[]>
  publishablePublish(productId: string, publicationId: string): Promise<void>
  /**
   * Removes a product from a single publication (`deprecate_product`'s apply, Task 10). The
   * mirror of `publishablePublish` above and shaped identically — one call per publication in
   * `listPublications()`'s result. Unlike the publish loop, NO publication is required to succeed:
   * the product has already been flipped to `DRAFT` by the time this runs (which alone hides it
   * from every sales channel), so a failed unpublish is alert-and-continue, never a throw — see
   * `applyDeprecateProduct`.
   */
  publishableUnpublish(productGid: string, publicationId: string): Promise<void>
  /**
   * Looks up a product's current variants (id + sku) directly from Shopify. Needed on every
   * *resume* path — local row already exists, or `findProductByHandle` found it — where the
   * pipeline never called `productSet` this run and so never got a fresh `variants` array back:
   * without this, `variantGids` stays empty and every `product_variants` row lands with a
   * permanently-null `shopifyVariantGid` (permanent because the insert below is a conflict-tolerant
   * upsert matched by sku, not a hard failure) — which breaks fulfillment's `loadMappings`, which
   * filters on that column being non-null. See `executeApplyProposal`'s resume branch.
   */
  productVariantsByProductId(productGid: string): Promise<{ id: string; sku?: string; inventoryItemId: string }[]>
}

/**
 * Task 15 declared a local placeholder for this shape because the backing op did not exist yet;
 * Task 16 built it, so there is now exactly ONE definition — `@doge-buddy/shopify-admin`'s, next to
 * the query that produces it — and this re-export keeps every existing importer
 * (`run-apply.ts`, the tests) pointing at the same type.
 */
export type { OrderRefundState }

/**
 * Refund/dispute operations `applyRefund`'s pipeline needs (Task 16) — a strict, hand-picked
 * subset of `@doge-buddy/shopify-admin`'s operation surface, curried over the client, same spirit
 * as `ProposalShopifyOps` above.
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
   * (Task 16), `unsubscribeProductWebhook` for `deprecate_product`'s safe post-apply CJ unsubscribe
   * (Task 10). A strict, hand-picked subset of `SupplierAdapter`'s full surface, same spirit as
   * `ProposalShopifyOps` above.
   */
  adapter: Pick<SupplierAdapter, 'subscribeProductWebhook' | 'unsubscribeProductWebhook' | 'getDisputeOptions' | 'openDispute'>
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
 *
 * The `refund` executor reuses the exact same string as its Shopify refund `note` (Task 16): the
 * note is that executor's crash-recovery marker, for the same reason and with the same shape —
 * derived from the proposal id alone, so a re-entered apply can always recognise its own prior
 * work. See `apply-refund.ts`'s pre-check.
 */
export function proposalHandle(proposalId: string): string {
  return `db-proposal-${proposalId}`
}

// ---------------------------------------------------------------------------
// The support executors' shared refusal vocabulary (`support_reply` + `refund`)
// ---------------------------------------------------------------------------

/** Audit action for every terminal apply refusal (pre-check or staleness), all executors. */
export const PROPOSAL_APPLY_FAILED_ACTION = 'proposal.apply_failed'
/** Audit action for a completed apply — the same string `applyNewListing` writes. */
export const PROPOSAL_APPLIED_ACTION = 'proposal.applied'
/** `applyError` written when the customer wrote again after the agent took its snapshot. */
export const STALE_APPLY_ERROR = 'stale: newer customer message'

/**
 * Defensive backstop (FR6) under Telegram's ~4096-char message limit, mirroring `submit.ts`'s own
 * `capNotifyBody`. The primary fix bounds the ticket subject where `proposals.summary` is built, so
 * the bodies below are already short in practice — but a notify body that ever exceeds the limit
 * makes `notify()` return false, which downgrades the "your approved reply/refund did NOT send" page
 * to an `alert()` that never reaches the owner's phone (spec §4 calls that page non-optional). 3500
 * leaves headroom for the fixed-shape prefixes/suffixes these bodies wrap around `row.summary`.
 */
const NOTIFY_BODY_MAX_CHARS = 3500

export function capNotifyBody(body: string): string {
  return body.length > NOTIFY_BODY_MAX_CHARS ? body.slice(0, NOTIFY_BODY_MAX_CHARS) : body
}

/**
 * Tells the owner an action they approved from their phone did NOT happen.
 *
 * `NotifyOwner` never rejects by its own contract, but this guards anyway — a notify failure must
 * never turn a clean terminal refusal into a thrown, retried, dead-lettered one. House `alert()`
 * does not reach Telegram; `notify()` does, which is why every refusal path below uses it.
 */
export async function notifyOwnerBestEffort(
  deps: ApplyProposalDeps,
  row: ProposalRow,
  args: { title: string; body: string; alertKind: string },
): Promise<void> {
  await deps
    .notify({
      title: args.title,
      body: capNotifyBody(args.body),
      actions: [{ label: 'View', url: `${deps.adminBaseUrl}/admin/proposals/${row.id}` }],
    })
    .catch((err) =>
      deps
        .alert('warning', args.alertKind, {
          proposalId: row.id,
          error: err instanceof Error ? err.message : String(err),
        })
        .catch(() => {}),
    )
}

/**
 * The staleness consequence, shared byte-for-byte by both support executors (spec §4, reply step 2
 * / refund step 1): the approval was a snapshot of a conversation the customer has since added to,
 * so the approved action must NOT happen — and the ticket goes back to the agent to re-read the
 * thread and draft again. A customer's "package arrived, cancel my refund request" has to gate
 * money exactly as it gates words, which is why this is one helper and not two near-copies.
 *
 * ONE transaction: proposal `applying -> failed`, ticket `awaiting_approval -> triaged` with the
 * claim stamp cleared, audit row. Then, outside it, the owner notification and a best-effort
 * re-run enqueue.
 *
 * `lastAgentRunAt: null` is load-bearing, not hygiene: the stale message's Gmail internalDate can
 * predate the wall-clock claim stamp of the run that produced this draft, in which case the
 * re-run's claim CAS (`last_inbound_at > last_agent_run_at`) sees no new inbound and no-ops until
 * the 20-minute stuck branch finally fires. Clearing the stamp puts the ticket back in "never run"
 * territory so the re-run claims immediately. The ticket UPDATE is guarded on `awaiting_approval`;
 * 0 rows is a normal outcome (another writer moved it).
 */
export async function failStaleAndHandBack(
  deps: ApplyProposalDeps,
  row: ProposalRow,
  args: {
    ticketId: string
    /** The payload's `threadSnapshotAt`, verbatim, for the audit detail. */
    threadSnapshotAt: string
    newerInboundAt: Date | null
    notifyTitle: string
    notifyBody: string
    /** Alert kind for a failed best-effort re-run enqueue, e.g. `refund_stale_enqueue_failed`. */
    enqueueAlertKind: string
    /** Alert kind for a failed owner notification. */
    notifyAlertKind: string
  },
): Promise<void> {
  const proposalId = row.id
  await deps.db.transaction(async (tx) => {
    await applyProposalTransition(tx, proposalId, 'applying', 'failed', { applyError: STALE_APPLY_ERROR })
    // Deliberately does NOT clear the redraft columns (no `...clearRedraftCycle()`). This is a
    // pre-send stale guard: no reply shipped, so the owner's correction is still UNFULFILLED and must
    // carry forward into the fresh re-draft the re-run produces. Clearing here would both drop a live
    // correction AND reset redraft_count, defeating SUPPORT_REDRAFT_MAX. (Contrast completeSend's
    // hand-back, which DOES clear precisely because the reply already shipped.)
    await tx
      .update(supportTickets)
      .set({ status: 'triaged', lastAgentRunAt: null })
      .where(and(eq(supportTickets.id, args.ticketId), eq(supportTickets.status, 'awaiting_approval')))
    await tx.insert(auditLog).values({
      actor: 'system',
      action: PROPOSAL_APPLY_FAILED_ACTION,
      entityType: 'proposal',
      entityId: proposalId,
      detail: {
        reason: STALE_APPLY_ERROR,
        ticketId: args.ticketId,
        threadSnapshotAt: args.threadSnapshotAt,
        newerInboundAt: args.newerInboundAt?.toISOString() ?? null,
      },
    })
  })

  await notifyOwnerBestEffort(deps, row, {
    title: args.notifyTitle,
    body: args.notifyBody,
    alertKind: args.notifyAlertKind,
  })

  // Best-effort: the ticket is already `triaged`, so the poll's own selection stage is the backstop
  // that re-runs the agent even if this enqueue never lands.
  await enqueueSupportAgentRun(deps.enqueue, args.ticketId).catch((err) =>
    deps
      .alert('warning', args.enqueueAlertKind, {
        proposalId,
        ticketId: args.ticketId,
        error: err instanceof Error ? err.message : String(err),
      })
      .catch(() => {}),
  )
}
