import { proposals, auditLog, type createDb } from '@doge-buddy/db'
import {
  NewListingPayloadSchema, SupportReplyPayloadSchema, RefundPayloadSchema,
  DeprecateProductPayloadSchema, type ProposalType,
} from '@doge-buddy/core'
import type { SendOpts } from '../fulfillment/types.ts'
import type { NotifyOwner } from '../notify/notify.ts'
import type { Settings, SettingKey } from '../settings.ts'
import { generateActionToken } from './tokens.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

export const PAYLOAD_SCHEMAS = {
  new_listing: NewListingPayloadSchema,
  support_reply: SupportReplyPayloadSchema,
  refund: RefundPayloadSchema,
  deprecate_product: DeprecateProductPayloadSchema,
} as const

const MODE_KEYS: Record<ProposalType, SettingKey & `workflow.${string}.mode`> = {
  new_listing: 'workflow.sourcing.mode',
  support_reply: 'workflow.support_reply.mode',
  refund: 'workflow.refund.mode',
  deprecate_product: 'workflow.deprecation.mode',
}

/**
 * `expireInSeconds: 600` (Task 15 review, M5): without an explicit expiry, a `proposal.apply` job
 * whose worker is hard-killed mid-run sits on pg-boss's default expiry before it can be retried,
 * widening the window in which a second handler could pick the same proposal up while the first
 * one's effects are still in flight. Ten minutes sits well above any real apply's runtime (the
 * `support_reply` executor's slowest path is a handful of Gmail calls) while bounding that window
 * — the same reasoning `support.agent-run`'s own 600s expiry documents.
 */
export const PROPOSAL_RETRY_OPTS = { retryLimit: 5, retryBackoff: true, retryDelay: 30, expireInSeconds: 600 }

export function enqueueProposalApply(
  enqueue: (name: string, data: object, opts?: SendOpts) => Promise<void>,
  proposalId: string,
): Promise<void> {
  return enqueue('proposal.apply', { proposalId }, { ...PROPOSAL_RETRY_OPTS, singletonKey: proposalId })
}

export interface SubmitProposalDeps {
  db: Db
  settings: Settings
  notify: NotifyOwner
  enqueue: (name: string, data: object, opts?: SendOpts) => Promise<void>
  alert: Alert
  adminBaseUrl?: string
}

export interface SubmitProposalInput {
  type: 'new_listing' | 'support_reply' | 'refund' | 'deprecate_product'
  summary: string
  payload: unknown
  sourceWorkflow: string
  agentRunId?: string
  ticketId?: string
  productId?: string
  orderId?: string
}

/**
 * Single entry point every workflow's output routes through. Validates the payload against
 * its per-type zod schema, decides manual vs. auto per `workflow.<x>.mode` (with a refund
 * amount cap override that forces manual even when the setting says auto), persists the
 * proposals row, writes the audit trail, and — manual only — notifies the owner with a
 * one-click approve/reject pair sharing a single action token.
 */
export async function submitProposal(
  deps: SubmitProposalDeps,
  input: SubmitProposalInput,
): Promise<{ id: string; status: 'pending' | 'approved' }> {
  const schema = PAYLOAD_SCHEMAS[input.type]
  const parsed = schema.parse(input.payload) as { amountCents?: number }

  const modeKey = MODE_KEYS[input.type]
  let mode = await deps.settings.get(modeKey)

  if (mode === 'auto' && input.type === 'refund') {
    const cap = await deps.settings.get('refund.auto_max_cents')
    if ((parsed.amountCents ?? 0) > cap) {
      mode = 'manual'
    }
  }

  if (mode === 'manual') {
    const { token, hash } = generateActionToken()

    const [row] = await deps.db
      .insert(proposals)
      .values({
        type: input.type,
        status: 'pending',
        summary: input.summary,
        payload: parsed,
        sourceWorkflow: input.sourceWorkflow,
        agentRunId: input.agentRunId,
        ticketId: input.ticketId,
        productId: input.productId,
        orderId: input.orderId,
        autoApproved: false,
        actionTokenHash: hash,
      })
      .returning()
    const id = row!.id

    await deps.db.insert(auditLog).values({
      actor: 'system',
      action: 'proposal.created',
      entityType: 'proposal',
      entityId: id,
      detail: { type: input.type, sourceWorkflow: input.sourceWorkflow, mode: 'manual' },
    })

    if (deps.adminBaseUrl) {
      const approveUrl = `${deps.adminBaseUrl}/a/${id}/approve?t=${token}`
      const rejectUrl = `${deps.adminBaseUrl}/a/${id}/reject?t=${token}`
      const body = [
        input.summary,
        '',
        '[ ] IP check done',
        'Ritual: check TikTok Creative Center (Pet Supplies, US, 7d) — paste anything interesting into the dashboard',
        `${deps.adminBaseUrl}/admin/proposals/${id}`,
      ].join('\n')

      await deps.notify({
        title: `New ${input.type} proposal`,
        body,
        actions: [
          { label: 'Approve', url: approveUrl },
          { label: 'Reject', url: rejectUrl },
        ],
      })
    } else {
      await deps.alert('warning', 'notify_unconfigured', { proposalId: id })
    }

    return { id, status: 'pending' }
  }

  // auto
  const decidedAt = new Date()
  const [row] = await deps.db
    .insert(proposals)
    .values({
      type: input.type,
      status: 'approved',
      summary: input.summary,
      payload: parsed,
      sourceWorkflow: input.sourceWorkflow,
      agentRunId: input.agentRunId,
      ticketId: input.ticketId,
      productId: input.productId,
      orderId: input.orderId,
      autoApproved: true,
      decidedBy: 'system:auto',
      decidedAt,
      actionTokenHash: null,
    })
    .returning()
  const id = row!.id

  await deps.db.insert(auditLog).values({
    actor: 'system',
    action: 'proposal.created',
    entityType: 'proposal',
    entityId: id,
    detail: { type: input.type, sourceWorkflow: input.sourceWorkflow, mode: 'auto' },
  })
  await deps.db.insert(auditLog).values({
    actor: 'system',
    action: 'proposal.approve',
    entityType: 'proposal',
    entityId: id,
    detail: { via: 'auto' },
  })

  try {
    await enqueueProposalApply(deps.enqueue, id)
  } catch {
    // The transition above already committed — never un-approve on an enqueue failure, just
    // alert and let `/admin` resend-apply recover it. Same precedent as the action-route's
    // `enqueueFailedPage` path (`http/actions.ts`) — best-effort alert, its own failure must
    // never break this response.
    await deps.alert('critical', 'apply_enqueue_failed', { proposalId: id }).catch(() => {})
  }

  return { id, status: 'approved' }
}
