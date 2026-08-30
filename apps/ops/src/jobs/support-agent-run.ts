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
import { SUBJECT_MAX_CHARS, submitProposal, type SubmitProposalDeps } from '../proposals/submit.ts'
import type { Settings } from '../settings.ts'
import { clearRedraftCycle } from '../support/redraft.ts'
import { validateSupportOutput } from '../support/validator.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

export const SUPPORT_AGENT_QUEUE = 'support.agent-run'

/** Global spend ceiling (spec §1 step 3) — counted from `support.agent_run` audit rows. */
export const SUPPORT_AGENT_MAX_RUNS_PER_DAY = 50
/** Per-ticket ceiling (spec §1 step 2): one hostile sender ping-ponging a single ticket must not
 * be able to burn the global cap and black out the agent for every real customer.
 *
 * Load-bearing relationship with `support/redraft.ts`'s `SUPPORT_REDRAFT_MAX`: each reject-with-
 * reason redraft is an agent run counted against THIS immutable daily cap (a re-arm cannot reset
 * it), so `1 + SUPPORT_REDRAFT_MAX <= SUPPORT_AGENT_MAX_RUNS_PER_TICKET_PER_DAY` must hold — the
 * original draft plus the allowed redrafts must fit under the cap, or the redraft cycle escalates
 * early on the run cap (wrong reason) instead of on `redraft_limit_reached`. With MAX=2: 1 + 2 = 3. */
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
/** The same thing for an `escalate` outcome whose guarded flip matched 0 rows. Its own action
 * rather than a generic skip: this one happened AFTER a run was paid for, and telling it apart
 * from a claim that never ran matters when reading the audit trail. */
export const AGENT_ESCALATE_LOST_RACE_ACTION = 'support.agent_escalate_lost_race'
/** One row per failed attempt, carrying the failure code (and the validator's detail, which is
 * deliberately audit-only — it quotes the rejected draft and is never customer-visible). */
export const AGENT_RUN_FAILED_ACTION = 'support.agent_run_failed'
/** One row per proposal expired by a newer run's propose outcome. */
export const PROPOSAL_SUPERSEDED_ACTION = 'proposal.superseded'

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
 * One `support.agent-run` job (spec §1 "Job order" — **pinned; the ordering IS the correctness**;
 * amended TWICE 2026-08-27 — see the CRITICAL note below for the full history):
 *
 * 1. Kill levers / Anthropic env absent → return with no stamp and no audit row.
 * 2. **Read-only pre-claim cap checks** (fix round 2): plain SELECT counts, no lock, no insert.
 *    Per-ticket ≥ 3 → guarded `triaged → escalated` (`agent_run_cap`) + exit, NEVER stamped —
 *    this is also what keeps a ticket that's BOTH stuck AND per-ticket-capped correctly labeled
 *    `agent_run_cap` rather than `agent_failed`: it never reaches the claim's own stuck-recovery
 *    branch at all. Global ≥ 50 → exit with NO stamp (the ticket stays selectable after UTC
 *    midnight), once-per-UTC-day warning alert.
 * 3. Guarded CAS claim — the real per-ticket mutex. A queued duplicate/redelivery whose predicate
 *    fails on the locked row exits as a no-op (`support.agent_run_skipped`) BEFORE any spend row
 *    exists. A stuck re-claim that hits the failure ceiling escalates inside that same transaction
 *    and comes back unclaimed.
 * 4. **Locked cap RE-check + spend insert**, one advisory-locked transaction — step 2's checks were
 *    UNLOCKED, so a deploy-overlap race (two workers) can slip a second claim past them; this
 *    re-check under the SAME lock as the spend insert is the actual enforcement. Per-ticket re-trip
 *    → guarded `triaged → escalated` (`agent_run_cap`) + return (the claim's stamp is moot — the
 *    ticket is leaving `triaged`). Global re-trip → **UNWIND** the claim's stamp (guarded on the
 *    EXACT value step 3 wrote) + return with NO spend row, leaving the ticket exactly as if step 3
 *    had never run. Under cap: insert the spend row, proceed.
 * 5. Resume pre-flight (the store may not have the session) + context assembly.
 * 6. Insert the `agent_runs` row directly (NOT `claimDailyRun` — support runs many per day).
 * 7. Run the agent, then handle the outcome (`runAndHandleOutcome`): transitions, the
 *    supersede+submit step, the watermark/session stamps, and failure accounting.
 *
 * CRITICAL (fix round 2 — supersedes fix round 1's note, kept for the history): round 1 moved
 * BOTH caps to run entirely AFTER the claim, to stop a CAS-rejected duplicate from burning a spend
 * row. That fixed the duplicate-spend bug but introduced a WORSE one, empirically reproduced: on a
 * day the global cap was already exhausted, EVERY triaged ticket still claimed successfully (the
 * claim doesn't know about the cap) and stamped `last_agent_run_at` — then, `SUPPORT_AGENT_STUCK_
 * AFTER_MINUTES` later, `claimTicket`'s stuck-recovery branch saw "claimed, never finished" and
 * charged a FAILURE, and ~2 stuck cycles later every remaining triaged ticket had falsely
 * escalated `agent_failed`, with the agent never having run once. The per-ticket cap had the same
 * defect in miniature: a ticket that was BOTH stuck AND per-ticket-capped got mislabeled
 * `agent_failed` instead of `agent_run_cap`, since the claim's stuck-increment ran before the cap
 * ever got a chance to say otherwise.
 *
 * The fix (this round) keeps BOTH properties by checking twice. Step 2's cheap unlocked read keeps
 * the capped case from EVER reaching the claim on the common (non-race) path — no stamp, so no
 * stuck-gate false failure, and a stuck+capped ticket is labeled `agent_run_cap` correctly because
 * it never reaches `claimTicket`'s stuck branch at all. Step 4's locked re-check is what makes this
 * correct even under a genuine race (two workers slipping past step 2's unlocked read at once) —
 * and when IT catches a global cap trip after the claim already stamped the row, it UNWINDS that
 * stamp rather than leaving it standing (round 1's mistake), so the false-failure bug can't recur
 * through the race path either. `claimTicket` returns both the prior and the exact stamped
 * `last_agent_run_at` value to make that unwind's guard expressible.
 *
 * CRITICAL-1 (binding): every transition INTO `escalated` here clears `escalation_notified_at` and
 * sets an `escalation_reason`, and NOTHING here notifies — the poll's `notifyPendingEscalations` is
 * the only notifier (its daily-cap check-then-act is only safe with that single caller).
 */
export async function executeSupportAgentRun(deps: SupportAgentJobDeps, ticketId: string): Promise<void> {
  const now = deps.now ?? (() => new Date())
  const midnight = utcMidnight(now())

  // --- Step 1: kill levers. No stamp, no audit row — this is a policy no-op, not an attempt.
  if (await deps.settings.get('killswitch.global')) return
  if (!(await deps.settings.get('workflow.support.enabled'))) return
  if (!deps.anthropicConfigured) return

  // --- Step 2: read-only pre-claim cap checks (fix round 2 — see this function's own doc comment
  // for why this has to run BEFORE the claim). Plain SELECT counts: no lock, no insert. The
  // once-per-day warning's guard-row insert is its own tiny locked transaction (`warnGlobalCapped`
  // below) — kept race-safe independently of these unlocked counts, which only need to be cheap and
  // right most of the time; step 4's locked re-check is what makes the caps correct under a race.
  const [preTicketCap] = await deps.db
    .select({ value: count() })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, AGENT_RUN_AUDIT_ACTION),
        eq(auditLog.entityId, ticketId),
        gte(auditLog.createdAt, midnight),
      ),
    )
  if ((preTicketCap?.value ?? 0) >= SUPPORT_AGENT_MAX_RUNS_PER_TICKET_PER_DAY) {
    await escalateTicketCapped(deps, ticketId, preTicketCap?.value ?? 0)
    return
  }

  const [preGlobalCap] = await deps.db
    .select({ value: count() })
    .from(auditLog)
    .where(and(eq(auditLog.action, AGENT_RUN_AUDIT_ACTION), gte(auditLog.createdAt, midnight)))
  if ((preGlobalCap?.value ?? 0) >= SUPPORT_AGENT_MAX_RUNS_PER_DAY) {
    await warnGlobalCapped(deps, midnight, preGlobalCap?.value ?? 0)
    // No stamp — the ticket stays selectable after UTC midnight, exactly as if this cycle never
    // touched it. This early exit (before the claim) is the entire point of fix round 2.
    return
  }

  // --- Step 3: guarded CAS claim (the per-ticket mutex). A queued duplicate whose predicate fails
  // on the locked row exits right here, before any spend row exists. A stuck re-claim that hits the
  // failure ceiling escalates inside that same transaction and comes back unclaimed (spec §1:
  // otherwise a third hard-kill strands the ticket at count 2 with the ×2 net never run).
  //
  // `claimedAt` is captured ONCE and reused as step 4's unwind guard value (`claim.
  // stampedLastAgentRunAt` below is this exact same Date) — calling `now()` a second time for that
  // guard could return a DIFFERENT millisecond on a real clock, which would make the unwind's
  // `WHERE last_agent_run_at = <value>` guard never match and silently no-op.
  const claimedAt = now()
  const claim = await claimTicket(deps, ticketId, claimedAt)
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

  // --- Step 4: locked cap RE-check + spend insert, one advisory-locked transaction (the
  // `agents/lifecycle.ts` pattern). This queue has no single-caller guarantee (unlike triage's
  // poll, which rides the singleton poll), so — now that step 2's unlocked read has already caught
  // the common case — this re-check under the lock is what makes the caps correct even when a
  // deploy-overlap race slipped a second worker past step 2. The alert for a re-tripped global cap
  // is fired OUTSIDE this transaction (best-effort I/O must never hold the lock).
  //
  // Order inside the lock is the spec's observable order: per-ticket cap, then global cap, then
  // spend row.
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
    // A genuine race — step 2's unlocked read missed this (another worker's spend rows landed
    // between that read and this locked re-check). Same handling as step 2's own (far more common)
    // per-ticket-capped exit: the claim's stamp is moot, the ticket is leaving `triaged` entirely,
    // and every selection/claim predicate requires `status = 'triaged'`, so no watermark on this
    // row matters again until (if ever) an operator moves it back.
    await escalateTicketCapped(deps, ticketId, capResult.runsToday)
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
    // CRITICAL fix round 2: UNWIND step 3's claim stamp — round 1 left it standing here, which is
    // exactly the bug fix round 2 exists to close (see this function's own doc comment).
    await unwindClaimStamp(deps.db, ticketId, claim.stampedLastAgentRunAt, claim.priorLastAgentRunAt)
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

  const ownerGuidance = await deps.settings.get('support.agent_guidance')
  const ctx = await buildContext(deps.db, claim.ticket, resumeSessionId, ownerGuidance)

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

/**
 * Best-effort `rm -rf` of the SDK's local session mirror. Never throws — Postgres is the durable
 * copy, and a run must not fail because a temp directory could not be removed.
 *
 * ASSUMES SERIAL RUNS: this removes the WHOLE shared config dir, not one run's subdirectory, so a
 * concurrently running support agent in the same process would have its live mirror deleted out
 * from under it. The queue wiring must keep this queue's worker batch size at 1 (and one worker per
 * process) — if that ever changes, this has to narrow to the run's own session subdirectory first.
 */
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

  // --- Resume failure (spec §2). ANY error before the first assistant message on a RESUMED run is
  // resume failure — the SDK surfaces materialization errors as plain `Error`s with no typed class,
  // so this is the only signal available. It arrives in TWO shapes, and both have to route here:
  //   (a) a HarnessResult with `failedBeforeFirstAssistant` — a run whose result MESSAGE arrived
  //       (even one whose DB write then threw) always reports `false`, so an authoritative result
  //       can never be misread as a resume failure; and
  //   (b) a THROW out of the runner — no result at all, which is the strongest possible form of
  //       "died before the first assistant message". A throw on a FRESH run is not determinable as
  //       resume failure (there is no session to blame), so that one falls through to the failure
  //       path as before.
  let result: HarnessResult<SupportOutput> | null = null
  let resumeThrow: unknown = null
  try {
    result = await runFn(runDeps, { runId, ctx: args.ctx })
  } catch (err) {
    if (!args.ctx.isResume) {
      await recordFailureSafely(deps, ticketId, { code: 'run_threw', detail: errorToDetail(err) })
      throw err
    }
    resumeThrow = err
  }

  if (
    args.ctx.isResume &&
    (resumeThrow !== null || (result!.status !== 'succeeded' && result!.failedBeforeFirstAssistant))
  ) {
    await deps
      .alert('warning', 'support_resume_failed', {
        ticketId,
        runId,
        sessionId: args.resumeSessionId,
        ...(resumeThrow === null ? {} : { error: errorToDetail(resumeThrow) }),
      })
      .catch(() => {})
    await clearSessionId(deps.db, ticketId, knownSessionId)
    knownSessionId = null

    // ONE in-process retry as a fresh session. The per-run prompt is standalone-sufficient (spec
    // §3), so the retry gets the FULL thread — that is what makes this fallback safe. Its own
    // `agent_runs` row: overwriting the dead attempt's would erase the record of the failure.
    const freshCtx = await buildContext(deps.db, ticket, null, args.ctx.ownerGuidance)
    const [retryRun] = await deps.db
      .insert(agentRuns)
      .values({ workflow: 'support', triggerRef: ticketId, model: SUPPORT_MODEL, status: 'running' })
      .returning({ id: agentRuns.id })
    runId = retryRun!.id
    try {
      result = await runFn(runDeps, { runId, ctx: freshCtx })
    } catch (err) {
      // Only the RETRY's failure enters the failure path (spec §2).
      await recordFailureSafely(deps, ticketId, { code: 'run_threw', detail: errorToDetail(err) })
      throw err
    }
  }

  // Non-null from here: the first call either returned, or — on a throw — already rethrew (fresh
  // run) or was replaced by the retry above (resumed run).
  const settled = result!

  // --- Mirror error: the durable transcript has a hole, so this session must never be resumed.
  // Checked on the result we actually process. A first attempt replaced by the resume retry above
  // is deliberately not checked: its session was already cleared and it already produced its own
  // `support_resume_failed` alert (NOT a mirror alert), so the actionable half is covered and a
  // second warning would be noise about a transcript nothing can resume any more.
  let sessionUsable = true
  if (settled.sawMirrorError) {
    await deps
      .alert('warning', 'support_session_mirror_error', { ticketId, runId, sessionId: settled.sessionId })
      .catch(() => {})
    await clearSessionId(deps.db, ticketId, knownSessionId)
    knownSessionId = null
    sessionUsable = false
  }

  // --- Failure path: no usable output. `aborted` is the budget/turn ceiling; `failed` covers a
  // throw, the watchdog, and a schema-invalid `structured_output` (which the harness reports as a
  // failed run rather than a throw).
  if (settled.status !== 'succeeded' || settled.output === null) {
    const code = settled.status === 'aborted' ? 'run_aborted' : 'run_failed'
    await recordFailureSafely(deps, ticketId, { code, detail: `agent run ${settled.status}` })
    throw new Error(`support agent run ${code} for ticket ${ticketId}`)
  }

  // --- Plain-code validator (spec §3): runs BEFORE any transition or submit, and its rejection is
  // an agent failure. `trackingUrl` is null because v1 stores none — `get_order` hands the agent a
  // tracking NUMBER only, so no off-domain link can legitimately appear in a draft.
  const validation = await validateSupportOutput(
    deps.db,
    { id: ticket.id, orderId: ticket.orderId, customerEmail: ticket.customerEmail },
    settled.output,
  )
  if (!validation.ok) {
    await recordFailureSafely(deps, ticketId, { code: validation.code, detail: validation.detail })
    throw new Error(`support agent output rejected (${validation.code}) for ticket ${ticketId}`)
  }

  const output = settled.output
  if (output.outcome === 'no_action') {
    // BLOCKER fix (Task 7): a redraft-resume that returns no_action would otherwise sit in `triaged`
    // forever — never re-selected (last_agent_run_at stays set below via the finish stamp, no new
    // inbound arrives on a resume), and not `awaiting_approval` so the orphan backstop can't catch
    // it either — silently swallowing the owner's correction. When THIS run consumed owner feedback,
    // upgrade to a paging escalate instead of the normal no_action path, guarded on the ticket still
    // being `triaged` (6A convention: 0 rows = the owner moved it, handled by the finish stamp below).
    const redraftFeedback = args.ctx.ticket.ownerRedraftFeedback
    if (redraftFeedback !== null && redraftFeedback.trim().length > 0) {
      const escalated = await deps.db
        .update(supportTickets)
        .set({
          status: 'escalated',
          escalationReason: 'redraft_unfulfilled',
          // CRITICAL-1: cleared so the poll's notifyPendingEscalations (the ONLY notifier) pages.
          escalationNotifiedAt: null,
          // A redraft resume that produced nothing actionable — presume the transcript exhausted.
          agentSessionId: null,
          // redraft-cycle clear (see support/redraft.ts) — keep beside escalationNotifiedAt.
          ...clearRedraftCycle(),
        })
        .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.status, 'triaged')))
        .returning({ id: supportTickets.id })

      // The no_action outcome's trace (the run DID happen and returned no_action), flagged as the
      // redraft-unfulfilled escalate so the audit trail explains why the ticket left `triaged`.
      await deps.db.insert(auditLog).values({
        actor: 'system',
        action: AGENT_NO_ACTION_ACTION,
        entityType: 'ticket',
        entityId: ticketId,
        detail: { runId, rationale: output.rationale, redraftUnfulfilled: true, escalated: escalated.length > 0 },
      })

      // Same authoritative-outcome finalization the shared block below runs — the spend row was
      // already written pre-run (step 4), so finalizing means stamping last_agent_finished_at (+ the
      // message-time watermark when this run had a snapshot) so the stuck gate never re-claims this
      // finished run. The session id is NOT re-set here (we just nulled it), which is exactly why
      // this path RETURNs rather than falling through to the shared block's guarded session write.
      await deps.db
        .update(supportTickets)
        .set({
          lastAgentFinishedAt: now(),
          ...(args.threadSnapshotAt !== null ? { lastAgentPromptedAt: args.threadSnapshotAt } : {}),
        })
        .where(eq(supportTickets.id, ticketId))
      return
    }

    await deps.db.insert(auditLog).values({
      actor: 'system',
      action: AGENT_NO_ACTION_ACTION,
      entityType: 'ticket',
      entityId: ticketId,
      detail: { runId, rationale: output.rationale },
    })

    // FR3: an inbound that reached Gmail BETWEEN this run's thread snapshot and now was never seen
    // by this no_action decision. `no_action` is the ONE authoritative outcome with no other net —
    // propose→staleness guard + conditional flip, escalate→page, failure→recordFailure all clear
    // the claim stamp or move the ticket, but no_action stamps `last_agent_finished_at` (> claim)
    // and stays `triaged`, so neither the new-inbound branch (last_inbound_at < claim, since the
    // message's internalDate can predate the wall-clock claim) nor the stuck branch (it FINISHED)
    // ever re-selects it — the customer is ghosted. Clear the claim stamp so the next select
    // re-claims it as new work, but ONLY when a newer inbound actually exists (guarded on
    // last_inbound_at > snapshot, re-read live at UPDATE time — an ordinary idle no_action must NOT
    // re-run forever). A null snapshot fails CLOSED to the epoch so any inbound counts as newer,
    // matching `submitProposeOutcome`'s own epoch fallback.
    await deps.db
      .update(supportTickets)
      .set({ lastAgentRunAt: null })
      .where(
        and(
          eq(supportTickets.id, ticketId),
          eq(supportTickets.status, 'triaged'),
          gt(supportTickets.lastInboundAt, args.threadSnapshotAt ?? new Date(0)),
        ),
      )
  } else if (output.outcome === 'escalate') {
    // Guarded, 6A convention: 0 rows = the owner moved the ticket, skip silently.
    // CRITICAL-1: `escalation_notified_at` cleared, and NOTHING here notifies.
    const escalated = await deps.db
      .update(supportTickets)
      .set({
        status: 'escalated',
        escalationReason: output.escalationReason.slice(0, 500),
        escalationNotifiedAt: null,
        // redraft-cycle clear (see support/redraft.ts) — keep beside escalationNotifiedAt.
        ...clearRedraftCycle(),
      })
      .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.status, 'triaged')))
      .returning({ id: supportTickets.id })
    if (escalated.length === 0) {
      await deps.db.insert(auditLog).values({
        actor: 'system',
        action: AGENT_ESCALATE_LOST_RACE_ACTION,
        entityType: 'ticket',
        entityId: ticketId,
        detail: { runId },
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
      // A ticket with no inbound message yet has no snapshot. Fail CLOSED with the epoch rather
      // than "now": every conceivable later inbound then reads as NEWER, so the apply executors'
      // staleness guard treats such a draft as stale instead of waving it through.
      threadSnapshotAt: (args.threadSnapshotAt ?? new Date(0)).toISOString(),
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

  if (sessionUsable && settled.sessionId !== null) {
    await deps.db
      .update(supportTickets)
      .set({ agentSessionId: settled.sessionId })
      .where(and(eq(supportTickets.id, ticketId), sessionIdIs(knownSessionId)))
  }
}

/**
 * `recordFailure`, wrapped so its OWN failure can never mask the real one. Every caller rethrows
 * the original error immediately after; if the bookkeeping transaction itself throws (the DB is
 * down — the usual reason the run failed in the first place), swallowing it here keeps that
 * original error intact and reports the bookkeeping loss as its own critical alert instead.
 *
 * The cost of that swallow is bounded: with no increment and no finish stamp, the ticket keeps its
 * claim stamp and is rescued by the 20-minute stuck gate, which then charges the failure.
 */
async function recordFailureSafely(
  deps: SupportAgentJobDeps,
  ticketId: string,
  failure: { code: string; detail: string },
): Promise<void> {
  try {
    await recordFailure(deps, ticketId, failure)
  } catch (bookkeepingErr) {
    await deps
      .alert('critical', 'support_failure_bookkeeping_failed', {
        ticketId,
        code: failure.code,
        reason: failure.detail,
        error: errorToDetail(bookkeepingErr),
      })
      .catch(() => {})
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
 * The `propose` outcome's pinned order (spec §3, as amended): load the order → guarded transition →
 * supersede → refund → reply.
 *
 * **Transition BEFORE submit** is what makes a future auto-mode flip a pure config change:
 * auto-approve enqueues the apply job instantly, and the apply's `awaiting_approval`-anchored
 * checks must already hold when it runs.
 *
 * **Refund BEFORE reply.** A crash between the two submits then leaves a refund with no reply — the
 * owner approves money and the customer merely never gets an email, which a human can finish by
 * hand. The other order leaves the opposite: a customer-facing promise with no money behind it.
 *
 * **A throw anywhere in here is caught by one of two nets, by design (no local rollback).** Before
 * the flip, the ticket is still `triaged` with `last_agent_finished_at` unstamped, so the claim's
 * 20-minute stuck gate re-claims it. After the flip, it sits in `awaiting_approval`, where the
 * poll's 15-minute orphan backstop escalates any such ticket that has no live support proposal.
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

  // Loaded BEFORE the flip so an unreachable order row fails while nothing has committed yet —
  // the ticket stays `triaged` and the stuck gate retries it, rather than stranding it in
  // `awaiting_approval` with half a proposal pair. (The validator's refund gate already proved
  // both `ticket.orderId` and this row exist, and `support_tickets.order_id` is an FK; this is the
  // belt on that brace, not an expected path.)
  let order: { shopifyOrderGid: string; number: string | null } | undefined
  if (output.refund) {
    ;[order] = await deps.db
      .select({ shopifyOrderGid: orders.shopifyOrderGid, number: orders.shopifyOrderNumber })
      .from(orders)
      .where(eq(orders.id, ticket.orderId!))
      .limit(1)
    if (!order) {
      throw new Error(`refund proposed for ticket ${ticketId} whose linked order ${ticket.orderId} is missing`)
    }
  }

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

  // The reply this run is about to submit replaces any pending reply, always. A pending REFUND is
  // only superseded when THIS run carries a refund of its own — a reply-only run is not replacing
  // the standing refund, and expiring it would silently break what the validator's promised-action
  // exemption leans on: a draft that says "your refund is on the way" is allowed to say so
  // precisely BECAUSE a live sibling refund proposal backs it. Expiring that sibling after the
  // screen passed would ship a promise with nothing behind it.
  const supersedeTypes: ('support_reply' | 'refund')[] = output.refund
    ? ['support_reply', 'refund']
    : ['support_reply']
  const superseded = await deps.db
    .update(proposals)
    .set({ status: 'expired' })
    .where(
      and(
        eq(proposals.ticketId, ticketId),
        inArray(proposals.type, supersedeTypes),
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

  if (output.refund) {
    const orderId = ticket.orderId!
    const { amountCents, reason, openCjDispute, cjDisputeReasonId } = output.refund

    await submitProposal(submitDeps, {
      type: 'refund',
      summary: `Refund ${formatCents(amountCents)} order #${order!.number ?? 'unknown'} — ${reason.slice(0, 60)}`,
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
      // The accumulation bound sums live refunds by `proposals.order_id` — an unset one makes this
      // refund invisible to the next run's cap check.
      orderId,
    })
  }

  await submitProposal(submitDeps, {
    type: 'support_reply',
    // FR6: bound the (attacker-controlled) subject HERE so `proposals.summary` is bounded at the
    // source — this summary rides into four best-effort apply notify bodies that don't run through
    // `capNotifyBody`, and an unbounded one could push a Telegram page past 4096 chars and drop it.
    summary: `Reply: ${(ticket.subject ?? '(no subject)').slice(0, SUBJECT_MAX_CHARS)}`,
    payload: { type: 'support_reply', ticketId, body: args.body, threadSnapshotAt },
    sourceWorkflow: 'support',
    agentRunId: runId,
    ticketId,
  })
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
          // redraft-cycle clear (see support/redraft.ts) — kept beside escalationNotifiedAt, inside
          // the same guard so it only fires on the actual transition out of `triaged`.
          ...(locked.status === 'triaged'
            ? { status: 'escalated', escalationReason: 'agent_failed', escalationNotifiedAt: null, ...clearRedraftCycle() }
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
      /** The value `last_agent_run_at` held BEFORE this claim's stamp (fix round 2) — same as
       * `ticket.lastAgentRunAt` above, surfaced explicitly here so the caller never has to reach
       * into `ticket` to find it. What step 4's global-cap-re-trip unwind restores the column to. */
      priorLastAgentRunAt: Date | null
      /** The EXACT value this claim just wrote to `last_agent_run_at` (fix round 2) — literally the
       * `now` this function was called with, not a fresh clock read. Step 4's unwind guards its
       * UPDATE on this exact value so it can never clobber a write that happened after this claim
       * committed (structurally impossible while the CAS holds this ticket claimed, but the guard
       * documents the intent and costs nothing). */
      stampedLastAgentRunAt: Date
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
          // redraft-cycle clear (see support/redraft.ts) — keep beside escalationNotifiedAt.
          ...clearRedraftCycle(),
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

    return {
      claimed: true,
      stuckClaim,
      agentFailureCount,
      ticket: locked,
      threadSnapshotAt: locked.lastInboundAt,
      priorLastAgentRunAt: locked.lastAgentRunAt,
      stampedLastAgentRunAt: now,
    }
  })
}

/**
 * Undoes step 3's claim stamp when step 4's LOCKED re-check finds the global cap tripped after all
 * (fix round 2 — a genuine race: step 2's pre-claim read is unlocked and can slip past a
 * concurrent capping worker). Guarded on the EXACT value the claim wrote, so this can only ever
 * touch the row it's meant to: if `last_agent_run_at` no longer holds `stampedValue` — the CAS
 * makes that structurally impossible while this ticket stays claimed, but the guard is cheap and
 * documents the intent regardless — this simply matches 0 rows and no-ops rather than clobbering
 * whatever is there. `status = 'triaged'` in the guard is the same defense-in-depth, not
 * load-bearing.
 *
 * Exported (test-only, mirroring `support-poll-gmail.ts`'s `resetSupportPollOnceFlags`): a genuine
 * interleaved race — a second worker's cap-tripping spend row landing strictly between step 2's
 * read and step 4's locked re-check — is impractical to construct deterministically in a test
 * without adding a real synchronization hook to production code purely for that purpose. Testing
 * this guard directly (correct value unwinds; wrong value is a no-op) is the pragmatic substitute.
 *
 * Returns the number of rows the UPDATE actually matched (0 or 1) — purely for that direct test.
 */
export async function unwindClaimStamp(
  db: Db,
  ticketId: string,
  stampedValue: Date,
  priorValue: Date | null,
): Promise<number> {
  const updated = await db
    .update(supportTickets)
    .set({ lastAgentRunAt: priorValue })
    .where(
      and(
        eq(supportTickets.id, ticketId),
        eq(supportTickets.status, 'triaged'),
        eq(supportTickets.lastAgentRunAt, stampedValue),
      ),
    )
    .returning({ id: supportTickets.id })
  return updated.length
}

/**
 * Assembles the run context. Messages come back ascending by `sent_at` (the order
 * `SupportRunContext` documents and `senderAuthNote` depends on), filtered to the prompt watermark
 * ONLY when resuming — a fresh run always gets the full thread, which is what makes the resume
 * fallback safe.
 */
async function buildContext(
  db: Db,
  ticket: LockedTicket,
  resumeSessionId: string | null,
  ownerGuidance: string,
): Promise<SupportRunContext> {
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
      ownerRedraftFeedback: ticket.ownerRedraftFeedback,
    },
    messages,
    priorProposals,
    resumeSessionId,
    isResume,
    ownerGuidance,
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
    // redraft-cycle clear (see support/redraft.ts) — keep beside escalationNotifiedAt.
    .set({ status: 'escalated', escalationReason: 'agent_run_cap', escalationNotifiedAt: null, ...clearRedraftCycle() })
    .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.status, 'triaged')))
}

/**
 * Per-ticket cap escalation (fix round 2): the audit row + `escalateRunCapped` call, shared by
 * BOTH step 2's fast (unlocked, common) path and step 4's locked re-check's rare race path —
 * identical handling either way, so this is the one place that does it.
 */
async function escalateTicketCapped(deps: SupportAgentJobDeps, ticketId: string, runsToday: number): Promise<void> {
  // Deliberately not retried on failure here (and not inside a transaction with the audit insert):
  // if the process dies between the two writes, the ticket is left `triaged` with the cap still
  // tripped, so the next selection cycle re-enqueues it, the claim re-claims it, and this exact
  // path re-fires. Self-healing, and cheaper than holding a lock across two more writes.
  await escalateRunCapped(deps, ticketId)
  await deps.db.insert(auditLog).values({
    actor: 'system',
    action: AGENT_RUN_TICKET_CAPPED_ACTION,
    entityType: 'ticket',
    entityId: ticketId,
    detail: { max: SUPPORT_AGENT_MAX_RUNS_PER_TICKET_PER_DAY, runsToday },
  })
}

/**
 * The once-per-UTC-day global-cap warning (fix round 2), as its own small locked transaction:
 * guarded so two tickets racing step 2's unlocked pre-check at (nearly) the same moment can't each
 * insert a guard row and page the owner twice — the SAME `pg_advisory_xact_lock` key step 4's
 * transaction uses, so the two can never run concurrently with each other either. The alert itself
 * fires OUTSIDE the lock (best-effort I/O must never hold it).
 *
 * Step 4's transaction has its OWN inline copy of this exact guard-row check (it's already holding
 * the lock by the time it needs it, so wrapping this function around a second `transaction()` call
 * there would just be a pointless nested transaction) — a ticket that races PAST this unlocked
 * pre-check and reaches step 4's re-check still needs the identical once-per-day dedup, which is
 * why that inline copy exists rather than this function being the only place it's written.
 */
async function warnGlobalCapped(deps: SupportAgentJobDeps, midnight: Date, runsToday: number): Promise<void> {
  const shouldAlert = await deps.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'support-agent-daily'}))`)
    const [existingWarning] = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, AGENT_RUN_CAPPED_ACTION), gte(auditLog.createdAt, midnight)))
      .limit(1)
    if (existingWarning) return false
    await tx.insert(auditLog).values({
      actor: 'system',
      action: AGENT_RUN_CAPPED_ACTION,
      detail: { max: SUPPORT_AGENT_MAX_RUNS_PER_DAY, runsToday },
    })
    return true
  })
  if (shouldAlert) {
    await deps
      .alert('warning', 'support_agent_run_capped', { max: SUPPORT_AGENT_MAX_RUNS_PER_DAY, runsToday })
      .catch(() => {})
  }
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
