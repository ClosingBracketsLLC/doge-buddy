import { proposals, supportTickets, type createDb } from '@doge-buddy/db'
import { and, eq, exists, inArray, isNull, lt, notExists, or, sql } from 'drizzle-orm'
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

/** Proposal statuses that count as "still live" for the orphan check — `pending`/`approved`/
 * `applying` ONLY. Deliberately NOT `applied`/`rejected`/`failed` (fix round 1, IMPORTANT 2 —
 * corrects an earlier version of this comment that claimed the opposite of what this code has
 * always done): those three are TERMINAL proposal states, and a ticket sitting in
 * `awaiting_approval` whose only proposal is terminal is exactly the crash/lost-race window this
 * backstop exists to catch — e.g. `proposal.apply`'s Shopify/refund call committed (`applied`) but
 * the process died before the ticket's own status write landed, or an owner `rejected` the one live
 * proposal and nothing has re-proposed since. Treating a terminal proposal as "not live" is what
 * lets the backstop actually escalate those tickets instead of leaving them stranded forever behind
 * a proposal that can never change status again on its own. */
const LIVE_PROPOSAL_STATUSES = ['pending', 'approved', 'applying'] as const

/** FR2b unbacked-refund-promise backstop: a refund proposal in one of these terminal, non-applied
 * states is money that will never move — the promise a shipped reply made is now unbacked. */
const DEAD_REFUND_STATUSES = ['expired', 'rejected', 'failed'] as const
/** FR2b: refund statuses that still count as backing a promise (money moved, or one tap/enqueue from
 * moving) — same set as `validator.ts`'s `LIVE_REFUND_PROPOSAL_STATUSES`, incl. `applied`. */
const LIVE_REFUND_STATUSES = ['pending', 'approved', 'applying', 'applied'] as const

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
 * **2. Orphan backstop** (CRITICAL-1, anchor amended in fix round 1 — IMPORTANT 3): `awaiting_approval`
 * tickets with no live support proposal, idle past `ORPHAN_AFTER_MINUTES` on the ANCHOR defined by
 * `orphanAnchor` below, are guarded-escalated (`orphaned_awaiting_approval`, `escalationNotifiedAt`
 * cleared). Nothing here notifies — the escalate stage already ran earlier in THIS poll cycle, so a
 * ticket escalated here is picked up by `notifyPendingEscalations` on the NEXT cycle, one minute
 * later.
 *
 * The anchor is deliberately NOT `support_tickets.updated_at` alone: every inbound message bumps it
 * (the column's own `$onUpdate`), so a customer chasing a stalled ticket — writing again and again,
 * asking what happened to their refund — would keep resetting the very clock meant to catch exactly
 * that situation. Chasing is the SIGNAL something is stuck, not evidence it isn't. See `orphanAnchor`
 * for the actual precedence.
 */
export async function selectAndEnqueueAgentRuns(
  deps: AgentSelectDeps,
): Promise<{ enqueued: number; orphansEscalated: number; unbackedEscalated: number }> {
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
    // NULLS FIRST (fix round 1, Minor 5): Postgres's default for ASC is NULLS LAST, which would
    // sort a ticket with no inbound at all (`last_inbound_at IS NULL`) BEHIND every ticket that has
    // one — starving it off the back of the cap forever on a busy cycle. NULLS FIRST treats "no
    // inbound yet" as the oldest possible case, which is the conservative reading.
    .orderBy(sql`${supportTickets.lastInboundAt} ASC NULLS FIRST`)
    .limit(AGENT_SELECT_CAP_PER_CYCLE)

  // NOTE (fix round 2): `enqueued` over-reports relative to "jobs actually newly created" once
  // `support.agent-run`'s queue policy is `'stately'` (see index.ts) — a `singletonKey` collision
  // against an already created-or-active job makes pg-boss's `send()` return `null` rather than
  // throw, so `enqueueSupportAgentRun`'s `Promise<void>` resolves normally and this still counts
  // it. Harmless: nothing consumes this count today (it's not logged, alerted on, or asserted
  // against in production) — it exists purely as this function's own return value for tests and
  // any future caller. If a future caller needs an accurate "how many NEW jobs did this create"
  // number, `enqueue`'s signature would need to surface pg-boss's job id (or `null`) through the
  // `SendFn`/`enqueueSupportAgentRun` chain instead of discarding it.
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

  const orphansEscalated = await escalateOrphans(deps.db, orphanBefore(nowVal))

  // FR2b: the unbacked-refund-promise backstop, sharing the SAME per-cycle escalation budget as the
  // orphan backstop (10/cycle total) — whatever the orphan pass already spent is subtracted here.
  const unbackedEscalated = await escalateUnbackedRefundPromises(
    deps.db,
    AGENT_SELECT_CAP_PER_CYCLE - orphansEscalated,
  )

  return { enqueued, orphansEscalated, unbackedEscalated }
}

function orphanBefore(nowVal: Date): string {
  // ISO + explicit cast (`ingest.ts`'s own `${...}::timestamptz` convention) rather than handing a
  // bare JS `Date` to a raw `sql` fragment: the comparison's LEFT side below is a `COALESCE(...)`
  // expression, not a plain column, so there is no drizzle column encoder to infer a `timestamptz`
  // parameter type from — an explicit cast makes the type unambiguous regardless.
  return new Date(nowVal.getTime() - ORPHAN_AFTER_MINUTES * 60_000).toISOString()
}

/**
 * The orphan backstop, as ONE set-based statement (fix round 1 — IMPORTANT 3 + Minor 4 folded
 * together): a correlated `NOT EXISTS` for "no live support proposal", a correlated `COALESCE`
 * anchor for "idle long enough" that does NOT degrade on customer chasing, and a `LIMIT` so one
 * cycle can't try to escalate an unbounded backlog in a single round trip.
 *
 * **The anchor, precedence in order:**
 * 1. This ticket's own newest proposal's `created_at`, if it has ever had one — a fresh DRAFT (even
 *    one later expired/rejected) is real activity and resets the clock.
 * 2. Else `last_agent_run_at` — the ticket was claimed and run at least once, just never drafted
 *    anything that became a proposal row (shouldn't happen for a `propose` outcome, but the fallback
 *    costs nothing and fails toward "not yet orphaned" rather than a NULL comparison).
 * 3. Else `updated_at` — neither of the above ever happened; this is the floor every ticket has.
 *
 * `updated_at` is deliberately NOT the anchor on its own (spec amendment, IMPORTANT 3): every
 * inbound message bumps it via the column's own `$onUpdate`, so a customer repeatedly chasing a
 * stalled ticket would keep resetting the exact clock meant to catch that ticket as stuck — starving
 * the backstop precisely when it matters most. Only genuine PROPOSAL activity (a new draft, a
 * supersede touching `updated_at` via the proposals row itself) can reset the countdown; a bare
 * inbound message cannot.
 */
async function escalateOrphans(db: Db, before: string): Promise<number> {
  const liveProposalExists = db
    .select({ one: sql`1` })
    .from(proposals)
    .where(and(eq(proposals.ticketId, supportTickets.id), inArray(proposals.status, [...LIVE_PROPOSAL_STATUSES])))

  const orphanAnchor = sql`COALESCE(
    (SELECT max(${proposals.createdAt}) FROM ${proposals} WHERE ${proposals.ticketId} = ${supportTickets.id}),
    ${supportTickets.lastAgentRunAt},
    ${supportTickets.updatedAt}
  )`

  // The id-selection subquery gets its OWN `FROM support_tickets`, which is what makes `LIMIT`
  // meaningful here (Postgres `UPDATE` has no `LIMIT` clause of its own) — the correlated
  // `NOT EXISTS`/`orphanAnchor` subqueries above resolve against THIS nearest enclosing FROM, not
  // the outer UPDATE's target, so there is no ambiguity despite both naming the same table.
  const orphanCandidateIds = db
    .select({ id: supportTickets.id })
    .from(supportTickets)
    .where(
      and(
        eq(supportTickets.status, 'awaiting_approval'),
        notExists(liveProposalExists),
        sql`${orphanAnchor} < ${before}::timestamptz`,
      ),
    )
    .orderBy(sql`${orphanAnchor} ASC`)
    .limit(AGENT_SELECT_CAP_PER_CYCLE)

  // The `status = 'awaiting_approval'` condition is repeated here even though it's ONE atomic
  // statement (the subquery and this UPDATE share the same snapshot — there is no separate round
  // trip for a concurrent write to land in between): cheap, harmless, and it keeps this UPDATE
  // self-evidently guarded the same way every other status transition in this codebase is (6A
  // convention), rather than relying on a reader trusting the subquery's own WHERE clause never to
  // drift out of sync with it.
  const escalated = await db
    .update(supportTickets)
    .set({
      status: 'escalated',
      escalationReason: 'orphaned_awaiting_approval',
      // CRITICAL-1: cleared so `notifyPendingEscalations` (the only notifier) picks these tickets
      // up — nothing in this function notifies directly.
      escalationNotifiedAt: null,
    })
    .where(and(inArray(supportTickets.id, orphanCandidateIds), eq(supportTickets.status, 'awaiting_approval')))
    .returning({ id: supportTickets.id })

  return escalated.length
}

/**
 * FR2b — the unbacked-refund-promise backstop. Catches the PURE-INACTION expire path the reject
 * escalation (`support-decision.ts`) can never see: a reply promising a refund SHIPS (flipping the
 * ticket to `waiting_on_customer`), its paired refund proposal just sits `pending`, and 7 days
 * later `proposal-expire-sweep.ts` flips it `expired` — no reject event ever fires, so nothing
 * escalates and the customer holds a written refund promise with nothing behind it, zero owner
 * signal.
 *
 * A `waiting_on_customer` ticket is escalated (`refund_promise_unbacked`, notify — stamp NULL) iff:
 *   - it has an APPLIED `support_reply` proposal (a reply actually went out), AND
 *   - it has a `refund` proposal in a terminal-non-applied state (expired/rejected/failed — the
 *     promise's backing died), AND
 *   - it has NO live (`pending`/`approved`/`applying`/`applied`) `refund` proposal (a later run may
 *     have re-proposed a fresh refund that still backs the promise — don't page in that case).
 *
 * `limitLeft` is what the orphan backstop left of the per-cycle escalation budget; ≤ 0 → skip
 * entirely (no query). Nothing here notifies — the escalate stage already ran earlier this poll
 * cycle, so `notifyPendingEscalations` pages on the NEXT cycle, exactly like the orphan backstop.
 */
async function escalateUnbackedRefundPromises(db: Db, limitLeft: number): Promise<number> {
  if (limitLeft <= 0) return 0

  const appliedReplyExists = db
    .select({ one: sql`1` })
    .from(proposals)
    .where(and(eq(proposals.ticketId, supportTickets.id), eq(proposals.type, 'support_reply'), eq(proposals.status, 'applied')))

  const deadRefundExists = db
    .select({ one: sql`1` })
    .from(proposals)
    .where(
      and(eq(proposals.ticketId, supportTickets.id), eq(proposals.type, 'refund'), inArray(proposals.status, [...DEAD_REFUND_STATUSES])),
    )

  const liveRefundExists = db
    .select({ one: sql`1` })
    .from(proposals)
    .where(
      and(eq(proposals.ticketId, supportTickets.id), eq(proposals.type, 'refund'), inArray(proposals.status, [...LIVE_REFUND_STATUSES])),
    )

  // Same self-`FROM support_tickets` + `LIMIT` shape as `escalateOrphans` (Postgres UPDATE has no
  // LIMIT of its own); the correlated EXISTS subqueries resolve against THIS enclosing FROM.
  const candidateIds = db
    .select({ id: supportTickets.id })
    .from(supportTickets)
    .where(
      and(
        eq(supportTickets.status, 'waiting_on_customer'),
        exists(appliedReplyExists),
        exists(deadRefundExists),
        notExists(liveRefundExists),
      ),
    )
    .orderBy(sql`${supportTickets.updatedAt} ASC`)
    .limit(limitLeft)

  const escalated = await db
    .update(supportTickets)
    .set({
      status: 'escalated',
      escalationReason: 'refund_promise_unbacked',
      // Cleared so `notifyPendingEscalations` (the only notifier) pages — a shipped promise that
      // lost its backing must reach the owner's phone, unlike the owner's own reject tap.
      escalationNotifiedAt: null,
    })
    .where(and(inArray(supportTickets.id, candidateIds), eq(supportTickets.status, 'waiting_on_customer')))
    .returning({ id: supportTickets.id })

  return escalated.length
}
