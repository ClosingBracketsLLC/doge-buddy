import {
  agentRuns, auditLog, createDb, orders, products, productScores, productVariants, proposals,
  settings as settingsTable, supplierVariantMappings,
} from '@doge-buddy/db'
import { and, eq, inArray, like, notInArray, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { executeScoringNightly } from '../src/jobs/scoring-nightly.ts'
import { runWeeklyDeprecationDigest, type ScoringWeeklyDeps } from '../src/jobs/scoring-weekly-digest.ts'
import type { NotifyOwner, OwnerNotification } from '../src/notify/notify.ts'
import { PROPOSAL_APPLIED_ACTION, type ApplyProposalDeps, type ProposalShopifyOps } from '../src/proposals/apply-shared.ts'
import { executeApplyProposal } from '../src/proposals/run-apply.ts'
import { submitProposal, type SubmitProposalDeps } from '../src/proposals/submit.ts'
import { applyProposalTransition } from '../src/proposals/transitions.ts'
import type { JudgeResult } from '../src/scoring/judge.ts'
import { createSettings, SETTINGS_DEFAULTS } from '../src/settings.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

// The whole E2E is anchored on a far-FUTURE score_date so this file's runs are deterministic
// against the shared dev DB's residue: 2099 is above every real (2026) and every other test file's
// (2030) score_date, so `max(score_date)` after this file writes is always THIS file's date (the
// digest's freshness guard reads "current", never stale), the candidate join (`score_date = today`)
// matches only products this file scored for that date, and cleanup is a single global
// `DELETE ... WHERE score_date = FUTURE` that no real process ever collides with.
const FUTURE_DATE = '2099-01-07'
const NOW_ISO = '2099-01-07T12:00:00.000Z'
const now = (): Date => new Date(NOW_ISO)
const ADMIN = 'https://admin.e2e.test'
/** Distinctive handle/title prefix so a crashed prior run's leftovers can be purged up front. */
const MARK = 'e2e-scoring-'

/** Scoring settings the nightly + digest read — pinned to code defaults so a stray earlier write
 *  (mode, judge_enabled, a cooldown) never bleeds into this file. */
const KEYS = [
  'killswitch.global', 'workflow.scoring.enabled', 'scoring.judge_enabled', 'workflow.deprecation.mode',
  'scoring.deprecate_after_days', 'scoring.min_units_28d', 'scoring.max_refund_rate_bps',
  'scoring.refund_rate_min_orders', 'scoring.reject_cooldown_days', 'scoring.fail_cooldown_days',
  'scoring.max_fail_attempts',
] as const

function daysAgo(days: number): Date {
  return new Date(new Date(NOW_ISO).getTime() - days * 86_400 * 1000)
}

/** The judge stub used throughout: spares nobody, so every deprecate candidate proceeds. */
const okJudge = (): JudgeResult => ({ sparedProductIds: new Set(), reasons: new Map(), failed: false })

describe('scoring E2E — nightly verdicts → weekly digest → recovery → approve+apply → idempotent re-run', () => {
  const { db, pool } = createDb(url)
  const settingsStore = createSettings(db)
  const enqueue = vi.fn(async () => {})
  let suiteStart: Date

  // Ids this file creates (for scoped cleanup).
  const productIds: string[] = []
  const proposalIds: string[] = []
  const orderIds: string[] = []

  async function resetSettings(): Promise<void> {
    for (const k of KEYS) await settingsStore.set(k, SETTINGS_DEFAULTS[k] as never)
  }

  /** Cascade-delete a set of products and everything this file hangs off them. */
  async function purgeProducts(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const variantRows = await db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(inArray(productVariants.productId, ids))
    const variantIds = variantRows.map((v) => v.id)
    const propRows = await db.select({ id: proposals.id }).from(proposals).where(inArray(proposals.productId, ids))
    const propIds = propRows.map((p) => p.id)
    await db.delete(auditLog).where(inArray(auditLog.entityId, [...ids, ...propIds]))
    await db.delete(proposals).where(inArray(proposals.productId, ids))
    await db.delete(productScores).where(inArray(productScores.productId, ids))
    if (variantIds.length > 0) {
      await db.delete(supplierVariantMappings).where(inArray(supplierVariantMappings.variantId, variantIds))
      await db.delete(productVariants).where(inArray(productVariants.id, variantIds))
    }
    await db.delete(products).where(inArray(products.id, ids))
  }

  beforeAll(async () => {
    suiteStart = new Date()
    await resetSettings()
    // Guard against a prior invocation of THIS file that crashed/was killed before its own cleanup:
    // clear any leftover future-dated scores (they'd corrupt the freshness/candidate isolation) and
    // any leftover marked products.
    await db.delete(productScores).where(eq(productScores.scoreDate, FUTURE_DATE))
    const leftovers = await db.select({ id: products.id }).from(products).where(like(products.handle, `${MARK}%`))
    await purgeProducts(leftovers.map((p) => p.id))
  })

  afterAll(async () => {
    // Every future-dated score row this file's nightly runs wrote — this file's two products PLUS
    // every other active product the real nightly scored for FUTURE_DATE (pruned mid-test, rewritten
    // by the second nightly). A single global delete on the unique anchor date reclaims them all.
    await db.delete(productScores).where(eq(productScores.scoreDate, FUTURE_DATE))
    await purgeProducts(productIds)
    if (orderIds.length > 0) await db.delete(orders).where(inArray(orders.id, orderIds))
    // The digest inserts one `agent_runs` row per judge invocation (workflow 'scoring', triggerRef
    // null, never finished by the stubbed judge) — delete only this file's window's rows.
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

  // ---------------------------------------------------------------------------
  // Seeding
  // ---------------------------------------------------------------------------

  /** A real, non-test, paid order with NO matching line items — opens the pre-revenue gate without
   *  touching any product's unit metrics (belt-and-suspenders; the shared DB already has hundreds). */
  async function seedRealPaidOrder(): Promise<string> {
    const [row] = await db
      .insert(orders)
      .values({
        shopifyOrderGid: `gid://shopify/Order/${MARK}${crypto.randomUUID()}`,
        isTest: false,
        paidAt: daysAgo(3),
        rawPayload: { line_items: [] },
      })
      .returning({ id: orders.id })
    orderIds.push(row!.id)
    return row!.id
  }

  async function seedProduct(opts: { title: string; createdAtDaysAgo: number }): Promise<string> {
    const [row] = await db
      .insert(products)
      .values({
        shopifyProductGid: `gid://shopify/Product/${MARK}${crypto.randomUUID()}`,
        handle: `${MARK}${crypto.randomUUID()}`,
        title: opts.title,
        categoryTag: 'Toys',
        status: 'active',
        createdAt: daysAgo(opts.createdAtDaysAgo),
      })
      .returning({ id: products.id })
    productIds.push(row!.id)
    return row!.id
  }

  /** Adds a variant with a NON-NULL gid (so the null-gid data-quality guard never forces 'watch')
   *  plus its CJ mapping. Returns the supplierProductId the deprecation apply will unsubscribe. */
  async function seedVariantMapping(productId: string): Promise<string> {
    const tag = crypto.randomUUID()
    const [variant] = await db
      .insert(productVariants)
      .values({
        productId,
        shopifyVariantGid: `gid://shopify/ProductVariant/${MARK}${tag}`,
        sku: `${MARK}${tag}`,
        priceCents: 2999,
        supplierCostCents: 1400,
      })
      .returning({ id: productVariants.id })
    const supplierProductId = `cjp-${MARK}${tag}`
    await db.insert(supplierVariantMappings).values({
      variantId: variant!.id,
      supplier: 'cj',
      supplierProductId,
      supplierVariantId: `cjv-${MARK}${tag}`,
    })
    return supplierProductId
  }

  // ---------------------------------------------------------------------------
  // Deps builders (reuse the construction styles from scoring-weekly-digest.test.ts,
  // apply-deprecate-product.test.ts and proposal-apply.test.ts)
  // ---------------------------------------------------------------------------

  function makeNightlyDeps() {
    const alert = vi.fn(async (_s: 'info' | 'warning' | 'critical', _k: string, _d: Record<string, unknown>) => {})
    return { deps: { db, settings: settingsStore, alert: alert as never, now }, alert }
  }

  function makeDigestDeps() {
    const notify = vi.fn(async (_n: OwnerNotification) => true)
    const alert = vi.fn(async (_s: 'info' | 'warning' | 'critical', _k: string, _d: Record<string, unknown>) => {})
    const judge = vi.fn(async () => okJudge())
    const submit = vi.fn(
      (d: Parameters<typeof submitProposal>[0], i: Parameters<typeof submitProposal>[1], o?: Parameters<typeof submitProposal>[2]) =>
        submitProposal(d, i, o),
    )
    const notifyDep = notify as unknown as NotifyOwner
    const alertDep = alert as unknown as ScoringWeeklyDeps['alert']
    const submitDeps: SubmitProposalDeps = { db, settings: settingsStore, notify: notifyDep, enqueue, alert: alertDep, adminBaseUrl: ADMIN }
    const deps: ScoringWeeklyDeps = {
      db, settings: settingsStore, alert: alertDep, notify: notifyDep, adminBaseUrl: ADMIN,
      submit: submit as unknown as ScoringWeeklyDeps['submit'], submitDeps,
      judge: judge as unknown as ScoringWeeklyDeps['judge'], anthropicConfigured: true, now,
    }
    return { deps, notify, alert, judge, submit }
  }

  /** ProposalShopifyOps fake for the deprecation apply — records productSet/unpublish in call order,
   *  throws on any op this executor must not touch. Mirrors apply-deprecate-product.test.ts. */
  function fakeShopify(): ProposalShopifyOps & { calls: string[] } {
    const calls: string[] = []
    const mustNotTouch = (name: string) => async () => {
      throw new Error(`deprecation apply must not call ${name}`)
    }
    return {
      calls,
      findProductByHandle: mustNotTouch('findProductByHandle') as ProposalShopifyOps['findProductByHandle'],
      publishablePublish: mustNotTouch('publishablePublish') as ProposalShopifyOps['publishablePublish'],
      productVariantsByProductId: mustNotTouch('productVariantsByProductId') as ProposalShopifyOps['productVariantsByProductId'],
      productSet: async (input) => {
        calls.push(`productSet:${String((input as { status?: string }).status)}`)
        return { productId: String((input as { id?: string }).id), variants: [] }
      },
      listPublications: async () => [
        { id: 'pub-1', name: 'Online Store' },
        { id: 'pub-2', name: 'Shop' },
      ],
      publishableUnpublish: async (_gid, publicationId) => {
        calls.push(`unpublish:${publicationId}`)
      },
    }
  }

  function fakeAdapter() {
    const unsubscribed: string[] = []
    return {
      unsubscribed,
      unsubscribeProductWebhook: async (spid: string) => {
        unsubscribed.push(spid)
      },
      subscribeProductWebhook: async () => {
        throw new Error('deprecation apply must not call subscribeProductWebhook')
      },
      getDisputeOptions: async () => {
        throw new Error('deprecation apply must not call getDisputeOptions')
      },
      openDispute: async () => {
        throw new Error('deprecation apply must not call openDispute')
      },
    }
  }

  function makeApplyDeps() {
    const shopify = fakeShopify()
    const adapter = fakeAdapter()
    const alert = vi.fn(async () => {})
    const deps: ApplyProposalDeps = {
      db,
      alert: alert as unknown as ApplyProposalDeps['alert'],
      shopify,
      adapter: adapter as unknown as ApplyProposalDeps['adapter'],
      gmail: null,
      refundOps: null,
      supportAddress: '',
      notify: vi.fn(async () => true) as unknown as ApplyProposalDeps['notify'],
      enqueue: vi.fn(async () => {}) as unknown as ApplyProposalDeps['enqueue'],
      adminBaseUrl: ADMIN,
    }
    return { deps, shopify, adapter, alert }
  }

  // ---------------------------------------------------------------------------
  // Query helpers (all scoped to this file's ids — never global counts)
  // ---------------------------------------------------------------------------

  /** The real nightly scores EVERY active product for FUTURE_DATE; most of the shared DB's 300+
   *  products read as `deprecate` at a 2099 clock (no orders in that window). Prune all but this
   *  file's two so the digest's candidate join sees only this catalog. */
  async function pruneForeignScores(keep: string[]): Promise<void> {
    await db
      .delete(productScores)
      .where(and(eq(productScores.scoreDate, FUTURE_DATE), notInArray(productScores.productId, keep)))
  }

  async function scoreRow(productId: string) {
    const [row] = await db
      .select()
      .from(productScores)
      .where(and(eq(productScores.productId, productId), eq(productScores.scoreDate, FUTURE_DATE)))
    return row
  }

  async function proposalsFor(productId: string) {
    return db.select().from(proposals).where(eq(proposals.productId, productId))
  }

  async function loadProduct(id: string) {
    const [row] = await db.select().from(products).where(eq(products.id, id))
    return row
  }

  async function loadProposal(id: string) {
    const [row] = await db.select().from(proposals).where(eq(proposals.id, id))
    return row
  }

  async function auditCount(action: string, entityId: string): Promise<number> {
    const rows = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)))
    return rows.length
  }

  // ---------------------------------------------------------------------------
  // The end-to-end walk (one narrative — each stage depends on the last)
  // ---------------------------------------------------------------------------
  it('scores → digests → recovers → applies → re-runs as a no-op', async () => {
    // === Seed: pre-revenue gate opener + a two-product catalog =============================
    await seedRealPaidOrder()
    // Crosses the deprecate rule: 45d live, 0 units, a real (non-null-gid) variant + CJ mapping.
    const depId = await seedProduct({ title: `${MARK}Doomed Chew Toy`, createdAtDaysAgo: 45 })
    const depSpid = await seedVariantMapping(depId)
    // Near-miss WATCH: 16d live (>= deprecate_after_days-7 = 14, < 21), 0 units, no variant.
    const watchId = await seedProduct({ title: `${MARK}Slow Starter`, createdAtDaysAgo: 16 })

    // === Stage 1: nightly scoring writes the right verdicts ===============================
    const nightly1 = makeNightlyDeps()
    const r1 = await executeScoringNightly(nightly1.deps)
    expect(r1.scored).toBeGreaterThanOrEqual(2) // whole active catalog scored; ours are in it

    const depScore = await scoreRow(depId)
    expect(depScore!.verdict).toBe('deprecate')
    expect(depScore!.daysLive).toBeGreaterThanOrEqual(21)
    expect(depScore!.unitsSold28d).toBe(0)

    const watchScore = await scoreRow(watchId)
    expect(watchScore!.verdict).toBe('watch') // near-miss, NOT deprecate
    expect(watchScore!.daysLive).toBeGreaterThanOrEqual(14)
    expect(watchScore!.daysLive).toBeLessThan(21)

    // Isolate the digest from the rest of the (residue-laden) shared catalog.
    await pruneForeignScores([depId, watchId])

    // === Stage 2: weekly digest, run #1 — the FIRST notify fails (recovery sub-case) =======
    // One digest deps object for runs #1 and #2 so the notify mock sequence (false, then true)
    // spans both — the re-runnable-notify property under test.
    const digest = makeDigestDeps()
    digest.notify.mockResolvedValueOnce(false).mockResolvedValue(true)

    const d1 = await runWeeklyDeprecationDigest(digest.deps)
    // Exactly one proposal created — for the deprecate product, never the watch one.
    expect(d1.created).toBe(1)
    expect(d1.notified).toBe(0) // a false send stamps nothing
    expect(digest.judge).toHaveBeenCalledTimes(1) // judge exercised (spared nobody)

    const depProps = await proposalsFor(depId)
    expect(depProps).toHaveLength(1)
    expect(depProps[0]!.type).toBe('deprecate_product')
    expect(depProps[0]!.status).toBe('pending')
    expect(depProps[0]!.actionTokenHash).toBeNull() // suppressNotify mints no token
    expect((depProps[0]!.payload as { evidence: { reasoning: string } }).evidence.reasoning).toContain('low sales')
    expect(await proposalsFor(watchId)).toHaveLength(0) // the watch product is not proposed

    const proposalId = depProps[0]!.id
    expect(await auditCount('scoring.deprecation_notified', proposalId)).toBe(0) // NOT stamped on false send

    // === Stage 3: weekly digest, run #2 — re-runnable notify re-lists and stamps ==========
    const d2 = await runWeeklyDeprecationDigest(digest.deps)
    expect(d2.created).toBe(0) // deduped against the now-live pending proposal
    expect(d2.notified).toBe(1) // re-listed and, this time, stamped
    expect(digest.notify).toHaveBeenCalledTimes(2)
    const lastBody = digest.notify.mock.calls.at(-1)![0].body
    expect(lastBody).toContain(`${ADMIN}/admin/proposals/${proposalId}`)
    expect(await auditCount('scoring.deprecation_notified', proposalId)).toBe(1)

    // === Stage 4: owner approves → apply deprecates the product end-to-end =================
    await applyProposalTransition(db, proposalId, 'pending', 'approved', { decidedBy: 'owner-e2e', decidedAt: now() })
    const apply = makeApplyDeps()
    await executeApplyProposal(apply.deps, proposalId)

    const depAfter = await loadProduct(depId)
    expect(depAfter!.status).toBe('deprecated')
    expect(depAfter!.deprecatedAt).toBeInstanceOf(Date)
    // DRAFT then pulled from every publication (mock Shopify).
    expect(apply.shopify.calls).toEqual(['productSet:DRAFT', 'unpublish:pub-1', 'unpublish:pub-2'])
    // The sole (unshared) CJ product is unsubscribed.
    expect(apply.adapter.unsubscribed).toEqual([depSpid])

    const propApplied = await loadProposal(proposalId)
    expect(propApplied!.status).toBe('applied')
    expect(propApplied!.appliedAt).toBeInstanceOf(Date)
    expect(await auditCount(PROPOSAL_APPLIED_ACTION, proposalId)).toBe(1)

    // === Stage 5: a second run of BOTH crons is a no-op ===================================
    const r2 = await executeScoringNightly(makeNightlyDeps().deps)
    expect(r2.scored).toBeGreaterThanOrEqual(1)
    await pruneForeignScores([depId, watchId])
    // Idempotent: the still-active watch product re-scores to the same verdict; the deprecated
    // product is no longer active, so it is simply not re-scored (its row is untouched).
    expect((await scoreRow(watchId))!.verdict).toBe('watch')
    expect((await loadProduct(depId))!.status).toBe('deprecated')

    const d3 = await runWeeklyDeprecationDigest(makeDigestDeps().deps)
    expect(d3).toEqual({ created: 0, notified: 0, spared: 0 }) // deduped + nothing left to notify
    // Still exactly one proposal for the deprecate product — now applied, never re-created.
    const depPropsFinal = await proposalsFor(depId)
    expect(depPropsFinal).toHaveLength(1)
    expect(depPropsFinal[0]!.status).toBe('applied')
  })
})
