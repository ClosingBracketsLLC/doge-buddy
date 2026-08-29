import {
  agentRuns, auditLog, createDb, products, productScores, proposals, settings as settingsTable,
} from '@doge-buddy/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REASON_MAX_CHARS, runWeeklyDeprecationDigest, SCORING_WEEKLY_QUEUE, scoringWeeklyHandler,
  type ScoringWeeklyDeps,
} from '../src/jobs/scoring-weekly-digest.ts'
import type { NotifyOwner, OwnerNotification } from '../src/notify/notify.ts'
import { submitProposal, type SubmitProposalDeps } from '../src/proposals/submit.ts'
import type { JudgeResult } from '../src/scoring/judge.ts'
import { createSettings, SETTINGS_DEFAULTS } from '../src/settings.ts'

/** `db.dialect` is present at runtime (node-postgres drizzle) but not on the public type. */
function renderSql(dbLike: unknown, q: unknown): string {
  return (dbLike as { dialect: { sqlToQuery(q: never): { sql: string } } }).dialect.sqlToQuery(q as never).sql
}

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

// A far-future score_date so the candidate join (`score_date = today`) matches ONLY this file's
// seeded products, and so the freshest global `score_date` is this file's rows — the shared DB tops
// out at 2026 dates, so 2030 is always the max → the freshness guard reads "current", never stale
// (except where a test deliberately seeds an older date).
const TODAY = '2030-01-07'
const TODAY_ISO = '2030-01-07T12:00:00.000Z'
const ADMIN = 'https://admin.test'
const now = (): Date => new Date(TODAY_ISO)

/** The scoring settings the digest reads — pinned to code defaults before each test so a test that
 *  flips one (mode, judge_enabled, a cooldown) never bleeds into the next. */
const KEYS = [
  'killswitch.global', 'workflow.scoring.enabled', 'scoring.judge_enabled', 'workflow.deprecation.mode',
  'scoring.deprecate_after_days', 'scoring.min_units_28d', 'scoring.reject_cooldown_days',
  'scoring.fail_cooldown_days', 'scoring.max_fail_attempts',
] as const

const okJudge = (): JudgeResult => ({ sparedProductIds: new Set(), reasons: new Map(), failed: false })

describe('scoring.weekly-digest', () => {
  const { db, pool } = createDb(url)
  const settingsStore = createSettings(db)
  const enqueue = vi.fn(async () => {})
  const createdProductIds: string[] = []
  let suiteStart: Date

  beforeAll(() => {
    suiteStart = new Date()
  })

  async function resetSettings(): Promise<void> {
    for (const k of KEYS) await settingsStore.set(k, SETTINGS_DEFAULTS[k] as never)
  }

  beforeEach(resetSettings)

  afterEach(async () => {
    await resetSettings()
    if (createdProductIds.length) {
      const props = await db
        .select({ id: proposals.id })
        .from(proposals)
        .where(inArray(proposals.productId, createdProductIds))
      const propIds = props.map((p) => p.id)
      const entityIds = [...createdProductIds, ...propIds]
      await db.delete(auditLog).where(inArray(auditLog.entityId, entityIds))
      await db.delete(proposals).where(inArray(proposals.productId, createdProductIds))
      await db.delete(productScores).where(inArray(productScores.productId, createdProductIds))
      await db.delete(products).where(inArray(products.id, createdProductIds))
      createdProductIds.length = 0
    }
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    // The digest inserts one `agent_runs` row per judge invocation (workflow 'scoring', triggerRef
    // null, never finished by the stubbed judge). Delete only this file's window's rows.
    await db
      .delete(agentRuns)
      .where(
        and(
          eq(agentRuns.workflow, 'scoring'),
          sql`${agentRuns.triggerRef} IS NULL`,
          sql`${agentRuns.finishedAt} IS NULL`,
          sql`${agentRuns.startedAt} >= ${suiteStart.toISOString()}`,
        ),
      )
    await db.delete(settingsTable).where(inArray(settingsTable.key, KEYS as unknown as string[]))
    await pool.end()
  })

  async function seedProduct(opts: { title?: string; category?: string | null } = {}): Promise<string> {
    const [row] = await db
      .insert(products)
      .values({
        shopifyProductGid: `gid://shopify/Product/${crypto.randomUUID()}`,
        handle: `h-${crypto.randomUUID()}`,
        title: opts.title ?? 'Weekly Digest Test Product',
        categoryTag: opts.category ?? 'Toys',
        status: 'active',
      })
      .returning({ id: products.id })
    createdProductIds.push(row!.id)
    return row!.id
  }

  async function seedScore(
    productId: string,
    opts: { verdict?: 'keep' | 'watch' | 'deprecate'; unitsSold28d?: number; refundCount28d?: number; ticketCount28d?: number; daysLive?: number; scoreDate?: string } = {},
  ): Promise<void> {
    await db.insert(productScores).values({
      productId,
      scoreDate: opts.scoreDate ?? TODAY,
      unitsSold28d: opts.unitsSold28d ?? 0,
      refundCount28d: opts.refundCount28d ?? 0,
      ticketCount28d: opts.ticketCount28d ?? 0,
      daysLive: opts.daysLive ?? 40,
      verdict: opts.verdict ?? 'deprecate',
    })
  }

  async function seedProposal(
    productId: string,
    opts: { status: 'pending' | 'approved' | 'applying' | 'applied' | 'rejected' | 'failed'; decidedAt?: Date; updatedAt?: Date; reasoning?: string },
  ): Promise<string> {
    const [row] = await db
      .insert(proposals)
      .values({
        type: 'deprecate_product',
        status: opts.status,
        summary: 'Deprecate: seeded',
        payload: {
          type: 'deprecate_product',
          productId,
          evidence: { unitsSold28d: 0, refundCount28d: 0, ticketCount28d: 0, daysLive: 40, reasoning: opts.reasoning ?? 'seed' },
        },
        sourceWorkflow: 'scoring',
        productId,
        ...(opts.decidedAt ? { decidedAt: opts.decidedAt } : {}),
        ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
      })
      .returning({ id: proposals.id })
    return row!.id
  }

  async function seedJudgeSpared(productId: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await db.insert(auditLog).values({
        actor: 'system', action: 'scoring.judge_spared', entityType: 'product', entityId: productId, detail: { reason: 'prior' },
      })
    }
  }

  function makeDeps(over: {
    db?: ScoringWeeklyDeps['db']
    judgeImpl?: (d: unknown, c: unknown) => Promise<JudgeResult>
    anthropicConfigured?: boolean
  } = {}) {
    const notify = vi.fn(async (_n: OwnerNotification) => true)
    const alert = vi.fn(async (_s: 'info' | 'warning' | 'critical', _k: string, _d: Record<string, unknown>) => {})
    const judge = vi.fn(over.judgeImpl ?? (async () => okJudge()))
    const submit = vi.fn(
      (d: Parameters<typeof submitProposal>[0], i: Parameters<typeof submitProposal>[1], o?: Parameters<typeof submitProposal>[2]) =>
        submitProposal(d, i, o),
    )
    const dbUse = over.db ?? db
    const notifyDep = notify as unknown as NotifyOwner
    const alertDep = alert as unknown as ScoringWeeklyDeps['alert']
    const submitDeps: SubmitProposalDeps = { db: dbUse, settings: settingsStore, notify: notifyDep, enqueue, alert: alertDep, adminBaseUrl: ADMIN }
    const deps: ScoringWeeklyDeps = {
      db: dbUse, settings: settingsStore, alert: alertDep, notify: notifyDep, adminBaseUrl: ADMIN,
      submit: submit as unknown as ScoringWeeklyDeps['submit'], submitDeps,
      judge: judge as unknown as ScoringWeeklyDeps['judge'], anthropicConfigured: over.anthropicConfigured ?? false, now,
    }
    return { deps, notify, alert, judge, submit }
  }

  async function auditCount(action: string, entityId: string): Promise<number> {
    const rows = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)))
    return rows.length
  }

  async function proposalsFor(productId: string) {
    return db.select().from(proposals).where(eq(proposals.productId, productId))
  }

  it('exports the queue name and reason cap', () => {
    expect(SCORING_WEEKLY_QUEUE).toBe('scoring.weekly-digest')
    expect(REASON_MAX_CHARS).toBe(200)
  })

  it('killswitch / scoring disabled → hard skip, no transaction, no notify', async () => {
    const productId = await seedProduct()
    await seedScore(productId)
    await settingsStore.set('killswitch.global', true)

    const { deps, notify, submit } = makeDeps()
    const txSpy = vi.spyOn(db, 'transaction')
    const result = await runWeeklyDeprecationDigest(deps)

    expect(result).toEqual({ created: 0, notified: 0, spared: 0 })
    expect(txSpy).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('pre-revenue (no real paid order) → creates nothing, no message', async () => {
    class Rollback extends Error {}
    let observed: { result: { created: number; notified: number; spared: number }; notifyCalls: number; submitCalls: number } | undefined

    await expect(
      db.transaction(async (t) => {
        // Within this rolled-back tx: remove the store's revenue and any stray pendings so the
        // digest sees a genuinely pre-revenue store.
        await t.execute(sql`UPDATE orders SET paid_at = NULL WHERE is_test = false AND paid_at IS NOT NULL`)
        await t.execute(sql`DELETE FROM proposals WHERE type = 'deprecate_product' AND status = 'pending'`)
        // A deprecate-scored active product that WOULD be proposed if revenue existed.
        const [p] = await t
          .insert(products)
          .values({ shopifyProductGid: `gid://shopify/Product/${crypto.randomUUID()}`, handle: `h-${crypto.randomUUID()}`, title: 'pre-rev', status: 'active' })
          .returning({ id: products.id })
        await t.insert(productScores).values({ productId: p!.id, scoreDate: TODAY, daysLive: 40, unitsSold28d: 0, verdict: 'deprecate' })

        const { deps, notify, submit } = makeDeps({ db: t as unknown as ScoringWeeklyDeps['db'] })
        const result = await runWeeklyDeprecationDigest(deps)
        observed = { result, notifyCalls: notify.mock.calls.length, submitCalls: (submit as ReturnType<typeof vi.fn>).mock.calls.length }
        throw new Rollback()
      }),
    ).rejects.toBeInstanceOf(Rollback)

    expect(observed!.result).toEqual({ created: 0, notified: 0, spared: 0 })
    expect(observed!.notifyCalls).toBe(0)
    expect(observed!.submitCalls).toBe(0)
  })

  it('real order + a deprecate-scored product → creates 1 suppressNotify proposal, sends 1 digest, writes 1 notified audit', async () => {
    const productId = await seedProduct({ title: 'Doomed Chew Toy' })
    await seedScore(productId, { daysLive: 40, unitsSold28d: 0 })

    const { deps, notify, submit } = makeDeps()
    const result = await runWeeklyDeprecationDigest(deps)

    expect(result).toEqual({ created: 1, notified: 1, spared: 0 })
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'deprecate_product', productId }), { suppressNotify: true })

    const [prop] = await proposalsFor(productId)
    expect(prop!.status).toBe('pending')
    expect(prop!.actionTokenHash).toBeNull() // suppressNotify mints no token
    expect((prop!.payload as { evidence: { reasoning: string } }).evidence.reasoning).toContain('low sales')

    expect(notify).toHaveBeenCalledTimes(1)
    const body = notify.mock.calls[0]![0].body
    expect(body).toContain('Doomed Chew Toy')
    expect(body).toContain(`${ADMIN}/admin/proposals/${prop!.id}`)
    expect(await auditCount('scoring.deprecation_notified', prop!.id)).toBe(1)
  })

  it('failed send → proposal stays pending & UN-notified → a second run re-lists it (recovery)', async () => {
    const productId = await seedProduct({ title: 'Recovery Toy' })
    await seedScore(productId, { daysLive: 40, unitsSold28d: 0 })

    const { deps, notify } = makeDeps()
    notify.mockResolvedValueOnce(false).mockResolvedValue(true)

    const run1 = await runWeeklyDeprecationDigest(deps)
    expect(run1).toEqual({ created: 1, notified: 0, spared: 0 })
    const [prop] = await proposalsFor(productId)
    expect(prop!.status).toBe('pending')
    expect(await auditCount('scoring.deprecation_notified', prop!.id)).toBe(0) // NOT stamped on a false send

    const run2 = await runWeeklyDeprecationDigest(deps)
    expect(run2.created).toBe(0) // deduped against the now-live proposal
    expect(run2.notified).toBe(1) // re-listed and, this time, stamped
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[1]![0].body).toContain(`${ADMIN}/admin/proposals/${prop!.id}`)
    expect(await auditCount('scoring.deprecation_notified', prop!.id)).toBe(1)
  })

  it('dedup: a product with a LIVE (approved) deprecate proposal is not re-proposed', async () => {
    const productId = await seedProduct()
    await seedScore(productId)
    await seedProposal(productId, { status: 'approved' })

    const { deps, notify, submit } = makeDeps()
    const result = await runWeeklyDeprecationDigest(deps)

    expect(result.created).toBe(0)
    expect(submit).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled() // an approved proposal is not a pending un-notified one
    expect(await proposalsFor(productId)).toHaveLength(1) // only the seeded one
  })

  it('cooldowns: recent reject / recent fail suppress; an out-of-window reject is proposed', async () => {
    const inReject = await seedProduct({ title: 'reject-cooldown' })
    await seedScore(inReject)
    await seedProposal(inReject, { status: 'rejected', decidedAt: new Date(new Date(TODAY_ISO).getTime() - 5 * 86_400_000) })

    const inFail = await seedProduct({ title: 'fail-cooldown' })
    await seedScore(inFail)
    await seedProposal(inFail, { status: 'failed', updatedAt: new Date(new Date(TODAY_ISO).getTime() - 3 * 86_400_000) })

    const outReject = await seedProduct({ title: 'reject-expired' })
    await seedScore(outReject)
    await seedProposal(outReject, { status: 'rejected', decidedAt: new Date(new Date(TODAY_ISO).getTime() - 40 * 86_400_000) })

    const { deps } = makeDeps()
    const result = await runWeeklyDeprecationDigest(deps)

    // Only the out-of-cooldown reject gets a fresh proposal.
    expect(result.created).toBe(1)
    expect((await proposalsFor(inReject)).filter((p) => p.status === 'pending')).toHaveLength(0)
    expect((await proposalsFor(inFail)).filter((p) => p.status === 'pending')).toHaveLength(0)
    expect((await proposalsFor(outReject)).filter((p) => p.status === 'pending')).toHaveLength(1)
  })

  it('stuck: a product at max_fail_attempts fires ONE scoring_deprecation_stuck critical across two runs, no proposal', async () => {
    const productId = await seedProduct()
    await seedScore(productId)
    const old = new Date(new Date(TODAY_ISO).getTime() - 90 * 86_400_000)
    for (let i = 0; i < 3; i++) await seedProposal(productId, { status: 'failed', updatedAt: old })

    const d1 = makeDeps()
    const r1 = await runWeeklyDeprecationDigest(d1.deps)
    expect(r1.created).toBe(0)
    expect(d1.submit).not.toHaveBeenCalled()
    expect(d1.alert).toHaveBeenCalledWith('critical', 'scoring_deprecation_stuck', expect.objectContaining({ productId }))

    const d2 = makeDeps()
    await runWeeklyDeprecationDigest(d2.deps)
    // Second run: guarded by the existing stuck audit row → silent.
    expect(d2.alert).not.toHaveBeenCalledWith('critical', 'scoring_deprecation_stuck', expect.anything())
    expect(await auditCount('scoring.deprecation_stuck', productId)).toBe(1)
  })

  it('freshness: no score for today → scoring_stale warning, skip creation (still runs notify)', async () => {
    const productId = await seedProduct()
    await seedScore(productId, { scoreDate: '2030-01-06' }) // yesterday, deprecate — but not today

    const { deps, submit, alert } = makeDeps()
    const result = await runWeeklyDeprecationDigest(deps)

    expect(result.created).toBe(0)
    expect(submit).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalledWith('warning', 'scoring_stale', expect.objectContaining({ today: TODAY }))
  })

  it('judge honored spare (bound not hit) → no proposal + judge_spared audit + digest footer', async () => {
    const spare = await seedProduct({ title: 'Spare Me' })
    await seedScore(spare)
    const propose = await seedProduct({ title: 'Deprecate Me' })
    await seedScore(propose)

    const { deps, notify, submit } = makeDeps({
      anthropicConfigured: true,
      judgeImpl: async () => ({ sparedProductIds: new Set([spare]), reasons: new Map([[spare, 'slow ramp, promising']]), failed: false }),
    })

    const result = await runWeeklyDeprecationDigest(deps)

    expect(result).toEqual({ created: 1, notified: 1, spared: 1 })
    expect((await proposalsFor(spare)).filter((p) => p.status === 'pending')).toHaveLength(0)
    expect((await proposalsFor(propose)).filter((p) => p.status === 'pending')).toHaveLength(1)
    expect(await auditCount('scoring.judge_spared', spare)).toBe(1)
    // Only the non-spared product was submitted.
    expect(submit).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0].body).toContain('judge spared 1: Spare Me')
  })

  it('judge spare AT the bound (3 prior consecutive spares) → proposed anyway with the manual-decision note', async () => {
    const productId = await seedProduct({ title: 'Bound Hit' })
    await seedScore(productId)
    await seedJudgeSpared(productId, 3) // already spared 3 weeks running

    const { deps } = makeDeps({
      anthropicConfigured: true,
      judgeImpl: async () => ({ sparedProductIds: new Set([productId]), reasons: new Map([[productId, 'still hopeful']]), failed: false }),
    })

    const result = await runWeeklyDeprecationDigest(deps)

    expect(result.created).toBe(1)
    expect(result.spared).toBe(0) // bound override is NOT an honored spare
    const [prop] = (await proposalsFor(productId)).filter((p) => p.status === 'pending')
    expect((prop!.payload as { evidence: { reasoning: string } }).evidence.reasoning).toContain('deciding manually')
    expect(await auditCount('scoring.judge_spared', productId)).toBe(3) // no NEW spare row written
  })

  it('judge failure in MANUAL mode → fail-open, proposes anyway; no defer alert', async () => {
    const productId = await seedProduct()
    await seedScore(productId)
    await settingsStore.set('workflow.deprecation.mode', 'manual')

    const { deps, alert } = makeDeps({
      anthropicConfigured: true,
      judgeImpl: async () => ({ sparedProductIds: new Set<string>(), reasons: new Map<string, string>(), failed: true }),
    })

    const result = await runWeeklyDeprecationDigest(deps)

    expect(result.created).toBe(1)
    expect(alert).not.toHaveBeenCalledWith('warning', 'scoring_judge_deferred', expect.anything())
  })

  it('judge failure in AUTO mode → defer, creates nothing, fires scoring_judge_deferred', async () => {
    const productId = await seedProduct()
    await seedScore(productId)
    await settingsStore.set('workflow.deprecation.mode', 'auto')

    const { deps, alert, submit } = makeDeps({
      anthropicConfigured: true,
      judgeImpl: async () => ({ sparedProductIds: new Set<string>(), reasons: new Map<string, string>(), failed: true }),
    })

    const result = await runWeeklyDeprecationDigest(deps)

    expect(result.created).toBe(0)
    expect(submit).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalledWith('warning', 'scoring_judge_deferred', expect.objectContaining({ candidateCount: 1 }))
  })

  it('per-line reason is truncated to REASON_MAX_CHARS in the digest body', async () => {
    const productId = await seedProduct({ title: 'Long Reason' })
    const longReason = 'R'.repeat(300)
    await seedProposal(productId, { status: 'pending', reasoning: longReason })
    await seedScore(productId) // today score so freshness passes (creation deduped by the live proposal)

    const { deps, notify } = makeDeps()
    await runWeeklyDeprecationDigest(deps)

    expect(notify).toHaveBeenCalledTimes(1)
    const body = notify.mock.calls[0]![0].body
    expect(body).toContain('R'.repeat(REASON_MAX_CHARS))
    expect(body).not.toContain('R'.repeat(REASON_MAX_CHARS + 1))
  })

  it('advisory lock: the body runs inside a transaction that acquires pg_advisory_xact_lock(scoring-digest)', async () => {
    const executed: string[] = []
    let txEntered = false
    const realTransaction = db.transaction.bind(db)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(db, 'transaction').mockImplementation((async (cb: (tx: any) => Promise<any>, ...rest: any[]) =>
      realTransaction(async (tx) => {
        txEntered = true
        const origExec = (tx.execute as (q: unknown) => Promise<unknown>).bind(tx)
        ;(tx as { execute: (q: unknown) => Promise<unknown> }).execute = (q: unknown) => {
          try { executed.push(renderSql(db, q)) } catch { /* non-sql arg */ }
          return origExec(q)
        }
        return cb(tx)
      }, ...rest)) as unknown as typeof db.transaction)

    const { deps } = makeDeps()
    await runWeeklyDeprecationDigest(deps)

    expect(txEntered).toBe(true)
    expect(executed.some((s) => s.includes('pg_advisory_xact_lock') && s.includes('scoring-digest'))).toBe(true)
  })

  it('handler swallows a thrown body and fires a critical scoring_weekly_failed alert', async () => {
    const alert = vi.fn(async () => {})
    const brokenDb = {
      transaction: async () => {
        throw new Error('boom')
      },
    } as unknown as ScoringWeeklyDeps['db']
    // settings still real so the gates pass and the body (transaction) is reached.
    const submitDeps: SubmitProposalDeps = { db: brokenDb, settings: settingsStore, notify: vi.fn(async () => true), enqueue, alert, adminBaseUrl: ADMIN }
    const deps: ScoringWeeklyDeps = {
      db: brokenDb, settings: settingsStore, alert, notify: vi.fn(async () => true), adminBaseUrl: ADMIN,
      submit: submitProposal, submitDeps, judge: vi.fn(async () => okJudge()) as unknown as ScoringWeeklyDeps['judge'],
      anthropicConfigured: false, now,
    }

    const handler = scoringWeeklyHandler(deps)
    await expect(handler([])).resolves.toBeUndefined()
    expect(alert).toHaveBeenCalledWith('critical', 'scoring_weekly_failed', { error: 'boom' })
  })
})
