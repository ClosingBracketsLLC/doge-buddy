import { agentRuns, auditLog, products, proposals, type createDb } from '@doge-buddy/db'
import { and, asc, eq, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type { NotifyOwner } from '../notify/notify.ts'
import { capNotifyBody, submitProposal, type SubmitProposalDeps } from '../proposals/submit.ts'
import {
  runDeprecationJudge, SCORING_MAX_CONSECUTIVE_SPARES, SCORING_MODEL, type JudgeCandidate,
} from '../scoring/judge.ts'
import type { Settings } from '../settings.ts'

type Db = ReturnType<typeof createDb>['db']
/** The `tx` handle inside `db.transaction(async (tx) => {...})` — same alias `proposals/transitions.ts`
 *  and `support/ingest.ts` declare. Every read in the digest body runs on it so the whole selection
 *  happens under the one snapshot the advisory lock is protecting. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

export const SCORING_WEEKLY_QUEUE = 'scoring.weekly-digest'
/** Per-line reason cap in the digest body — a stored `reasoning` string can be arbitrarily long
 *  (the judge writes it), and one runaway line must not blow the Telegram body past its limit. */
export const REASON_MAX_CHARS = 200
/** Per-field cap on the UNTRUSTED product title (supplier/sourcing data) BEFORE it enters either a
 *  body line or the spare footer — the submit.ts `SUBJECT_MAX_CHARS` precedent. Without it a long
 *  title pushes a listed proposal's deep link past the body cap (silently stamped-but-never-shown)
 *  or, in the never-truncated footer tail, past Telegram's 4096-char limit (permanent send failure). */
export const TITLE_MAX_CHARS = 80
/** Hard cap on how many proposals are RENDERED — and therefore STAMPED — per digest. Chosen so a
 *  full batch of worst-case lines (title 80 + reason 200 + a realistic deep link) fits comfortably
 *  under `BODY_MAX_CHARS`; the "…and M more" overflow carries the rest to the next run, and
 *  per-rendered stamping (never the overflow) drains that backlog safely. */
export const LISTED_CAP = 8

/** Hard backstop under Telegram's ~4096-char limit (mirror `support/escalate.ts`'s own
 *  `BODY_MAX_CHARS` and submit.ts's `NOTIFY_BODY_MAX_CHARS`). The body is BUILT to fit this rather
 *  than relying on a final head-slice, so a rendered line's deep link is never truncated off. */
const BODY_MAX_CHARS = 3500
/** Cap on the assembled spare footer (the never-truncated `capNotifyBody` tail) so it alone can
 *  never eat the whole budget. */
const FOOTER_MAX_CHARS = 400
/** Room reserved for a trailing "…and M more" line while packing, so appending it can't overflow. */
const OVERFLOW_LINE_RESERVE = 24

export interface ScoringWeeklyDeps {
  db: Db
  settings: Settings
  alert: Alert
  notify: NotifyOwner
  adminBaseUrl: string
  /** The proposal submitter (Task 4). Injected as `typeof submitProposal` so a test can spy it. */
  submit: typeof submitProposal
  /** The deps the injected `submit` is called with — assembled from index singletons. */
  submitDeps: SubmitProposalDeps
  /** The Sonnet spare-judge (Task 8). Injected so a test can stub it without an SDK call. */
  judge: typeof runDeprecationJudge
  /** Whether `ANTHROPIC_API_KEY` is configured — the judge is skipped when it isn't. */
  anthropicConfigured: boolean
  now?: () => Date
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

interface Candidate {
  productId: string
  title: string | null
  categoryTag: string | null
  unitsSold28d: number
  refundCount28d: number
  ticketCount28d: number
  daysLive: number
}

/** One row of the candidate SQL — the score fields plus the three exclusion signals evaluated in SQL. */
interface CandidateSqlRow {
  product_id: string
  title: string | null
  category_tag: string | null
  units_sold_28d: number
  refund_count_28d: number
  ticket_count_28d: number
  days_live: number
  has_live: boolean
  reject_cooldown: boolean
  fail_cooldown: boolean
  failed_ever: number
  [key: string]: unknown
}

/** Human-readable note for which deterministic rule (spec §2) put this product on the deprecate list,
 *  derived from the persisted score row + the same thresholds `deterministicVerdict` used. */
function deterministicReasoning(c: Candidate, deprecateAfterDays: number, minUnits28d: number): string {
  if (c.daysLive >= deprecateAfterDays && c.unitsSold28d <= minUnits28d) {
    return `low sales: ${c.unitsSold28d} unit(s) sold in 28d after ${c.daysLive}d live (>= ${deprecateAfterDays}d live, <= ${minUnits28d} units)`
  }
  return `high refund rate: ${c.refundCount28d} refund(s) in 28d`
}

/** Consecutive `scoring.judge_spared` audit rows for a product SINCE the last time it was actually
 *  proposed (the most recent `deprecate_product` proposal's `created_at`, or epoch if never) — the
 *  "since its last non-spare" streak the spare bound (spec §4 step 5) ratchets on. */
async function countConsecutiveSpares(tx: Tx, productId: string): Promise<number> {
  const res = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
    FROM audit_log a
    WHERE a.action = 'scoring.judge_spared'
      AND a.entity_id = ${productId}
      AND a.created_at > COALESCE(
        (SELECT max(pr.created_at) FROM proposals pr
          WHERE pr.type = 'deprecate_product' AND pr.product_id = ${productId}),
        'epoch'::timestamptz)`)
  return Number(res.rows[0]?.n ?? 0)
}

/**
 * `scoring.weekly-digest` (Phase 7, Task 9): the Monday deprecation digest. The WHOLE body runs
 * inside one `db.transaction` holding `pg_advisory_xact_lock(hashtext('scoring-digest'))` — the same
 * xact-scoped advisory-lock pattern `agents/lifecycle.ts` uses — so a cron fire racing a manual run
 * serialize instead of both selecting the same candidates and double-proposing/double-notifying.
 *
 * Every READ runs on `tx` (one consistent snapshot under the lock). The WRITES that must survive a
 * later throw — the created proposals, the judge's `agent_runs` row, the `judge_spared`/`stuck`
 * audit rows, and the notify stamps — run on the outer `deps.db` (committed immediately), so a crash
 * mid-run never rolls the week's proposals back: the re-runnable notify (step 7) re-lists any pending
 * deprecate proposal that lacks a `scoring.deprecation_notified` stamp on the next run.
 *
 * Step order (spec §4):
 *  1. killswitch / `!workflow.scoring.enabled` → hard skip (zeros, no notify).
 *  2. pre-revenue gate → skip candidate creation but STILL run the notify step (a proposal created
 *     before the store went empty must not be stranded).
 *  3. freshness guard → today's scores must exist; stale → `scoring_stale` warning + skip creation,
 *     still notify.
 *  4. candidates = active + today's `deprecate` verdict, minus live/cooldown; `>= max_fail_attempts`
 *     failed-ever → one guarded `scoring_deprecation_stuck` critical, skip.
 *  5. judge (if enabled + configured) with the spare bound + mode-aware failure.
 *  6. create one suppressNotify `deprecate_product` proposal per survivor.
 *  7. re-runnable notify + stamp-on-true.
 */
export async function runWeeklyDeprecationDigest(
  deps: ScoringWeeklyDeps,
): Promise<{ created: number; notified: number; spared: number }> {
  const { db, settings } = deps

  // Step 1 — gates (cheap, before the lock: a killed workflow shouldn't even queue behind the lock).
  if (await settings.get('killswitch.global')) return { created: 0, notified: 0, spared: 0 }
  if (!(await settings.get('workflow.scoring.enabled'))) return { created: 0, notified: 0, spared: 0 }

  const nowFn = deps.now ?? (() => new Date())
  const now = nowFn()

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('scoring-digest'))`)
    return executeDigest(deps, tx, now)
  })
}

async function executeDigest(
  deps: ScoringWeeklyDeps,
  tx: Tx,
  now: Date,
): Promise<{ created: number; notified: number; spared: number }> {
  const { db, settings, alert, adminBaseUrl } = deps
  const today = now.toISOString().slice(0, 10)

  let created = 0
  const honoredSpares: { productId: string; title: string | null }[] = []

  // Step 2 — pre-revenue gate. No real paid order ever → don't create candidates (in practice there
  // are none anyway); still fall through to the always-on notify step for any stranded pending.
  const revenue = await tx.execute(sql`SELECT 1 FROM orders WHERE is_test = false AND paid_at IS NOT NULL LIMIT 1`)
  const hasRevenue = revenue.rows.length > 0

  if (hasRevenue) {
    // Step 3 — freshness guard. The candidate scores must be TODAY's; a stale freshest (or none at
    // all) means the nightly didn't produce today's rows — alert and skip creation, still notify.
    const freshRes = await tx.execute<{ d: string | null }>(sql`SELECT max(score_date)::text AS d FROM product_scores`)
    const freshest = freshRes.rows[0]?.d ?? null

    if (freshest === null || freshest < today) {
      await alert('warning', 'scoring_stale', { freshest, today })
    } else {
      const survivors = await selectCandidates(deps, tx, today, now)
      const { finalSurvivors, spared } = await applyJudge(deps, tx, survivors)
      honoredSpares.push(...spared)

      const [deprecateAfterDays, minUnits28d] = await Promise.all([
        settings.get('scoring.deprecate_after_days'),
        settings.get('scoring.min_units_28d'),
      ])

      for (const s of finalSurvivors) {
        await deps.submit(
          deps.submitDeps,
          {
            type: 'deprecate_product',
            summary: `Deprecate: ${s.title ?? s.productId}`,
            sourceWorkflow: 'scoring',
            productId: s.productId,
            payload: {
              type: 'deprecate_product',
              productId: s.productId,
              evidence: {
                unitsSold28d: s.unitsSold28d,
                refundCount28d: s.refundCount28d,
                ticketCount28d: s.ticketCount28d,
                daysLive: s.daysLive,
                reasoning: s.reasoning ?? deterministicReasoning(s, deprecateAfterDays, minUnits28d),
              },
            },
          },
          { suppressNotify: true },
        )
        created++
      }
    }
  }

  // Step 7 — re-runnable notify (recovery-safe), ALWAYS run.
  const notified = await notifyPending(db, tx, adminBaseUrl, deps.notify, honoredSpares)

  // FW-E-lite: spec §4-step-5's auto-mode FYI ("N auto-deprecated / K spared") is NOT built. In auto
  // mode submitProposal creates 'approved' (not 'pending') proposals + enqueues apply, and notifyPending
  // only selects 'pending' — so the owner gets ZERO messages while products auto-deprecate. Building the
  // full FYI is a DEFERRED pre-auto-launch follow-up (auto is opt-in; default is manual). Until then,
  // emit a warning so the gap isn't silently claimed-as-working.
  if ((await settings.get('workflow.deprecation.mode')) === 'auto') {
    await alert('warning', 'scoring_auto_mode_fyi_unimplemented', { created, spared: honoredSpares.length })
  }

  return { created, notified, spared: honoredSpares.length }
}

/**
 * Step 4: active products whose TODAY score is `deprecate`, minus every product with a live
 * (`pending`/`approved`/`applying`/`applied`) deprecate proposal, minus cooldowns (a `rejected`
 * deprecate proposal within `reject_cooldown_days`, or a `failed` one within `fail_cooldown_days`).
 * A product with `>= max_fail_attempts` failed deprecate proposals EVER is not a normal exclude — it
 * fires one guarded `scoring_deprecation_stuck` critical (once, via a `scoring.deprecation_stuck`
 * audit row) and is skipped.
 */
async function selectCandidates(
  deps: ScoringWeeklyDeps,
  tx: Tx,
  today: string,
  now: Date,
): Promise<Candidate[]> {
  const { db, settings, alert } = deps
  const [rejectCooldownDays, failCooldownDays, maxFailAttempts] = await Promise.all([
    settings.get('scoring.reject_cooldown_days'),
    settings.get('scoring.fail_cooldown_days'),
    settings.get('scoring.max_fail_attempts'),
  ])
  const rejectCutoff = new Date(now.getTime() - rejectCooldownDays * 86_400 * 1000).toISOString()
  const failCutoff = new Date(now.getTime() - failCooldownDays * 86_400 * 1000).toISOString()

  const res = await tx.execute<CandidateSqlRow>(sql`
    WITH params AS (
      SELECT ${today}::date AS today,
             ${rejectCutoff}::timestamptz AS reject_cutoff,
             ${failCutoff}::timestamptz AS fail_cutoff
    )
    SELECT p.id AS product_id, p.title, p.category_tag,
      s.units_sold_28d, s.refund_count_28d, s.ticket_count_28d, s.days_live,
      EXISTS (SELECT 1 FROM proposals pr
              WHERE pr.type = 'deprecate_product' AND pr.product_id = p.id
                AND pr.status IN ('pending','approved','applying','applied')) AS has_live,
      EXISTS (SELECT 1 FROM proposals pr CROSS JOIN params
              WHERE pr.type = 'deprecate_product' AND pr.product_id = p.id
                AND pr.status = 'rejected'
                AND COALESCE(pr.decided_at, pr.updated_at) >= params.reject_cutoff) AS reject_cooldown,
      EXISTS (SELECT 1 FROM proposals pr CROSS JOIN params
              WHERE pr.type = 'deprecate_product' AND pr.product_id = p.id
                AND pr.status = 'failed' AND pr.updated_at >= params.fail_cutoff) AS fail_cooldown,
      (SELECT count(*) FROM proposals pr
        WHERE pr.type = 'deprecate_product' AND pr.product_id = p.id AND pr.status = 'failed')::int AS failed_ever
    FROM products p
    JOIN product_scores s ON s.product_id = p.id AND s.score_date = (SELECT today FROM params)
    WHERE p.status = 'active' AND s.verdict = 'deprecate'
    ORDER BY p.created_at ASC`)

  const survivors: Candidate[] = []
  for (const row of res.rows) {
    if (row.has_live) continue // dedup vs a live proposal

    if (row.failed_ever >= maxFailAttempts) {
      // Stuck: too many failed applies ever. One critical, guarded by a prior stuck audit row so it
      // fires ONCE (not every week), then skip the product entirely.
      const existing = await tx.execute(sql`
        SELECT 1 FROM audit_log a
        WHERE a.action = 'scoring.deprecation_stuck' AND a.entity_id = ${row.product_id} LIMIT 1`)
      if (existing.rows.length === 0) {
        await alert('critical', 'scoring_deprecation_stuck', { productId: row.product_id, failedEver: row.failed_ever })
        await db.insert(auditLog).values({
          actor: 'system', action: 'scoring.deprecation_stuck', entityType: 'product',
          entityId: row.product_id, detail: { failedEver: row.failed_ever },
        })
      }
      continue
    }

    if (row.reject_cooldown || row.fail_cooldown) continue // cooldown

    survivors.push({
      productId: row.product_id,
      title: row.title,
      categoryTag: row.category_tag,
      unitsSold28d: row.units_sold_28d,
      refundCount28d: row.refund_count_28d,
      ticketCount28d: row.ticket_count_28d,
      daysLive: row.days_live,
    })
  }
  return survivors
}

interface FinalCandidate extends Candidate {
  /** Set only for a spare-bound OVERRIDE — otherwise the deterministic reasoning is derived at create. */
  reasoning?: string
}

/**
 * Step 5: run the judge (when enabled + configured) and fold its result back in.
 *  - honored spare: below the bound → `judge_spared` audit + drop from the batch.
 *  - spare bound hit (>= `SCORING_MAX_CONSECUTIVE_SPARES` consecutive spares) → propose anyway with
 *    the "deciding manually" note.
 *  - judge failed + `manual` mode → fail-open (spare nobody, propose all survivors).
 *  - judge failed + `auto` mode → DEFER (propose nothing this run, `scoring_judge_deferred` warning).
 */
async function applyJudge(
  deps: ScoringWeeklyDeps,
  tx: Tx,
  survivors: Candidate[],
): Promise<{ finalSurvivors: FinalCandidate[]; spared: { productId: string; title: string | null }[] }> {
  const { db, settings, alert, anthropicConfigured } = deps
  const spared: { productId: string; title: string | null }[] = []

  const judgeEnabled = await settings.get('scoring.judge_enabled')
  if (survivors.length === 0 || !judgeEnabled || !anthropicConfigured) {
    return { finalSurvivors: survivors, spared }
  }

  // The judge takes a caller-supplied runId — insert the agent_runs row first (committed on the outer
  // db so the judge's own harness UPDATE on that same handle can find it), then pass its id.
  const [runRow] = await db
    .insert(agentRuns)
    .values({ workflow: 'scoring', model: SCORING_MODEL, status: 'running', triggerRef: null })
    .returning({ id: agentRuns.id })
  const runId = runRow!.id

  const judgeCandidates: JudgeCandidate[] = survivors.map((s) => ({
    productId: s.productId,
    title: s.title ?? '',
    category: s.categoryTag,
    unitsSold28d: s.unitsSold28d,
    refundCount28d: s.refundCount28d,
    daysLive: s.daysLive,
  }))

  const result = await deps.judge({ db, alert, runId }, judgeCandidates)

  if (result.failed) {
    const mode = await settings.get('workflow.deprecation.mode')
    if (mode === 'auto') {
      // Defer: create nothing this run rather than auto-deprecating a batch the judge never vetted.
      await alert('warning', 'scoring_judge_deferred', { runId, candidateCount: survivors.length })
      return { finalSurvivors: [], spared }
    }
    // manual: fail-open — proceed, sparing nobody.
    return { finalSurvivors: survivors, spared }
  }

  const finalSurvivors: FinalCandidate[] = []
  for (const s of survivors) {
    if (!result.sparedProductIds.has(s.productId)) {
      finalSurvivors.push(s)
      continue
    }
    const priorSpares = await countConsecutiveSpares(tx, s.productId)
    if (priorSpares >= SCORING_MAX_CONSECUTIVE_SPARES) {
      // Bound hit: the ratchet overrides the judge — propose anyway with the manual-decision note.
      finalSurvivors.push({ ...s, reasoning: `judge spared ${priorSpares} weeks running — deciding manually` })
      continue
    }
    // Honored spare: record it and drop from the batch (no proposal this week).
    await db.insert(auditLog).values({
      actor: 'system', action: 'scoring.judge_spared', entityType: 'product',
      entityId: s.productId, detail: { reason: result.reasons.get(s.productId) ?? '' },
    })
    spared.push({ productId: s.productId, title: s.title })
  }
  return { finalSurvivors, spared }
}

/** Collapse whitespace (a title is UNTRUSTED and may contain newlines) to one line, then cap with an
 *  ellipsis — the submit.ts `truncateField` precedent, applied to a title BEFORE it enters a body
 *  line or the footer so it can never push a mandatory deep link / the footer past the cap. */
function oneLineField(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * Step 7: the recovery-safe notify. Selects ALL `pending` `deprecate_product` proposals that lack a
 * `scoring.deprecation_notified` audit row, then PACKS lines into ONE Telegram body up to both
 * `LISTED_CAP` and the char budget — with every field pre-bounded (`TITLE_MAX_CHARS`,
 * `REASON_MAX_CHARS`) so a full batch always renders every line intact, deep link included. Only the
 * proposals whose line is actually RENDERED get stamped `scoring.deprecation_notified`; the "…and M
 * more" overflow (both over-cap and over-budget) stays unstamped so it re-surfaces next run. The
 * spare footer is pre-capped to `FOOTER_MAX_CHARS` so the never-truncated `capNotifyBody` tail can't
 * blow past Telegram's limit and wedge the send forever. A false send stamps nothing — the proposals
 * are already committed, so a failed send never loses the week's work.
 */
async function notifyPending(
  db: Db,
  tx: Tx,
  adminBaseUrl: string,
  notify: NotifyOwner,
  honoredSpares: { productId: string; title: string | null }[],
): Promise<number> {
  const pending = await tx
    .select({ id: proposals.id, payload: proposals.payload, title: products.title })
    .from(proposals)
    .leftJoin(products, eq(products.id, proposals.productId))
    .where(
      and(
        eq(proposals.type, 'deprecate_product'),
        eq(proposals.status, 'pending'),
        sql`NOT EXISTS (SELECT 1 FROM audit_log a
              WHERE a.action = 'scoring.deprecation_notified' AND a.entity_id = ${proposals.id}::text)`,
      ),
    )
    .orderBy(asc(proposals.createdAt))

  // Footer first (the never-truncated tail) so its length is known before packing lines below, and
  // hard-cap it — each spared title bounded, then the whole assembled footer bounded.
  const footerRaw = honoredSpares.length > 0
    ? `\n\njudge spared ${honoredSpares.length}: ${honoredSpares.map((s) => oneLineField(s.title ?? 'product', TITLE_MAX_CHARS)).join(', ')}`
    : ''
  const footer = footerRaw.length > FOOTER_MAX_CHARS ? `${footerRaw.slice(0, FOOTER_MAX_CHARS)}…` : footerRaw

  if (pending.length === 0) {
    // FW-D: nothing pending to LIST. A full-spare week (the judge spared every candidate, so no
    // proposal was created) still owes the owner the spared footer (spec §4) — send a spared-only
    // digest rather than falling silent. With no honored spares AND nothing pending there is genuinely
    // nothing to report. Nothing to stamp either way (no pending proposals exist), so return 0.
    if (honoredSpares.length === 0) return 0
    await notify({
      title: 'Weekly deprecation digest — 0 flagged',
      body: capNotifyBody('', footer),
      actions: [{ label: 'View proposals', url: `${adminBaseUrl}/admin/proposals` }],
    })
    return 0
  }

  const buildLine = (r: (typeof pending)[number]): string => {
    const ev = ((r.payload as { evidence?: Record<string, unknown> } | null)?.evidence ?? {}) as Record<string, unknown>
    const units = Number(ev.unitsSold28d ?? 0)
    const refunds = Number(ev.refundCount28d ?? 0)
    const days = Number(ev.daysLive ?? 0)
    // FW-C: show the raw refund COUNT, not a fabricated refunds/units rate. The verdict flags on
    // refunds/ORDERS, and render-proposal.ts deliberately refuses to show any refund rate because the
    // payload lacks the order count a rate needs — so the digest shows the same raw count the admin
    // detail does, rather than a misleading refunds/units percentage.
    const reason = oneLineField(String(ev.reasoning ?? ''), REASON_MAX_CHARS)
    const title = oneLineField(r.title ?? 'product', TITLE_MAX_CHARS)
    return `${title} · ${days}d live · ${units}u 28d · refunds: ${refunds} · ${reason} · ${adminBaseUrl}/admin/proposals/${r.id}`
  }

  // Pack lines up to LISTED_CAP AND the head budget, reserving room for a trailing overflow line.
  // Because every rendered line is committed only if the whole head still fits, a rendered line is
  // never head-sliced away — so "shown" and "stamped" stay exactly in sync.
  const headBudget = BODY_MAX_CHARS - footer.length - OVERFLOW_LINE_RESERVE
  const renderedLines: string[] = []
  const rendered: typeof pending = []
  for (const r of pending) {
    if (rendered.length >= LISTED_CAP) break
    const candidate = [...renderedLines, buildLine(r)].join('\n')
    if (candidate.length > headBudget) break
    renderedLines.push(buildLine(r))
    rendered.push(r)
  }

  const overflow = pending.length - rendered.length
  if (overflow > 0) renderedLines.push(`…and ${overflow} more`)

  const body = capNotifyBody(renderedLines.join('\n'), footer)

  const ok = await notify({
    title: `${pending.length} products flagged to deprecate`,
    body,
    actions: [{ label: 'View proposals', url: `${adminBaseUrl}/admin/proposals` }],
  })
  if (!ok) return 0

  // Stamp ONLY the proposals actually shown — never the overflow, so it re-lists next run.
  for (const r of rendered) {
    await db.insert(auditLog).values({
      actor: 'system', action: 'scoring.deprecation_notified', entityType: 'proposal', entityId: r.id, detail: {},
    })
  }
  return rendered.length
}

/**
 * Worker callback for the `scoring.weekly-digest` cron. Thin adapter (same shape as
 * `scoringNightlyHandler`): any throw that slips past the body's own nets becomes a loud `critical`
 * `scoring_weekly_failed` alert rather than only pg-boss dead-letter noise.
 */
export function scoringWeeklyHandler(deps: ScoringWeeklyDeps): PgBoss.WorkHandler<object> {
  return async (): Promise<void> => {
    try {
      await runWeeklyDeprecationDigest(deps)
    } catch (err) {
      await deps.alert('critical', 'scoring_weekly_failed', { error: errorMessage(err) }).catch(() => {})
    }
  }
}
