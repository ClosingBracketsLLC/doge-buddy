import { promises as fs } from 'node:fs'
import type { SessionStore } from '@anthropic-ai/claude-agent-sdk'
import { formatCents } from '@doge-buddy/core'
import { agentRuns, auditLog, orders, proposals, supportMessages, supportTickets, type createDb } from '@doge-buddy/db'
import type { SupplierAdapter } from '@doge-buddy/supplier'
import { and, asc, count, eq, gt, gte, inArray, isNull, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type { HarnessResult, QueryFn } from '../agents/run-harness.ts'
import { SUPPORT_PROJECT_KEY } from '../agents/session-store.ts'
import { createSupportMcpServer } from '../agents/support-mcp-tools.ts'
import type { SupportOutput } from '../agents/support-output-schema.ts'
import {
  SUPPORT_LOCAL_CONFIG_DIR, SUPPORT_MODEL, runSupportAgent,
  type SupportRunContext, type SupportRunDeps,
} from '../agents/support-run.ts'
import type { SendOpts } from '../fulfillment/types.ts'
import type { NotifyOwner } from '../notify/notify.ts'
import { submitProposal, type SubmitProposalDeps } from '../proposals/submit.ts'
import type { Settings } from '../settings.ts'
import { validateSupportOutput } from '../support/validator.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

export const SUPPORT_AGENT_QUEUE = 'support.agent-run'

/** Global spend ceiling (spec §1 step 3) — counted from `support.agent_run` audit rows. */
export const SUPPORT_AGENT_MAX_RUNS_PER_DAY = 50
/** Per-ticket ceiling (spec §1 step 2): one hostile sender ping-ponging a single ticket must not
 * be able to burn the global cap and black out the agent for every real customer. */
export const SUPPORT_AGENT_MAX_RUNS_PER_TICKET_PER_DAY = 3
/** A claim older than this with no FINISH stamp past it is a run that never finished (e.g. a
 * Railway hard-kill that expired the job before any handler code ran) — same 20-minute horizon
 * `agents/lifecycle.ts` uses for orphaned `agent_runs` rows, and the same one the poll's selection
 * predicate uses so selection and claim agree on what "stuck" means. */
export const SUPPORT_AGENT_STUCK_AFTER_MINUTES = 20
/** Escalate once a ticket has burned this many failed attempts (spec §1 transitions table). */
const AGENT_FAILURE_ESCALATE_AT = 2

/** The spend row. Written BEFORE the SDK call so a crash mid-run still counts (fail-closed), and
 * read by BOTH caps — the per-ticket count filters these same rows by `entity_id`. */
export const AGENT_RUN_AUDIT_ACTION = 'support.agent_run'
/** A claim that matched nothing: the CAS lost, or the ticket moved on. */
export const AGENT_RUN_SKIPPED_ACTION = 'support.agent_run_skipped'
/** Guards the once-per-UTC-day global cap warning (escalate.ts's cap-warning pattern, hardened:
 * the check-and-insert runs inside this job's advisory lock, since this queue has many callers). */
export const AGENT_RUN_CAPPED_ACTION = 'support.agent_run_capped'
/** Records the per-ticket cap escalation (one row per capped ticket per day). */
export const AGENT_RUN_TICKET_CAPPED_ACTION = 'support.agent_run_ticket_capped'
/** The `no_action` outcome's only trace (the ticket itself stays `triaged`, unchanged). */
export const AGENT_NO_ACTION_ACTION = 'support.agent_no_action'
/** A `propose` outcome whose `triaged → awaiting_approval` flip matched 0 rows — nothing is
 * submitted, so this row is the only record that a drafted reply was thrown away. */
export const AGENT_PROPOSE_LOST_RACE_ACTION = 'support.agent_propose_lost_race'
/** One row per failed attempt, carrying the failure code (and the validator's detail, which is
 * deliberately audit-only — it quotes the rejected draft and is never customer-visible). */
export const AGENT_RUN_FAILED_ACTION = 'support.agent_run_failed'
/** One row per proposal expired by a newer run's propose outcome. */
export const PROPOSAL_SUPERSEDED_ACTION = 'proposal.superseded'

/** The proposal types a support run owns — the set a newer run supersedes. */
const SUPPORT_PROPOSAL_TYPES = ['support_reply', 'refund'] as const

export interface SupportAgentJobDeps {
  db: Db
  settings: Settings
  alert: Alert
  notify: NotifyOwner
  adminBaseUrl: string
  adapter: Pick<SupplierAdapter, 'getDisputeOptions'>
  enqueue: (name: string, data: object, opts?: SendOpts) => Promise<void>
  sessionStore: SessionStore
  /** `false` when `ANTHROPIC_API_KEY` is absent — mirrors the poll's env gating: skip, no stamp. */
  anthropicConfigured: boolean
  /** Injection seam threaded into the runner (tests pass an async-generator factory). */
  queryFn?: QueryFn
  /** Injection seam for the runner itself — tests stub the whole SDK run. */
  runFn?: typeof runSupportAgent
  now?: () => Date
}

/** The locked ticket row the claim evaluates its predicate against and the run is built from. */
type LockedTicket = typeof supportTickets.$inferSelect

function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/**
 * One `support.agent-run` job (spec §1 "Job order" — **pinned; the ordering IS the correctness**):
 *
 * 1. Kill levers / Anthropic env absent → return with no stamp and no audit row.
 * 2. Load the ticket; per-ticket daily cap → guarded `triaged → escalated` (`agent_run_cap`) + exit.
 * 3. Global daily cap; at cap, exit WITHOUT stamping (the ticket stays selectable after UTC
 *    midnight). Both caps and the spend-row insert share ONE advisory-locked transaction, in that
 *    observable order; only the per-ticket cap's escalation happens after the commit.
 * 4. Guarded CAS claim — the real per-ticket mutex. A queued duplicate whose predicate fails on the
 *    locked row exits as a no-op (`support.agent_run_skipped`), as does a stuck re-claim that hit
 *    the failure ceiling (escalated inside that same transaction).
 * 5. Resume pre-flight (the store may not have the session) + context assembly.
 * 6. Insert the `agent_runs` row directly (NOT `claimDailyRun` — support runs many per day).
 * 7. Run the agent, then handle the outcome (`runAndHandleOutcome`): transitions, the
 *    supersede+submit step, the watermark/session stamps, and failure accounting.
 *
 * CRITICAL-1 (binding): every transition INTO `escalated` here clears `escalation_notified_at` and
 * sets an `escalation_reason`, and NOTHING here notifies — the poll's `notifyPendingEscalations` is
 * the only notifier (its daily-cap check-then-act is only safe with that single caller).
 */
export async function executeSupportAgentRun(deps: SupportAgentJobDeps, ticketId: string): Promise<void> {
  const now = deps.now ?? (() => new Date())

  // --- Step 1: kill levers. No stamp, no audit row — this is a policy no-op, not an attempt.
  if (await deps.settings.get('killswitch.global')) return
  if (!(await deps.settings.get('workflow.support.enabled'))) return
  if (!deps.anthropicConfigured) return

  // --- Step 2: load the ticket. (Its cap check lives in step 3's transaction; this read is the
  // does-it-exist gate and the source of nothing else — the claim re-reads it under a row lock.)
  const [ticket] = await deps.db
    .select({ id: supportTickets.id })
    .from(supportTickets)
    .where(eq(supportTickets.id, ticketId))
    .limit(1)
  if (!ticket) return

  // --- Steps 2–3: BOTH caps and the spend-row insert in ONE transaction under
  // `pg_advisory_xact_lock` (the `agents/lifecycle.ts` pattern). This queue has no single-caller
  // guarantee (unlike triage's poll, which rides the singleton poll), so every check-then-act on
  // these counts has to hold the lock or two overlapping workers — routine during a deploy — both
  // read the same under-cap count and both proceed. That includes the once-per-day cap-warning
  // guard row: two capped workers racing a bare check-then-act would each insert one and page the
  // owner twice. The alert itself is fired OUTSIDE (best-effort I/O must never hold the lock).
  //
  // Order inside the lock is the spec's observable order: per-ticket cap, then global cap, then
  // spend row.
  const midnight = utcMidnight(now())
  const capResult = await deps.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'support-agent-daily'}))`)

    const [ticketRow] = await tx
      .select({ value: count() })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, AGENT_RUN_AUDIT_ACTION),
          eq(auditLog.entityId, ticketId),
          gte(auditLog.createdAt, midnight),
        ),
      )
    const runsForTicketToday = ticketRow?.value ?? 0
    if (runsForTicketToday >= SUPPORT_AGENT_MAX_RUNS_PER_TICKET_PER_DAY) {
      return { outcome: 'ticket_capped' as const, runsToday: runsForTicketToday }
    }

    const [globalRow] = await tx
      .select({ value: count() })
      .from(auditLog)
      .where(and(eq(auditLog.action, AGENT_RUN_AUDIT_ACTION), gte(auditLog.createdAt, midnight)))
    const runsToday = globalRow?.value ?? 0
    if (runsToday >= SUPPORT_AGENT_MAX_RUNS_PER_DAY) {
      const [existingWarning] = await tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(and(eq(auditLog.action, AGENT_RUN_CAPPED_ACTION), gte(auditLog.createdAt, midnight)))
        .limit(1)
      if (!existingWarning) {
        await tx.insert(auditLog).values({
          actor: 'system',
          action: AGENT_RUN_CAPPED_ACTION,
          detail: { max: SUPPORT_AGENT_MAX_RUNS_PER_DAY, runsToday },
        })
      }
      return { outcome: 'global_capped' as const, runsToday, shouldAlert: !existingWarning }
    }

    // The spend row goes in with the count that authorized it, inside the same lock — so a
    // concurrent claimer's count already includes this one.
    await tx.insert(auditLog).values({
      actor: 'system',
      action: AGENT_RUN_AUDIT_ACTION,
      entityType: 'ticket',
      entityId: ticketId,
      detail: { model: SUPPORT_MODEL },
    })
    return { outcome: 'proceed' as const, runsToday }
  })

  if (capResult.outcome === 'ticket_capped') {
    // Deliberately outside the transaction (and not retried): if the process dies between the
    // commit and these two writes, the ticket is left `triaged` with the cap still tripped, so the
    // next selection cycle re-enqueues it and this exact branch re-fires. Self-healing, and
    // cheaper than holding the global lock across two more writes.
    await escalateRunCapped(deps, ticketId)
    await deps.db.insert(auditLog).values({
      actor: 'system',
      action: AGENT_RUN_TICKET_CAPPED_ACTION,
      entityType: 'ticket',
      entityId: ticketId,
      detail: { max: SUPPORT_AGENT_MAX_RUNS_PER_TICKET_PER_DAY, runsToday: capResult.runsToday },
    })
    return
  }
  if (capResult.outcome === 'global_capped') {
    if (capResult.shouldAlert) {
      await deps
        .alert('warning', 'support_agent_run_capped', {
          max: SUPPORT_AGENT_MAX_RUNS_PER_DAY,
          runsToday: capResult.runsToday,
        })
        .catch(() => {})
    }
    return
  }

  // --- Step 4: guarded CAS claim (the per-ticket mutex). A stuck re-claim that reaches the failure
  // ceiling escalates inside that same transaction and comes back unclaimed — the run is skipped
  // (spec §1: otherwise a third hard-kill strands the ticket at count 2 with the ×2 net never run).
  const claim = await claimTicket(deps, ticketId, now())
  if (!claim.claimed) {
    await deps.db.insert(auditLog).values({
      actor: 'system',
      action: AGENT_RUN_SKIPPED_ACTION,
      entityType: 'ticket',
      entityId: ticketId,
      detail: { reason: claim.reason },
    })
    return
  }

  // --- Step 5: resume pre-flight. The store simply not having the session (e.g. a dropped mirror
  // batch) is NOT a failure — clear the id, run fresh. The per-run prompt is standalone-sufficient.
  let resumeSessionId = claim.ticket.agentSessionId
  if (resumeSessionId !== null) {
    const entries = await deps.sessionStore.load({ projectKey: SUPPORT_PROJECT_KEY, sessionId: resumeSessionId })
    if (entries === null) {
      // Guarded on the value we actually read: if anything else (Task 12's outcome handling, an
      // owner reject) has since written a DIFFERENT session id, this stale clear must not erase it.
      await deps.db
        .update(supportTickets)
        .set({ agentSessionId: null })
        .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.agentSessionId, resumeSessionId)))
      resumeSessionId = null
    }
  }

  const ctx = await buildContext(deps.db, claim.ticket, resumeSessionId)

  // --- Step 6: the `agent_runs` row, inserted directly. NOT `claimDailyRun` — that enforces one
  // claimed run per workflow per UTC day, and support legitimately runs many per day.
  const [run] = await deps.db
    .insert(agentRuns)
    .values({ workflow: 'support', triggerRef: ticketId, model: SUPPORT_MODEL, status: 'running' })
    .returning({ id: agentRuns.id })

  // --- Step 7: run, then handle the outcome. The MCP server is created per run, pinned to this
  // ticket. The local session mirror is disposable by design (Postgres holds the durable copy), so
  // it is removed after EVERY run — including the failure path, which throws through this `finally`.
  const runDeps: SupportRunDeps = {
    db: deps.db,
    alert: deps.alert,
    sessionStore: deps.sessionStore,
    mcpServer: createSupportMcpServer({ db: deps.db, adapter: deps.adapter, ticketId }),
    queryFn: deps.queryFn,
  }
  try {
    await runAndHandleOutcome(deps, runDeps, {
      ticketId,
      ticket: claim.ticket,
      threadSnapshotAt: claim.threadSnapshotAt,
      runId: run!.id,
      ctx,
      resumeSessionId,
      now,
    })
  } finally {
    await removeLocalSessionMirror()
  }
}

/** Best-effort `rm -rf` of the SDK's local session mirror. Never throws — Postgres is the durable
 * copy, and a run must not fail because a temp directory could not be removed. */
async function removeLocalSessionMirror(): Promise<void> {
  try {
    await fs.rm(SUPPORT_LOCAL_CONFIG_DIR, { recursive: true, force: true })
  } catch {
    // disposable by design
  }
}

interface OutcomeArgs {
  ticketId: string
  /** The PRE-update locked row from the claim (subject/orderId/customerEmail for the submit step). */
  ticket: LockedTicket
  /** The claim's `last_inbound_at` — this run's thread snapshot (spec §1 step 4). */
  threadSnapshotAt: Date | null
  runId: string
  ctx: SupportRunContext
  /** The session id this run actually resumed (null after a pre-flight clear) — also the value
   * every guarded write below compares against, so a newer id written by anything else survives. */
  resumeSessionId: string | null
  /** The injected clock, called AT stamp time — `last_agent_finished_at` is a completion stamp. */
  now: () => Date
}

function errorToDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Spec §1's outcome table, in one place (Task 12).
 *
 * The two watermark rules this function exists to get right:
 * - `last_agent_finished_at` is stamped on EVERY authoritative outcome (propose, escalate,
 *   no_action) — it is the wall-clock half of the stuck gate, and a finished run that skipped it
 *   would be re-claimed and re-billed every 20 minutes forever.
 * - It is NEVER stamped on the failure path: a failed or aborted run MUST keep looking unfinished,
 *   or stuck recovery can never rescue a ticket whose worker was hard-killed.
 */
async function runAndHandleOutcome(
  deps: SupportAgentJobDeps,
  runDeps: SupportRunDeps,
  args: OutcomeArgs,
): Promise<void> {
  const runFn = deps.runFn ?? runSupportAgent
  const { ticketId, ticket, now } = args

  let runId = args.runId
  /** The value we believe `agent_session_id` currently holds — every guarded write uses it. */
  let knownSessionId = args.resumeSessionId

  let result = await callRunner(deps, runFn, runDeps, { runId, ctx: args.ctx }, ticketId)

  // --- Resume failure (spec §2). ANY error before the first assistant message on a RESUMED run is
  // resume failure — the SDK surfaces materialization errors as plain `Error`s with no typed class,
  // so this is the only signal available. A run whose result MESSAGE arrived (even one whose DB
  // write then threw) always reports `failedBeforeFirstAssistant: false`, so an authoritative
  // result can never be misread as a resume failure here.
  if (args.ctx.isResume && result.status !== 'succeeded' && result.failedBeforeFirstAssistant) {
    await deps
      .alert('warning', 'support_resume_failed', { ticketId, runId, sessionId: args.resumeSessionId })
      .catch(() => {})
    await clearSessionId(deps.db, ticketId, knownSessionId)
    knownSessionId = null

    // ONE in-process retry as a fresh session. The per-run prompt is standalone-sufficient (spec
    // §3), so the retry gets the FULL thread — that is what makes this fallback safe. Its own
    // `agent_runs` row: overwriting the dead attempt's would erase the record of the failure.
    const freshCtx = await buildContext(deps.db, ticket, null)
    const [retryRun] = await deps.db
      .insert(agentRuns)
      .values({ workflow: 'support', triggerRef: ticketId, model: SUPPORT_MODEL, status: 'running' })
      .returning({ id: agentRuns.id })
    runId = retryRun!.id
    result = await callRunner(deps, runFn, runDeps, { runId, ctx: freshCtx }, ticketId)
  }

  // --- Mirror error: the durable transcript has a hole, so this session must never be resumed.
  // Checked on the result we actually process — a first attempt that was replaced by the resume
  // retry above already had its session cleared and its own alert. The outcome still processes
  // normally; only the session-id store is suppressed (it would undo this clear).
  let sessionUsable = true
  if (result.sawMirrorError) {
    await deps
      .alert('warning', 'support_session_mirror_error', { ticketId, runId, sessionId: result.sessionId })
      .catch(() => {})
    await clearSessionId(deps.db, ticketId, knownSessionId)
    knownSessionId = null
    sessionUsable = false
  }

  // --- Failure path: no usable output. `aborted` is the budget/turn ceiling; `failed` covers a
  // throw, the watchdog, and a schema-invalid `structured_output` (which the harness reports as a
  // failed run rather than a throw).
  if (result.status !== 'succeeded' || result.output === null) {
    const code = result.status === 'aborted' ? 'run_aborted' : 'run_failed'
    await recordFailure(deps, ticketId, { code, detail: `agent run ${result.status}` })
    throw new Error(`support agent run ${code} for ticket ${ticketId}`)
  }

  // --- Plain-code validator (spec §3): runs BEFORE any transition or submit, and its rejection is
  // an agent failure. `trackingUrl` is null because v1 stores none — `get_order` hands the agent a
  // tracking NUMBER only, so no off-domain link can legitimately appear in a draft.
  const validation = await validateSupportOutput(
    deps.db,
    { id: ticket.id, orderId: ticket.orderId, customerEmail: ticket.customerEmail },
    result.output,
  )
  if (!validation.ok) {
    await recordFailure(deps, ticketId, { code: validation.code, detail: validation.detail })
    throw new Error(`support agent output rejected (${validation.code}) for ticket ${ticketId}`)
  }

  const output = result.output
  if (output.outcome === 'no_action') {
    await deps.db.insert(auditLog).values({
      actor: 'system',
      action: AGENT_NO_ACTION_ACTION,
      entityType: 'ticket',
      entityId: ticketId,
      detail: { runId, rationale: output.rationale },
    })
  } else if (output.outcome === 'escalate') {
    // Guarded, 6A convention: 0 rows = the owner moved the ticket, skip silently.
    // CRITICAL-1: `escalation_notified_at` cleared, and NOTHING here notifies.
    const escalated = await deps.db
      .update(supportTickets)
      .set({
        status: 'escalated',
        escalationReason: output.escalationReason.slice(0, 500),
        escalationNotifiedAt: null,
      })
      .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.status, 'triaged')))
      .returning({ id: supportTickets.id })
    if (escalated.length === 0) {
      await deps.db.insert(auditLog).values({
        actor: 'system',
        action: AGENT_RUN_SKIPPED_ACTION,
        entityType: 'ticket',
        entityId: ticketId,
        detail: { reason: 'escalate_lost_race', runId },
      })
    }
  } else {
    await submitProposeOutcome(deps, {
      ticketId,
      ticket,
      output,
      // What was SCREENED is what gets stored, approved, and sent (the validator returns the
      // NFKC-normalized body it actually checked).
      body: validation.normalizedBody ?? output.reply.body,
      runId,
      // A ticket with no inbound message yet has no snapshot; "as of now" is then the truthful
      // one — any later inbound correctly reads as newer to the apply executors' staleness guard.
      threadSnapshotAt: (args.threadSnapshotAt ?? now()).toISOString(),
    })
  }

  // --- Authoritative outcome bookkeeping. Unguarded: these are watermarks, not a transition, and
  // they must land whichever status the ticket ended in (including a lost race — the run DID
  // finish, and leaving it unfinished would have the stuck gate re-run it on a timer).
  await deps.db
    .update(supportTickets)
    .set({
      lastAgentFinishedAt: now(),
      // Only advance the MESSAGE-time watermark when this run actually had a snapshot; writing
      // NULL over a real one would make the next resume re-send the whole thread.
      ...(args.threadSnapshotAt !== null ? { lastAgentPromptedAt: args.threadSnapshotAt } : {}),
    })
    .where(eq(supportTickets.id, ticketId))

  if (sessionUsable && result.sessionId !== null) {
    await deps.db
      .update(supportTickets)
      .set({ agentSessionId: result.sessionId })
      .where(and(eq(supportTickets.id, ticketId), sessionIdIs(knownSessionId)))
  }
}

/** Runs the agent, routing a throw out of the runner itself through the failure path before it
 * propagates. (`runAgentQuery` never throws — but `deps.runFn` and the MCP plumbing can.) */
async function callRunner(
  deps: SupportAgentJobDeps,
  runFn: NonNullable<SupportAgentJobDeps['runFn']>,
  runDeps: SupportRunDeps,
  input: { runId: string; ctx: SupportRunContext },
  ticketId: string,
): Promise<HarnessResult<SupportOutput>> {
  try {
    return await runFn(runDeps, input)
  } catch (err) {
    await recordFailure(deps, ticketId, { code: 'run_threw', detail: errorToDetail(err) })
    throw err
  }
}

/** `agent_session_id IS NOT DISTINCT FROM $expected`, spelled without a raw SQL fragment. */
function sessionIdIs(expected: string | null) {
  return expected === null ? isNull(supportTickets.agentSessionId) : eq(supportTickets.agentSessionId, expected)
}

/** Guarded on the value we last read, so a DIFFERENT id written since (an owner reject, a
 * concurrent write) is never erased by a stale clear — Task 11's pre-flight convention. */
async function clearSessionId(db: Db, ticketId: string, expected: string | null): Promise<void> {
  await db
    .update(supportTickets)
    .set({ agentSessionId: null })
    .where(and(eq(supportTickets.id, ticketId), sessionIdIs(expected)))
}

/**
 * The `propose` outcome's pinned order (spec §3): guarded transition → supersede → reply → refund.
 *
 * Transition-BEFORE-submit is what makes a future auto-mode flip a pure config change: auto-approve
 * enqueues the apply job instantly, and the apply's `awaiting_approval`-anchored checks must
 * already hold when it runs.
 */
async function submitProposeOutcome(
  deps: SupportAgentJobDeps,
  args: {
    ticketId: string
    ticket: LockedTicket
    output: Extract<SupportOutput, { outcome: 'propose' }>
    body: string
    runId: string
    threadSnapshotAt: string
  },
): Promise<void> {
  const { ticketId, ticket, output, runId, threadSnapshotAt } = args

  const flipped = await deps.db
    .update(supportTickets)
    .set({ status: 'awaiting_approval' })
    .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.status, 'triaged')))
    .returning({ id: supportTickets.id })
  if (flipped.length === 0) {
    // Someone else moved the ticket while the SDK call was in flight. Submitting now would put a
    // live proposal on a ticket nothing is anchored to, so the draft is dropped on the floor.
    await deps.db.insert(auditLog).values({
      actor: 'system',
      action: AGENT_PROPOSE_LOST_RACE_ACTION,
      entityType: 'ticket',
      entityId: ticketId,
      detail: { runId },
    })
    return
  }

  // A reopen re-run must never leave two live refund approvals sitting on the owner's phone.
  const superseded = await deps.db
    .update(proposals)
    .set({ status: 'expired' })
    .where(
      and(
        eq(proposals.ticketId, ticketId),
        inArray(proposals.type, [...SUPPORT_PROPOSAL_TYPES]),
        eq(proposals.status, 'pending'),
      ),
    )
    .returning({ id: proposals.id })
  if (superseded.length > 0) {
    await deps.db.insert(auditLog).values(
      superseded.map((row) => ({
        actor: 'system',
        action: PROPOSAL_SUPERSEDED_ACTION,
        entityType: 'proposal',
        entityId: row.id,
        detail: { ticketId, supersededByRunId: runId },
      })),
    )
  }

  const submitDeps: SubmitProposalDeps = {
    db: deps.db,
    settings: deps.settings,
    notify: deps.notify,
    enqueue: deps.enqueue,
    alert: deps.alert,
    adminBaseUrl: deps.adminBaseUrl,
  }

  await submitProposal(submitDeps, {
    type: 'support_reply',
    summary: `Reply: ${ticket.subject ?? '(no subject)'}`,
    payload: { type: 'support_reply', ticketId, body: args.body, threadSnapshotAt },
    sourceWorkflow: 'support',
    agentRunId: runId,
    ticketId,
  })

  if (output.refund) {
    // `ticket.orderId` and the order row are both guaranteed by the validator's refund gate
    // (`refund_unverified_order`), and `support_tickets.order_id` is an FK — the row cannot vanish.
    const orderId = ticket.orderId!
    const [order] = await deps.db
      .select({ shopifyOrderGid: orders.shopifyOrderGid, number: orders.shopifyOrderNumber })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1)
    const { amountCents, reason, openCjDispute, cjDisputeReasonId } = output.refund

    await submitProposal(submitDeps, {
      type: 'refund',
      summary: `Refund ${formatCents(amountCents)} order #${order?.number ?? 'unknown'} — ${reason.slice(0, 60)}`,
      payload: {
        type: 'refund',
        orderId,
        shopifyOrderGid: order!.shopifyOrderGid,
        amountCents,
        reason,
        openCjDispute,
        ...(cjDisputeReasonId === undefined ? {} : { cjDisputeReasonId }),
        threadSnapshotAt,
      },
      sourceWorkflow: 'support',
      agentRunId: runId,
      ticketId,
      // The Task-8 accumulation bound sums prior applied refunds by `proposals.order_id` — an
      // unset one makes this refund invisible to the next run's cap check.
      orderId,
    })
  }
}

/**
 * Spec §1's failure row, as ONE transaction under a row lock (the lock IS the guard, and a stronger
 * one than `WHERE status = 'triaged'`): count the attempt, and either escalate at the ceiling or
 * clear the claim stamp so the retry can claim immediately — without it the retry's CAS finds no
 * new inbound and no-ops, stranding the ticket at count 1 for 20 minutes.
 *
 * Deliberately does NOT stamp `last_agent_finished_at`: a failed attempt must keep reading as
 * "claimed but never finished", which is exactly what stuck recovery looks for.
 */
async function recordFailure(
  deps: SupportAgentJobDeps,
  ticketId: string,
  failure: { code: string; detail: string },
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.id, ticketId))
      .limit(1)
      .for('update')
    if (!locked) return

    const agentFailureCount = locked.agentFailureCount + 1
    if (agentFailureCount >= AGENT_FAILURE_ESCALATE_AT) {
      await tx
        .update(supportTickets)
        .set({
          agentFailureCount,
          // A transcript that failed twice is presumed poisoned; the fresh-session prompt is
          // standalone-sufficient (spec §3).
          agentSessionId: null,
          // CRITICAL-1: notified stamp cleared; the poll's notifyPendingEscalations is the notifier.
          ...(locked.status === 'triaged'
            ? { status: 'escalated', escalationReason: 'agent_failed', escalationNotifiedAt: null }
            : {}),
        })
        .where(eq(supportTickets.id, ticketId))
    } else {
      await tx
        .update(supportTickets)
        .set({ agentFailureCount, lastAgentRunAt: null })
        .where(eq(supportTickets.id, ticketId))
    }

    // Atomic with the accounting above. The validator's `detail` quotes the rejected draft — audit
    // only, never a customer-visible surface.
    await tx.insert(auditLog).values({
      actor: 'system',
      action: AGENT_RUN_FAILED_ACTION,
      entityType: 'ticket',
      entityId: ticketId,
      detail: { code: failure.code, reason: failure.detail },
    })
  })
}

type ClaimResult =
  /** Not claimed — including `reason: 'stuck_escalated'`, where the ticket was escalated inside the
   * claim transaction itself and the caller must simply not run. */
  | { claimed: false; reason: string }
  | {
      claimed: true
      /** True only when the STUCK branch is what authorized this claim (see `stuckClaim` below). */
      stuckClaim: boolean
      /** The count as it now stands in the row — already incremented when `stuckClaim`. */
      agentFailureCount: number
      /** The PRE-update locked row: its `last_agent_prompted_at` is still the prompt watermark this
       * run must filter against, and its `agent_session_id` the one pre-flight checks. */
      ticket: LockedTicket
      /** The locked read's `last_inbound_at` (spec §1 step 4) — this run's staleness + prompt
       * watermark. Task 12 promotes it to `last_agent_prompted_at` on an authoritative result. */
      threadSnapshotAt: Date | null
    }

/**
 * The CAS claim, as ONE transaction: `SELECT … FOR UPDATE` the ticket row, evaluate the selection
 * predicate against the LOCKED row in JS, then stamp. The row lock is what makes this a true
 * compare-and-swap — a concurrent claimer's SELECT blocks until this transaction commits, so it
 * reads the stamp this one wrote and backs off instead of racing it.
 *
 * **Three watermarks, and only two of them are comparable.** `last_agent_run_at` (stamped here,
 * before the SDK call) and `last_agent_finished_at` (stamped by Task 12 on every authoritative
 * outcome) are both WALL-CLOCK: `run_at` newer than `finished_at` means "claimed but never
 * finished", which is exactly what stuck-run recovery detects. `last_agent_prompted_at` is a
 * MESSAGE-time watermark (the run's thread snapshot) used only to filter a resumed run's thread —
 * comparing it against `run_at` would be comparing when a customer wrote against when a worker
 * started, which is degenerate: a ticket whose newest message is old (the normal case for a
 * completed run) would look permanently "stuck" and be re-run every 20 minutes, burning budget.
 *
 * The stuck branch also carries the ONLY increment: `stuckClaim` requires that neither
 * `neverRun` nor `newInbound` would have authorized the claim on their own. A ticket that ran
 * successfully an hour ago and just got new mail claims via `newInbound` and must NOT be charged a
 * failure — it did not fail, and two of those would escalate a perfectly healthy ticket.
 */
async function claimTicket(deps: SupportAgentJobDeps, ticketId: string, now: Date): Promise<ClaimResult> {
  const stuckBefore = new Date(now.getTime() - SUPPORT_AGENT_STUCK_AFTER_MINUTES * 60_000)

  return deps.db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.id, ticketId))
      .limit(1)
      .for('update')
    if (!locked) return { claimed: false, reason: 'ticket_missing' }
    if (locked.status !== 'triaged') return { claimed: false, reason: `status_${locked.status}` }
    if (locked.agentFailureCount >= AGENT_FAILURE_ESCALATE_AT) return { claimed: false, reason: 'failure_ceiling' }

    const neverRun = locked.lastAgentRunAt === null
    const newInbound =
      locked.lastAgentRunAt !== null &&
      locked.lastInboundAt !== null &&
      locked.lastInboundAt > locked.lastAgentRunAt
    // Stuck-run recovery, both sides wall-clock: claimed 20+ minutes ago and never finished (a
    // Railway hard-kill that expired the job before any handler code ran).
    const stuck =
      locked.lastAgentRunAt !== null &&
      locked.lastAgentRunAt < stuckBefore &&
      (locked.lastAgentFinishedAt === null || locked.lastAgentFinishedAt < locked.lastAgentRunAt)

    if (!neverRun && !newInbound && !stuck) return { claimed: false, reason: 'watermark' }

    // ONLY a claim the stuck branch had to authorize counts as a failed attempt.
    const stuckClaim = stuck && !neverRun && !newInbound
    const agentFailureCount = locked.agentFailureCount + (stuckClaim ? 1 : 0)

    // The ceiling case escalates INSIDE this transaction, atomically with the increment that
    // reached it. Split across two transactions, a hard-kill in between would leave the ticket
    // `triaged` at count 2: excluded from selection by the `< 2` predicate, never escalated, and so
    // never notified — stranded forever with zero owner signal. The stamp still goes on (harmless:
    // the ticket is leaving `triaged`), so the whole thing is one commit.
    //
    // No `WHERE status = 'triaged'` needed here, unlike the 6A convention: `locked.status` was read
    // under this transaction's row lock and nothing else can have written since. The lock IS the
    // guard, and a strictly stronger one.
    if (stuckClaim && agentFailureCount >= AGENT_FAILURE_ESCALATE_AT) {
      await tx
        .update(supportTickets)
        .set({
          lastAgentRunAt: now,
          agentFailureCount,
          status: 'escalated',
          escalationReason: 'agent_failed',
          // CRITICAL-1: cleared so `notifyPendingEscalations` (the only notifier) picks it up.
          escalationNotifiedAt: null,
          // A transcript that failed twice is presumed poisoned; the fresh-session prompt is
          // standalone-sufficient (spec §3).
          agentSessionId: null,
        })
        .where(eq(supportTickets.id, ticketId))
      return { claimed: false, reason: 'stuck_escalated' }
    }

    await tx
      .update(supportTickets)
      .set({ lastAgentRunAt: now, ...(stuckClaim ? { agentFailureCount } : {}) })
      .where(eq(supportTickets.id, ticketId))

    return { claimed: true, stuckClaim, agentFailureCount, ticket: locked, threadSnapshotAt: locked.lastInboundAt }
  })
}

/**
 * Assembles the run context. Messages come back ascending by `sent_at` (the order
 * `SupportRunContext` documents and `senderAuthNote` depends on), filtered to the prompt watermark
 * ONLY when resuming — a fresh run always gets the full thread, which is what makes the resume
 * fallback safe.
 */
async function buildContext(db: Db, ticket: LockedTicket, resumeSessionId: string | null): Promise<SupportRunContext> {
  const isResume = resumeSessionId !== null
  const promptedAt = ticket.lastAgentPromptedAt

  const messages = await db
    .select({
      direction: supportMessages.direction,
      fromEmail: supportMessages.fromEmail,
      sentAt: supportMessages.sentAt,
      bodyText: supportMessages.bodyText,
      authResults: supportMessages.authResults,
    })
    .from(supportMessages)
    .where(
      isResume && promptedAt !== null
        ? and(eq(supportMessages.ticketId, ticket.id), gt(supportMessages.sentAt, promptedAt))
        : eq(supportMessages.ticketId, ticket.id),
    )
    .orderBy(asc(supportMessages.sentAt), asc(supportMessages.createdAt), asc(supportMessages.id))

  const priorProposals = await db
    .select({
      id: proposals.id,
      type: proposals.type,
      status: proposals.status,
      summary: proposals.summary,
    })
    .from(proposals)
    .where(eq(proposals.ticketId, ticket.id))
    .orderBy(asc(proposals.createdAt))

  return {
    ticket: {
      id: ticket.id,
      subject: ticket.subject,
      category: ticket.category,
      sentiment: ticket.sentiment,
      status: ticket.status,
      customerEmail: ticket.customerEmail,
      orderId: ticket.orderId,
      claimedOrderNumber: ticket.claimedOrderNumber,
      escalationReason: ticket.escalationReason,
    },
    messages,
    priorProposals,
    resumeSessionId,
    isResume,
  }
}

/**
 * Guarded `triaged → escalated` for the per-ticket cap (6A convention: 0 rows matched = the owner
 * moved the ticket, skip silently). The session id is deliberately kept — nothing failed here, the
 * ticket just ran out of budget for the day, and tomorrow's run should still be able to resume.
 *
 * CRITICAL-1: clears `escalation_notified_at` so a ticket that was escalated+notified before, then
 * resolved, then re-escalated here is still selectable by `notifyPendingEscalations` — which is the
 * ONLY notifier; nothing in this job pages the owner directly.
 *
 * (The `agent_failed` escalation is NOT here: it must commit atomically with the failure-count
 * increment that reached the ceiling, so it lives inside `claimTicket`'s transaction.)
 */
async function escalateRunCapped(deps: SupportAgentJobDeps, ticketId: string): Promise<void> {
  await deps.db
    .update(supportTickets)
    .set({ status: 'escalated', escalationReason: 'agent_run_cap', escalationNotifiedAt: null })
    .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.status, 'triaged')))
}

/**
 * Worker callback for the `support.agent-run` queue — thin adapter, same shape as every other job
 * wrapper in this directory. No dead-lettering here: Task 12 owns failure accounting, and the
 * queue's `retryLimit: 1` plus the next selection cycle (the CAS serializes them) is the retry.
 *
 * Per-job try/catch: pg-boss can hand this handler a BATCH, and one ticket's throw must not abandon
 * the tickets behind it in the array — they'd be marked failed without ever having been attempted.
 * Every job runs; the first error is rethrown after the loop so pg-boss still fails the batch (its
 * completion granularity is the batch, so a partial success cannot be reported any other way).
 */
export function supportAgentRunHandler(deps: SupportAgentJobDeps): PgBoss.WorkHandler<{ ticketId: string }> {
  return async (jobs) => {
    let firstError: unknown = null
    for (const job of jobs) {
      try {
        await executeSupportAgentRun(deps, job.data.ticketId)
      } catch (err) {
        firstError = firstError ?? err
      }
    }
    if (firstError !== null) throw firstError
  }
}

/**
 * The single producer for this queue (spec §1): `singletonKey: ticketId` on a `policy: 'singleton'`
 * queue serializes per-ticket execution, `retryLimit: 1`/`retryDelay: 30` gives one retry, and
 * `expireInSeconds: 600` sits above the runner's 300s watchdog so the job never expires out from
 * under a live SDK call.
 */
export function enqueueSupportAgentRun(
  enqueue: SupportAgentJobDeps['enqueue'],
  ticketId: string,
): Promise<void> {
  return enqueue(
    SUPPORT_AGENT_QUEUE,
    { ticketId },
    { singletonKey: ticketId, retryLimit: 1, retryDelay: 30, expireInSeconds: 600 },
  )
}
