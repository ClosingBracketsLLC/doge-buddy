import { proposals, supportTickets, type createDb } from '@doge-buddy/db'
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import type { SendOpts } from '../fulfillment/types.ts'
import { enqueueSupportAgentRun, SUPPORT_AGENT_STUCK_AFTER_MINUTES } from '../jobs/support-agent-run.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>
type SendFn = (name: string, data: object, opts?: SendOpts) => Promise<void>

/** One selection cycle enqueues at most this many `support.agent-run` jobs (spec §1 predicate) —
 * ordered oldest-inbound-first, so a burst of new mail can't starve tickets that have been waiting
 * longest. Whatever doesn't fit stays selectable next cycle — this stage runs once per poll minute
 * (`support-poll-gmail.ts`'s 4th stage). */
export const AGENT_SELECT_CAP_PER_CYCLE = 10

/** The same failure ceiling `claimTicket` (`jobs/support-agent-run.ts`) escalates at. Duplicated
 * here rather than imported — it's kept private there — so this predicate never selects a ticket
 * the claim would immediately reject as `failure_ceiling`. Keep this literal `2` in sync with
 * `AGENT_FAILURE_ESCALATE_AT` there by hand; a drift only ever produces a harmless no-op enqueue
 * (the claim's own row-locked predicate is the actual gate), never a bad claim. */
const AGENT_FAILURE_ESCALATE_AT = 2

/** CRITICAL-1 orphan backstop (spec): an `awaiting_approval` ticket with no live support proposal
 * and no activity for this long is presumed stranded — e.g. a run that flipped the ticket to
 * `awaiting_approval` and then crashed before `submitProposal` ever committed (see
 * `submitProposeOutcome`'s own doc comment on that exact failure window). */
const ORPHAN_AFTER_MINUTES = 15

/** Proposal statuses that count as "still live" for the orphan check. Deliberately NOT `applied`:
 * an applied proposal means the reply/refund already went out, so a ticket sitting in
 * `awaiting_approval` with only applied proposals reflects a different situation than an orphan
 * (the ticket simply hasn't been marked resolved yet), not one this backstop should touch. */
const LIVE_PROPOSAL_STATUSES = ['pending', 'approved', 'applying'] as const

export interface AgentSelectDeps {
  db: Db
  enqueue: SendFn
  alert: Alert
  now?: () => Date
}

/**
 * The poll's 4th stage (spec §1 selection + CRITICAL-1 orphan backstop), run once per cycle, after
 * the escalate stage, only when ingest did not fail.
 *
 * **1. Selection.** Every `triaged` ticket matching the amended stuck gate — never run, has new
 * inbound since its last run, or was claimed `SUPPORT_AGENT_STUCK_AFTER_MINUTES`+ ago with no
 * finish stamp past that claim — ordered oldest-inbound-first, capped at
 * `AGENT_SELECT_CAP_PER_CYCLE`. This mirrors `claimTicket`'s own predicate in
 * `jobs/support-agent-run.ts` (kept visibly parallel there — same three watermark comparisons, same
 * failure ceiling); a drift between the two would only ever produce a harmless no-op enqueue, since
 * `claimTicket`'s row-locked re-evaluation is the actual gate.
 *
 * This is a SELECT, not a claim. A ticket picked here can still lose the real race — another
 * cycle's job already claimed it under `claimTicket`'s row lock — and the enqueued job simply
 * no-ops (`support.agent_run_skipped`); harmless by design. `enqueueSupportAgentRun` sets the
 * queue's per-ticket `singletonKey`, so a ticket already mid-run is deduped by pg-boss rather than
 * double-enqueued.
 *
 * **2. Orphan backstop** (CRITICAL-1): `awaiting_approval` tickets idle past `ORPHAN_AFTER_MINUTES`
 * with no live support proposal are guarded-escalated (`orphaned_awaiting_approval`,
 * `escalationNotifiedAt` cleared). Nothing here notifies — the escalate stage already ran earlier
 * in THIS poll cycle, so a ticket escalated here is picked up by `notifyPendingEscalations` on the
 * NEXT cycle, one minute later.
 */
export async function selectAndEnqueueAgentRuns(
  deps: AgentSelectDeps,
): Promise<{ enqueued: number; orphansEscalated: number }> {
  const now = deps.now ?? (() => new Date())
  const nowVal = now()
  const stuckBefore = new Date(nowVal.getTime() - SUPPORT_AGENT_STUCK_AFTER_MINUTES * 60_000)

  const candidates = await deps.db
    .select({ id: supportTickets.id })
    .from(supportTickets)
    .where(
      and(
        eq(supportTickets.status, 'triaged'),
        lt(supportTickets.agentFailureCount, AGENT_FAILURE_ESCALATE_AT),
        or(
          isNull(supportTickets.lastAgentRunAt),
          // Column-vs-column comparison — drizzle's `gt` helper only binds a plain value on the
          // right side, so this needs a raw fragment (same convention as `triage.ts`'s own
          // `last_inbound_at > last_triaged_at` selection predicate).
          sql`${supportTickets.lastInboundAt} > ${supportTickets.lastAgentRunAt}`,
          and(
            lt(supportTickets.lastAgentRunAt, stuckBefore),
            or(
              isNull(supportTickets.lastAgentFinishedAt),
              sql`${supportTickets.lastAgentFinishedAt} < ${supportTickets.lastAgentRunAt}`,
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(supportTickets.lastInboundAt))
    .limit(AGENT_SELECT_CAP_PER_CYCLE)

  let enqueued = 0
  for (const ticket of candidates) {
    try {
      await enqueueSupportAgentRun(deps.enqueue, ticket.id)
      enqueued += 1
    } catch (err) {
      // Best-effort: one ticket's enqueue failure (a DB blip on pg-boss's send) must not stop the
      // rest of the batch — the un-enqueued ticket is simply selectable again next cycle.
      await deps
        .alert('warning', 'support_agent_select_enqueue_failed', {
          ticketId: ticket.id,
          error: err instanceof Error ? err.message : String(err),
        })
        .catch(() => {})
    }
  }

  const orphanBefore = new Date(nowVal.getTime() - ORPHAN_AFTER_MINUTES * 60_000)
  const staleAwaiting = await deps.db
    .select({ id: supportTickets.id })
    .from(supportTickets)
    .where(and(eq(supportTickets.status, 'awaiting_approval'), lt(supportTickets.updatedAt, orphanBefore)))

  let orphansEscalated = 0
  for (const ticket of staleAwaiting) {
    const [live] = await deps.db
      .select({ id: proposals.id })
      .from(proposals)
      .where(and(eq(proposals.ticketId, ticket.id), inArray(proposals.status, [...LIVE_PROPOSAL_STATUSES])))
      .limit(1)
    if (live) continue

    // Guarded on the status this ticket was selected with (6A convention): 0 rows = the owner (or
    // a concurrent write) already moved it, skip silently.
    const escalated = await deps.db
      .update(supportTickets)
      .set({
        status: 'escalated',
        escalationReason: 'orphaned_awaiting_approval',
        // CRITICAL-1: cleared so `notifyPendingEscalations` (the only notifier) picks this ticket
        // up — nothing in this function notifies directly.
        escalationNotifiedAt: null,
      })
      .where(and(eq(supportTickets.id, ticket.id), eq(supportTickets.status, 'awaiting_approval')))
      .returning({ id: supportTickets.id })
    if (escalated.length > 0) orphansEscalated += 1
  }

  return { enqueued, orphansEscalated }
}
