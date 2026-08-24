import { proposals, sourcingSignals, supplierVariantMappings, type createDb } from '@doge-buddy/db'
import type { SupplierAdapter, SupplierProductSummary } from '@doge-buddy/supplier'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { matchExcludedCategory } from './guards.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

export interface HarvestCandidate {
  supplierProductId: string
  title: string
  categoryName: string | null
  sellPriceCents: number | null
  listedNum: number | null
  imageUrl: string | null
}

/** Hard ceiling on total CJ searchProducts pages fetched (both passes combined) in one run. */
export const HARVEST_MAX_PAGES_TOTAL = 10
/** How many ranked candidates a full harvest run aims to hand off to the next stage. */
export const CANDIDATE_TARGET = 15
/** Below this many survivors, the ORCHESTRATOR (Task 14) short-circuits the rest of the pipeline
 * — runHarvest itself has no opinion about it and just returns whatever it found. */
export const MIN_CANDIDATES = 3

export interface HarvestDeps {
  db: Db
  adapter: Pick<SupplierAdapter, 'searchProducts'>
  alert: Alert
  now?: () => Date
}

const PAGE_SIZE = 50
const DEDUPE_WINDOW_DAYS = 90
/** Any age counts against dedupe for these statuses — the proposal is still "live". */
const LIVE_PROPOSAL_STATUSES = ['pending', 'approved', 'failed'] as const
/** Only counts against dedupe within the 90-day window for these — an old rejection/expiry
 * doesn't permanently block a product from resurfacing. */
const STALE_PROPOSAL_STATUSES = ['rejected', 'expired'] as const

interface PassState {
  flag: 'trending' | 'new'
  page: number
  ended: boolean
}

/**
 * Runs both CJ searchProducts passes (trending + new), records every fetched summary as an
 * append-only sourcing_signals row, then filters (Stage 1: supplier_variant_mappings dedupe,
 * recent/live new_listing proposal dedupe, category exclusion guard) and ranks survivors down to
 * ~CANDIDATE_TARGET. Plain code, no LLM.
 */
export async function runHarvest(deps: HarvestDeps): Promise<{ candidates: HarvestCandidate[]; pagesFetched: number }> {
  const now = deps.now ?? (() => new Date())

  const passA: PassState = { flag: 'trending', page: 1, ended: false }
  const passB: PassState = { flag: 'new', page: 1, ended: false }
  const order: PassState[] = [passA, passB]

  let pagesFetched = 0
  let turn = 0
  const fetchedByPid = new Map<string, SupplierProductSummary>()

  while (pagesFetched < HARVEST_MAX_PAGES_TOTAL && (!passA.ended || !passB.ended)) {
    const pass = order[turn % 2]!
    turn += 1
    if (pass.ended) continue

    let pageSummaries: SupplierProductSummary[]
    try {
      pageSummaries = await deps.adapter.searchProducts({ flag: pass.flag, page: pass.page, pageSize: PAGE_SIZE })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await deps.alert('warning', 'sourcing_harvest_page_failed', { pass: pass.flag, page: pass.page, error: message })
      pass.ended = true
      continue
    }

    pagesFetched += 1

    if (pageSummaries.length === 0) {
      pass.ended = true
      continue
    }

    for (const s of pageSummaries) {
      if (!fetchedByPid.has(s.supplierProductId)) {
        fetchedByPid.set(s.supplierProductId, s)
      }
    }
    pass.page += 1
  }

  const summaries = [...fetchedByPid.values()]

  // Step 2: every unique summary fetched this run gets an append-only sourcing_signals row.
  if (summaries.length > 0) {
    await deps.db.insert(sourcingSignals).values(
      summaries.map((s) => ({
        source: 'cj_trending' as const,
        supplierProductId: s.supplierProductId,
        keyword: null,
        score: s.listedCount != null ? String(s.listedCount) : null,
        snapshot: s,
      })),
    )
  }

  if (summaries.length === 0) {
    return { candidates: [], pagesFetched }
  }

  // Step 3a: drop pids already mapped to a live product.
  const mappingRows = await deps.db.selectDistinct({ pid: supplierVariantMappings.supplierProductId }).from(supplierVariantMappings)
  const mappedPids = new Set(mappingRows.map((r) => r.pid))

  // Step 3b: drop pids covered by a still-live, or recently decided, new_listing proposal.
  const cutoff = new Date(now().getTime() - DEDUPE_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const proposalPidRows = await deps.db
    .select({
      pid: sql<string | null>`${proposals.payload} -> 'variants' -> 0 ->> 'supplierProductId'`,
    })
    .from(proposals)
    .where(
      and(
        eq(proposals.type, 'new_listing'),
        or(
          inArray(proposals.status, [...LIVE_PROPOSAL_STATUSES]),
          and(
            inArray(proposals.status, [...STALE_PROPOSAL_STATUSES]),
            sql`coalesce(${proposals.decidedAt}, ${proposals.updatedAt}) > ${cutoff}`,
          ),
        ),
      ),
    )
  const excludedProposalPids = new Set(proposalPidRows.map((r) => r.pid).filter((pid): pid is string => pid != null))

  // Step 3c + candidate shaping.
  const survivors: HarvestCandidate[] = []
  for (const s of summaries) {
    if (mappedPids.has(s.supplierProductId)) continue
    if (excludedProposalPids.has(s.supplierProductId)) continue
    if (matchExcludedCategory(s.title, s.categoryName ?? null)) continue

    survivors.push({
      supplierProductId: s.supplierProductId,
      title: s.title,
      categoryName: s.categoryName ?? null,
      sellPriceCents: s.sellPriceCents ?? null,
      listedNum: s.listedCount ?? null,
      imageUrl: s.imageUrl ?? null,
    })
  }

  // Step 4: rank — listedNum desc (nulls last), tiebreak sellPriceCents asc (nulls last) — then cap.
  survivors.sort((a, b) => {
    if (a.listedNum !== b.listedNum) {
      if (a.listedNum == null) return 1
      if (b.listedNum == null) return -1
      return b.listedNum - a.listedNum
    }
    if (a.sellPriceCents !== b.sellPriceCents) {
      if (a.sellPriceCents == null) return 1
      if (b.sellPriceCents == null) return -1
      return a.sellPriceCents - b.sellPriceCents
    }
    return 0
  })

  return { candidates: survivors.slice(0, CANDIDATE_TARGET), pagesFetched }
}
