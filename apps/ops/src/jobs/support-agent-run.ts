import type { SessionStore } from '@anthropic-ai/claude-agent-sdk'
import { agentRuns, auditLog, proposals, supportMessages, supportTickets, type createDb } from '@doge-buddy/db'
import type { SupplierAdapter } from '@doge-buddy/supplier'
import { and, asc, count, eq, gt, gte, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type { QueryFn } from '../agents/run-harness.ts'
import { SUPPORT_PROJECT_KEY } from '../agents/session-store.ts'
import { createSupportMcpServer } from '../agents/support-mcp-tools.ts'
import { SUPPORT_MODEL, runSupportAgent, type SupportRunContext } from '../agents/support-run.ts'
import type { SendOpts } from '../fulfillment/types.ts'
import type { NotifyOwner } from '../notify/notify.ts'
import type { Settings } from '../settings.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

export const SUPPORT_AGENT_QUEUE = 'support.agent-run'

/** Global spend ceiling (spec §1 step 3) — counted from `support.agent_run` audit rows. */
export const SUPPORT_AGENT_MAX_RUNS_PER_DAY = 50
/** Per-ticket ceiling (spec §1 step 2): one hostile sender ping-ponging a single ticket must not
 * be able to burn the global cap and black out the agent for every real customer. */
export const SUPPORT_AGENT_MAX_RUNS_PER_TICKET_PER_DAY = 3
/** A claim older than this with no prompt watermark past it is a run that never finished (e.g. a
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
/** Guards the once-per-UTC-day global cap warning (escalate.ts's cap-warning pattern). */
export const AGENT_RUN_CAPPED_ACTION = 'support.agent_run_capped'
/** Records the per-ticket cap escalation (one row per capped ticket per day). */
export const AGENT_RUN_TICKET_CAPPED_ACTION = 'support.agent_run_ticket_capped'

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
 * 3. Global daily cap: count + spend-row insert inside ONE advisory-locked transaction; at cap,
 *    exit WITHOUT stamping (the ticket stays selectable after UTC midnight).
 * 4. Guarded CAS claim — the real per-ticket mutex. A queued duplicate whose predicate fails on the
 *    locked row exits as a no-op (`support.agent_run_skipped`).
 * 5. Resume pre-flight (the store may not have the session) + context assembly.
 * 6. Insert the `agent_runs` row directly (NOT `claimDailyRun` — support runs many per day).
 * 7. Run the agent.
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

  // --- Step 2: load + per-ticket daily cap.
  const [ticket] = await deps.db.select().from(supportTickets).where(eq(supportTickets.id, ticketId)).limit(1)
  if (!ticket) return

  const midnight = utcMidnight(now())
  const [ticketRunRow] = await deps.db
    .select({ value: count() })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, AGENT_RUN_AUDIT_ACTION),
        eq(auditLog.entityId, ticketId),
        gte(auditLog.createdAt, midnight),
      ),
    )
  const runsForTicketToday = ticketRunRow?.value ?? 0
  if (runsForTicketToday >= SUPPORT_AGENT_MAX_RUNS_PER_TICKET_PER_DAY) {
    await escalate(deps, ticketId, 'agent_run_cap', { clearSession: false })
    await deps.db.insert(auditLog).values({
      actor: 'system',
      action: AGENT_RUN_TICKET_CAPPED_ACTION,
      entityType: 'ticket',
      entityId: ticketId,
      detail: { max: SUPPORT_AGENT_MAX_RUNS_PER_TICKET_PER_DAY, runsToday: runsForTicketToday },
    })
    return
  }

  // --- Step 3: global daily cap. Count and insert in ONE transaction under
  // `pg_advisory_xact_lock` (the `agents/lifecycle.ts` pattern): this queue has no single-caller
  // guarantee (unlike triage's poll), and a plain check-then-act would overshoot the cap whenever
  // two workers overlap — exactly what happens across a deploy.
  const capResult = await deps.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'support-agent-daily'}))`)
    const [row] = await tx
      .select({ value: count() })
      .from(auditLog)
      .where(and(eq(auditLog.action, AGENT_RUN_AUDIT_ACTION), gte(auditLog.createdAt, midnight)))
    const runsToday = row?.value ?? 0
    if (runsToday >= SUPPORT_AGENT_MAX_RUNS_PER_DAY) return { capped: true as const, runsToday }

    // The spend row goes in with the count that authorized it, inside the same lock — so a
    // concurrent claimer's count already includes this one.
    await tx.insert(auditLog).values({
      actor: 'system',
      action: AGENT_RUN_AUDIT_ACTION,
      entityType: 'ticket',
      entityId: ticketId,
      detail: { model: SUPPORT_MODEL },
    })
    return { capped: false as const, runsToday }
  })
  if (capResult.capped) {
    // Outside the transaction: the alert is best-effort I/O and must never hold the advisory lock.
    await warnGlobalCapped(deps, midnight, capResult.runsToday)
    return
  }

  // --- Step 4: guarded CAS claim (the per-ticket mutex).
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

  // A stuck re-claim that brings the count to the ceiling escalates INSTEAD of running: otherwise a
  // third hard-kill would strand the ticket at count 2, excluded from selection, with the run never
  // having happened. The transcript is presumed poisoned, so the session id goes too.
  if (claim.stuck && claim.agentFailureCount >= AGENT_FAILURE_ESCALATE_AT) {
    await escalate(deps, ticketId, 'agent_failed', { clearSession: true })
    return
  }

  // --- Step 5: resume pre-flight. The store simply not having the session (e.g. a dropped mirror
  // batch) is NOT a failure — clear the id, run fresh. The per-run prompt is standalone-sufficient.
  let resumeSessionId = claim.ticket.agentSessionId
  if (resumeSessionId !== null) {
    const entries = await deps.sessionStore.load({ projectKey: SUPPORT_PROJECT_KEY, sessionId: resumeSessionId })
    if (entries === null) {
      await deps.db.update(supportTickets).set({ agentSessionId: null }).where(eq(supportTickets.id, ticketId))
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

  // --- Step 7: run. The MCP server is created per run, pinned to this ticket.
  const runFn = deps.runFn ?? runSupportAgent
  await runFn(
    {
      db: deps.db,
      alert: deps.alert,
      sessionStore: deps.sessionStore,
      mcpServer: createSupportMcpServer({ db: deps.db, adapter: deps.adapter, ticketId }),
      queryFn: deps.queryFn,
    },
    { runId: run!.id, ctx },
  )

  // Task 12: outcome handling (transitions, proposal submission, watermark/session persistence,
  // failure accounting) hangs off the `HarnessResult` returned above.
}

type ClaimResult =
  | { claimed: false; reason: string }
  | {
      claimed: true
      stuck: boolean
      /** The count as it now stands in the row — already incremented when `stuck`. */
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
 * `last_agent_run_at` (stamped here, before the SDK call) is ONLY the loop/claim guard;
 * `last_agent_prompted_at` is the prompt/staleness watermark and advances only on an authoritative
 * result (Task 12). The two are deliberately distinct — a single column stamped at claim time would
 * make every resume prompt empty and every retry blind.
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
    // Stuck-run recovery: claimed, but the prompt watermark never caught up to that claim.
    const stuck =
      locked.lastAgentRunAt !== null &&
      locked.lastAgentRunAt < stuckBefore &&
      (locked.lastAgentPromptedAt === null || locked.lastAgentPromptedAt < locked.lastAgentRunAt)

    if (!neverRun && !newInbound && !stuck) return { claimed: false, reason: 'watermark' }

    const agentFailureCount = locked.agentFailureCount + (stuck ? 1 : 0)
    await tx
      .update(supportTickets)
      .set({ lastAgentRunAt: now, ...(stuck ? { agentFailureCount } : {}) })
      .where(eq(supportTickets.id, ticketId))

    return { claimed: true, stuck, agentFailureCount, ticket: locked, threadSnapshotAt: locked.lastInboundAt }
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
 * Guarded `triaged → escalated` (6A convention: 0 rows matched = the owner moved the ticket, skip
 * silently). CRITICAL-1: clears `escalation_notified_at` so a ticket that was escalated+notified
 * before, then resolved, then re-escalated here is still selectable by `notifyPendingEscalations` —
 * which is the ONLY notifier; nothing in this job pages the owner directly.
 */
async function escalate(
  deps: SupportAgentJobDeps,
  ticketId: string,
  reason: 'agent_run_cap' | 'agent_failed',
  opts: { clearSession: boolean },
): Promise<void> {
  await deps.db
    .update(supportTickets)
    .set({
      status: 'escalated',
      escalationReason: reason,
      escalationNotifiedAt: null,
      ...(opts.clearSession ? { agentSessionId: null } : {}),
    })
    .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.status, 'triaged')))
}

/** ONE global-cap warning per UTC day, guarded by that day's existing cap-warning audit row —
 * `escalate.ts`'s pattern, and safe under concurrency for the same reason the row is the guard. */
async function warnGlobalCapped(deps: SupportAgentJobDeps, midnight: Date, runsToday: number): Promise<void> {
  const [existing] = await deps.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.action, AGENT_RUN_CAPPED_ACTION), gte(auditLog.createdAt, midnight)))
    .limit(1)
  if (existing) return

  await deps.db.insert(auditLog).values({
    actor: 'system',
    action: AGENT_RUN_CAPPED_ACTION,
    detail: { max: SUPPORT_AGENT_MAX_RUNS_PER_DAY, runsToday },
  })
  await deps
    .alert('warning', 'support_agent_run_capped', { max: SUPPORT_AGENT_MAX_RUNS_PER_DAY, runsToday })
    .catch(() => {})
}

/** Worker callback for the `support.agent-run` queue — thin adapter, same shape as every other job
 * wrapper in this directory. No dead-lettering here: Task 12 owns failure accounting, and the
 * queue's `retryLimit: 1` plus the next selection cycle (the CAS serializes them) is the retry. */
export function supportAgentRunHandler(deps: SupportAgentJobDeps): PgBoss.WorkHandler<{ ticketId: string }> {
  return async (jobs) => {
    for (const job of jobs) {
      await executeSupportAgentRun(deps, job.data.ticketId)
    }
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
