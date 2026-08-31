import { gmailSyncState, type createDb } from '@doge-buddy/db'
import type { GmailClient } from '@doge-buddy/gmail'
import { sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type { SendOpts } from '../fulfillment/types.ts'
import type { NotifyOwner } from '../notify/notify.ts'
import type { Settings } from '../settings.ts'
import { selectAndEnqueueAgentRuns, type AgentSelectDeps } from '../support/agent-select.ts'
import { notifyPendingEscalations, type EscalateDeps } from '../support/escalate.ts'
import { runIngest, type Alert, type IngestDeps, type IngestResult } from '../support/ingest.ts'
import { runTriage, type TriageCall, type TriageDeps } from '../support/triage.ts'
import { sweepUnackedFormTickets } from './support-form-ack.ts'

type Db = ReturnType<typeof createDb>['db']
type SendFn = (name: string, data: object, opts?: SendOpts) => Promise<void>

export const SUPPORT_POLL_QUEUE = 'support.poll-gmail'

/** The single-row primary key of `gmail_sync_state` (same convention as ingest.ts's own copy). */
const SYNC_STATE_ID = 1

/**
 * `consecutive_failures` values at which each alert fires (spec §2.9). The counter only ever
 * moves by exactly 1 per poll, so an `===` check fires each alert exactly once per failing streak
 * — no `>=` needed, and no risk of re-firing every minute past the threshold.
 */
const WARNING_AT = 5
const CRITICAL_AT = 20

export interface SupportPollDeps {
  db: Db
  /** `null` when Gmail env is absent (spec §2 header) — the whole poll no-ops. */
  gmail: GmailClient | null
  supportAddress: string
  settings: Settings
  alert: Alert
  notify: NotifyOwner
  adminBaseUrl: string
  /** `null` when `ANTHROPIC_API_KEY` is absent — only the triage stage no-ops, ingest/escalate still run. */
  triageCall: TriageCall | null
  /** Threaded into the 4th (agent-select) stage's `AgentSelectDeps.enqueue` — the same producer
   * closure every other queue in this codebase builds over `queue.boss.send` (Task 13). */
  enqueue: SendFn
  now?: () => Date
  /**
   * Injectable stage seams — mirror `agents/sourcing-run.ts`'s `queryFn` idiom: default to the
   * real ingest/triage/escalate/agent-select pipeline stages, overridable so tests can drive each
   * stage's success/failure independently without a real GmailClient or Anthropic call.
   */
  ingestFn?: (deps: IngestDeps) => Promise<IngestResult>
  triageFn?: (deps: TriageDeps) => Promise<{ triaged: number; escalatedTicketIds: string[] }>
  escalateFn?: (deps: EscalateDeps) => Promise<{ notified: number }>
  agentSelect?: (deps: AgentSelectDeps) => Promise<{ enqueued: number; orphansEscalated: number; unbackedEscalated: number }>
  formAckSweep?: (deps: { db: Db; enqueue: SendFn; alert: Alert; now?: () => Date }) => Promise<{ enqueued: number }>
}

// Once-per-boot info alerts (spec §2 header) for the two configuration-absent skip paths below.
// Module-level rather than per-call state because the point is exactly one alert for the whole
// process lifetime — a Gmail-absent dev boot must not alert every single minute forever.
let gmailMissingAlerted = false
let triageMissingAlerted = false

/** Test-only: resets the once-per-boot alert flags between test cases. */
export function resetSupportPollOnceFlags(): void {
  gmailMissingAlerted = false
  triageMissingAlerted = false
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Upserts `gmail_sync_state`'s failure-visibility columns on a successful cycle: counter reset,
 * `last_success_at` stamped. Upsert (not a plain UPDATE) so this is correct even on the very first
 * poll ever, before ingest's own seed-on-null insert has necessarily run. */
async function recordSuccess(db: Db, now: () => Date): Promise<void> {
  await db
    .insert(gmailSyncState)
    .values({ id: SYNC_STATE_ID, consecutiveFailures: 0, lastSuccessAt: now() })
    .onConflictDoUpdate({ target: gmailSyncState.id, set: { consecutiveFailures: 0, lastSuccessAt: now() } })
}

/** Upserts an atomic +1 onto `consecutive_failures` and returns the new count. Same upsert
 * reasoning as `recordSuccess` — correct even if no row exists yet (a poll whose very first-ever
 * ingest attempt throws before it gets a chance to seed the row itself). */
async function recordFailure(db: Db): Promise<number> {
  const [row] = await db
    .insert(gmailSyncState)
    .values({ id: SYNC_STATE_ID, consecutiveFailures: 1 })
    .onConflictDoUpdate({
      target: gmailSyncState.id,
      set: { consecutiveFailures: sql`${gmailSyncState.consecutiveFailures} + 1` },
    })
    .returning({ consecutiveFailures: gmailSyncState.consecutiveFailures })
  return row?.consecutiveFailures ?? 1
}

/**
 * One `support.poll-gmail` cycle (spec §2 header + §2.9, Task 13's 4th stage; contact-form spec
 * §4's 5th stage): ingest → triage → escalate → agent-select → form-ack sweep, in strict sequence
 * with each stage isolated in its own try/catch.
 *
 * - Skip paths (Gmail absent, killswitch, `workflow.support.enabled` off) return WITHOUT touching
 *   `gmail_sync_state` at all — they are configuration/policy no-ops, not failures.
 * - An ingest failure skips BOTH the triage stage and the agent-select stage entirely — there is
 *   nothing sound to triage or select against a batch that may not have committed — but escalate
 *   still runs — a prior poll's already-escalated, not-yet-notified tickets must keep getting
 *   notified even while ingest is broken.
 * - A triage failure must NOT skip escalate or agent-select for the same reason: agent-select's own
 *   selection predicate only reads `support_tickets` columns triage already committed on a PRIOR
 *   cycle (this cycle's triage failure just means nothing NEW got triaged), and its orphan backstop
 *   is entirely independent of triage.
 * - agent-select runs AFTER escalate (not before) so a ticket the orphan backstop escalates this
 *   cycle is picked up by `notifyPendingEscalations` on the NEXT cycle, one minute later — never
 *   this same one (see `agent-select.ts`'s own doc comment).
 * - The form-ack sweep (5th) is NOT gated on `ingestFailed` — it needs no Gmail read, only a plain
 *   `support_tickets` scan, so it runs every cycle regardless of what ingest/triage/escalate/
 *   agent-select did.
 * - The FIRST stage error is what gets recorded/alerted; later stage errors are swallowed the same
 *   way (still counted as "this poll failed"), just not the one surfaced in alert detail.
 * - Never throws: `retryLimit: 0` on this queue means pg-boss would not retry a thrown job anyway
 *   — the cadence (next minute's scheduled run) IS the retry — so every path here ends in a normal
 *   return; failures are recorded on `gmail_sync_state` and alerted, never propagated.
 */
export async function executeSupportPoll(deps: SupportPollDeps): Promise<void> {
  const now = deps.now ?? (() => new Date())

  if (deps.gmail === null) {
    if (!gmailMissingAlerted) {
      gmailMissingAlerted = true
      await deps.alert('info', 'support_gmail_not_configured', {})
    }
    return
  }
  const gmail = deps.gmail

  if (await deps.settings.get('killswitch.global')) return
  if (!(await deps.settings.get('workflow.support.enabled'))) return

  const ingestFn = deps.ingestFn ?? runIngest
  const triageFn = deps.triageFn ?? runTriage
  const escalateFn = deps.escalateFn ?? notifyPendingEscalations
  const agentSelectFn = deps.agentSelect ?? selectAndEnqueueAgentRuns

  let firstError: unknown = null
  let ingestFailed = false

  try {
    await ingestFn({ db: deps.db, gmail, supportAddress: deps.supportAddress, alert: deps.alert, now })
  } catch (err) {
    firstError = err
    ingestFailed = true
  }

  if (!ingestFailed) {
    if (deps.triageCall) {
      const call = deps.triageCall
      try {
        await triageFn({ db: deps.db, call, gmail, alert: deps.alert, now })
      } catch (err) {
        firstError = firstError ?? err
      }
    } else if (!triageMissingAlerted) {
      triageMissingAlerted = true
      await deps.alert('info', 'support_triage_not_configured', {})
    }
  }

  try {
    await escalateFn({ db: deps.db, notify: deps.notify, alert: deps.alert, adminBaseUrl: deps.adminBaseUrl, now })
  } catch (err) {
    firstError = firstError ?? err
  }

  // 4th stage (Task 13): runs only when ingest didn't fail (same gate as triage, and for the same
  // reason — nothing sound to select against a batch that may not have committed), AFTER escalate
  // so any orphan it escalates this cycle waits for next cycle's notify (see this function's own
  // doc comment).
  if (!ingestFailed) {
    try {
      await agentSelectFn({ db: deps.db, enqueue: deps.enqueue, alert: deps.alert, now })
    } catch (err) {
      firstError = firstError ?? err
    }
  }

  // 5th stage (contact-form spec §4): re-enqueue acks for form tickets stuck on their placeholder.
  const sweepFn = deps.formAckSweep ?? sweepUnackedFormTickets
  try {
    await sweepFn({ db: deps.db, enqueue: deps.enqueue, alert: deps.alert, now })
  } catch (err) {
    firstError = firstError ?? err
  }

  if (firstError === null) {
    await recordSuccess(deps.db, now)
    return
  }

  const consecutiveFailures = await recordFailure(deps.db)
  const detail = { consecutiveFailures, error: errorMessage(firstError) }

  if (consecutiveFailures === WARNING_AT) {
    await deps.alert('warning', 'support_poll_degraded', detail)
  } else if (consecutiveFailures === CRITICAL_AT) {
    await deps.alert('critical', 'support_poll_down', detail)
    await deps.notify({
      title: 'Support poll failing',
      body: `${consecutiveFailures} consecutive failed Gmail polls. Latest error: ${errorMessage(firstError)}`,
      actions: [{ label: 'View admin', url: `${deps.adminBaseUrl}/admin` }],
    })
  }
  // Any other count: recorded on gmail_sync_state, no alert — swallow and let the next minute's
  // scheduled run retry.
}

/** Worker callback for the `support.poll-gmail` cron queue — same thin-adapter shape as every
 * other cron wrapper in this directory (job payload carries no data; all logic lives above). */
export function supportPollGmailHandler(deps: SupportPollDeps) {
  return async (jobs: PgBoss.Job<object>[]): Promise<void> => {
    for (const _job of jobs) {
      await executeSupportPoll(deps)
    }
  }
}
