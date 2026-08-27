import { proposals, type createDb } from '@doge-buddy/db'
import type { GmailClient } from '@doge-buddy/gmail'
import type { SupplierAdapter } from '@doge-buddy/supplier'
import type { SendOpts } from '../fulfillment/types.ts'
import type { NotifyOwner } from '../notify/notify.ts'

/**
 * Shared vocabulary for the apply-executor family (`run-apply.ts`'s dispatch + every
 * `apply-*.ts` executor it dispatches to).
 *
 * Why this file exists (Task 15 review ruling): these declarations used to live in `run-apply.ts`,
 * which *imports* every executor to build its dispatch map — so each executor importing
 * `ApplyProposalDeps`/`ProposalRow` back out of `run-apply.ts` formed a two-way ESM cycle
 * (`run-apply -> apply-new-listing -> run-apply`). One executor made that cycle merely
 * distasteful; with a second and third (`support_reply`, `refund`) it would have been the file's
 * standing shape. A leaf module that imports no executor and no dispatcher breaks it permanently:
 * everything here is types plus one pure function, so nothing in this file can ever need to import
 * an executor back.
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
