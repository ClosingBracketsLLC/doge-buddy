import { timingSafeEqual } from 'node:crypto'
import { auditLog, proposals, type createDb } from '@doge-buddy/db'
import { eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import type { SendOpts } from '../fulfillment/types.ts'
import { enqueueProposalApply } from '../proposals/submit.ts'
import { hashActionToken } from '../proposals/tokens.ts'
import { applyProposalTransition, StaleProposalStatusError } from '../proposals/transitions.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>
type ProposalRow = typeof proposals.$inferSelect
type Decision = 'approve' | 'reject'

export interface ActionRouteDeps {
  db: Db
  enqueue: (name: string, data: object, opts?: SendOpts) => Promise<void>
  alert: Alert
}

// Constant copy on purpose: this page must render identically for an unknown id, a wrong/garbage
// token, an already-decided row, and an expired row — no field of it may leak which case applied,
// so it can never act as a state oracle for someone probing links.
const FRIENDLY_COPY = 'This link was already handled or has expired.'

/** Escapes the five HTML-significant characters. Used on every piece of user-supplied text
 * (the proposal summary) before it's interpolated into a hand-rolled template literal. */
function esc(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`
}

function friendlyPage(): string {
  return page(`<p>${FRIENDLY_COPY}</p>`)
}

function confirmPage(proposalId: string, decision: Decision, summary: string, token: string): string {
  const label = decision === 'approve' ? 'Approve' : 'Reject'
  const action = `/a/${proposalId}/${decision}?t=${encodeURIComponent(token)}`
  return page(`
    <p>${esc(summary)}</p>
    <form method="post" action="${action}">
      <button type="submit">${label}</button>
    </form>
  `)
}

function resultPage(decision: Decision): string {
  return decision === 'approve'
    ? page('<p>Approved ✓ — the listing will go live shortly.</p>')
    : page('<p>Rejected ✓</p>')
}

/**
 * Timing-safe check that `token` (raw, from the query string) matches `row`'s stored hash, on a
 * row that is still pending and not yet expired. Both sides of the comparison are 64-char hex
 * sha256 digests, but length is still guarded before `timingSafeEqual` (which throws on unequal
 * lengths) — the same pattern as `verifyShopifyWebhookHmac` / CJ's `verifyWebhook`.
 */
function isValidDecision(row: ProposalRow | undefined, token: string | undefined): row is ProposalRow {
  if (!row || !token) return false
  if (row.status !== 'pending') return false
  if (row.actionTokenHash === null) return false
  if (!(row.expiresAt.getTime() > Date.now())) return false

  const expected = Buffer.from(row.actionTokenHash, 'utf8')
  const provided = Buffer.from(hashActionToken(token), 'utf8')
  if (expected.length !== provided.length) return false
  return timingSafeEqual(expected, provided)
}

export function actionRoutes(deps: ActionRouteDeps): FastifyPluginAsync {
  return async (fastify) => {
    async function lookup(proposalId: string): Promise<ProposalRow | undefined> {
      const [row] = await deps.db.select().from(proposals).where(eq(proposals.id, proposalId))
      return row
    }

    async function handleGet(decision: Decision, proposalId: string, token: string | undefined): Promise<string> {
      const row = await lookup(proposalId)
      if (isValidDecision(row, token)) {
        return confirmPage(proposalId, decision, row.summary, token!)
      }
      return friendlyPage()
    }

    async function handlePost(decision: Decision, proposalId: string, token: string | undefined): Promise<string> {
      const row = await lookup(proposalId)

      // Lazy expiry: a pending row past its expiresAt flips to 'expired' the moment someone
      // actually acts on it (POST), regardless of whether the token they carried was valid —
      // GET never does this (see actions.test.ts case 8). A concurrent racer who beat us to the
      // same transition just means someone else already handled it.
      if (row && row.status === 'pending' && !(row.expiresAt.getTime() > Date.now())) {
        try {
          await applyProposalTransition(deps.db, proposalId, 'pending', 'expired')
          await deps.db.insert(auditLog).values({
            actor: 'system',
            action: 'proposal.expired',
            entityType: 'proposal',
            entityId: proposalId,
            detail: { via: 'lazy-expiry' },
          })
        } catch (err) {
          if (!(err instanceof StaleProposalStatusError)) throw err
        }
        return friendlyPage()
      }

      if (!isValidDecision(row, token)) {
        return friendlyPage()
      }

      const status = decision === 'approve' ? 'approved' : 'rejected'
      try {
        await applyProposalTransition(deps.db, proposalId, 'pending', status, {
          decidedBy: 'owner',
          decidedAt: new Date(),
          actionTokenHash: null,
        })
      } catch (err) {
        // Someone else's request (or another tab, or a race) already decided this row between
        // our lookup and our guarded UPDATE — the single-use mechanism worked, just not for us.
        if (err instanceof StaleProposalStatusError) return friendlyPage()
        throw err
      }

      await deps.db.insert(auditLog).values({
        actor: 'owner',
        action: decision === 'approve' ? 'proposal.approve' : 'proposal.reject',
        entityType: 'proposal',
        entityId: proposalId,
        detail: { via: 'link' },
      })

      if (decision === 'approve') {
        await enqueueProposalApply(deps.enqueue, proposalId)
      }

      return resultPage(decision)
    }

    for (const decision of ['approve', 'reject'] as const) {
      fastify.get(`/a/:proposalId/${decision}`, async (request, reply) => {
        const { proposalId } = request.params as { proposalId: string }
        const { t } = request.query as { t?: string }
        const body = await handleGet(decision, proposalId, t)
        return reply.code(200).type('text/html; charset=utf-8').send(body)
      })

      fastify.post(`/a/:proposalId/${decision}`, async (request, reply) => {
        const { proposalId } = request.params as { proposalId: string }
        const { t } = request.query as { t?: string }
        const body = await handlePost(decision, proposalId, t)
        return reply.code(200).type('text/html; charset=utf-8').send(body)
      })
    }
  }
}
