import { ListingDecisionContextSchema } from '@doge-buddy/core'
import type { ShippingOption, SupplierProductDetail, WarehouseStock } from '@doge-buddy/supplier'
import { describe, expect, it, vi } from 'vitest'
import type { SourcingWinner } from '../src/agents/output-schema.ts'
import { PointsAllowance } from '../src/agents/points.ts'
import type { SubmitProposalDeps, SubmitProposalInput } from '../src/proposals/submit.ts'
import { ReviewsSeen } from '../src/sourcing/decision-context.ts'
import type { AmazonDemandSnapshot, DemandProbeProvider } from '../src/sourcing/demand-probe.ts'
import type { HarvestCandidate } from '../src/sourcing/harvest.ts'
import { MarketLookups, type MarketOffer } from '../src/sourcing/market-price.ts'
import {
  COST_TOLERANCE_BPS,
  validateAndSubmitWinners,
  type SubmitWinnersDeps,
} from '../src/sourcing/submit-winners.ts'
import type { Settings } from '../src/settings.ts'
import type { TrendSignal } from '../src/sourcing/trends.ts'

function marketOffers(...cents: number[]): MarketOffer[] {
  return cents.map((c, i) => ({ title: `o${i}`, priceCents: c, merchant: null, url: null }))
}

const RUN_ID = 'run-test-1'

function candidate(pid: string, overrides: Partial<HarvestCandidate> = {}): HarvestCandidate {
  return {
    supplierProductId: pid,
    title: 'CJ Dog Bed',
    categoryName: 'Pet Beds',
    sellPriceCents: 1800,
    listedNum: 100,
    imageUrl: null,
    keyword: 'dog bed',
    ...overrides,
  }
}

/** Minimal valid winner: passes all 8 steps against the default adapter/settings below with
 * a live cost of 1000c, freight of 500c, and a 5000c sell price -> 7000bps margin. */
function winnerFor(pid: string, overrides: { payload?: Record<string, unknown>; winner?: Partial<SourcingWinner> } = {}): SourcingWinner {
  const vid = `${pid}-v1`
  const payload = {
    type: 'new_listing',
    title: 'Cozy Dog Bed',
    descriptionHtml: '<p>Soft and durable bed for your pup.</p>',
    categoryTag: 'beds',
    imageUrls: ['https://cf.cjdropshipping.com/x.png'],
    shipsFrom: 'US',
    deliveryMinDays: 3,
    deliveryMaxDays: 7,
    variants: [
      {
        sku: `SKU-${pid}`,
        priceCents: 5000,
        supplierCostCents: 1050, // agent's claimed cost — live is 1000, within tolerance
        supplier: 'cj',
        supplierProductId: pid,
        supplierVariantId: vid,
      },
    ],
    highlights: ['Durable rope core', 'Machine washable', 'Non-slip grip'],
    specs: [{ label: 'Material', value: 'Cotton' }],
    ...overrides.payload,
  }
  return {
    payload,
    rationale: 'Strong search interest and healthy margin.',
    marginPct: 55,
    freightEstimateCents: 500,
    ...overrides.winner,
  } as SourcingWinner
}

interface AdapterOverrides {
  getProduct?: (pid: string) => Promise<SupplierProductDetail>
  getVariantStock?: (vid: string) => Promise<WarehouseStock[]>
  quoteShipping?: (q: { fromCountry: string; toCountry: string; items: { supplierVariantId: string; quantity: number }[] }) => Promise<ShippingOption[]>
}

/** Default adapter: echoes back whatever pid/vid it's asked about with a live cost of 1000c,
 * plenty of US stock, and a single $5 freight option landing in 7 days — matches winnerFor's
 * defaults so most tests only need to override the one thing under test. */
function makeAdapter(overrides: AdapterOverrides = {}) {
  const getProduct = vi.fn(
    overrides.getProduct ??
      (async (pid: string): Promise<SupplierProductDetail> => ({
        supplierProductId: pid,
        title: 'CJ Dog Bed',
        imageUrls: [],
        variants: [{ supplierVariantId: `${pid}-v1`, priceCents: 1000 }],
      })),
  )
  const getVariantStock = vi.fn(
    overrides.getVariantStock ?? (async (): Promise<WarehouseStock[]> => [{ countryCode: 'US', quantity: 10, verified: true }]),
  )
  const quoteShipping = vi.fn(
    overrides.quoteShipping ?? (async (): Promise<ShippingOption[]> => [{ name: 'Standard', priceCents: 500, minDays: 3, maxDays: 7 }]),
  )
  return { getProduct, getVariantStock, quoteShipping }
}

function makeSettings(marginFloorBps = 6000): Settings {
  return {
    get: (async () => marginFloorBps) as Settings['get'],
    set: (async () => {}) as Settings['set'],
  }
}

function makeDeps(overrides: Partial<SubmitWinnersDeps> & { submit?: SubmitWinnersDeps['submit'] } = {}): SubmitWinnersDeps {
  return {
    db: {} as SubmitWinnersDeps['db'],
    adapter: makeAdapter(),
    allowance: new PointsAllowance(),
    submit: vi.fn(async () => ({ id: 'proposal-1', status: 'pending' as const })),
    submitDeps: {} as SubmitProposalDeps,
    settings: makeSettings(),
    alert: vi.fn(async () => {}),
    marketLookups: null,
    demandProbe: null,
    reviewsSeen: new ReviewsSeen(),
    trendSignalsByKeyword: new Map(),
    ...overrides,
  }
}

function makeDemandProbe(probe?: DemandProbeProvider['probe']): DemandProbeProvider {
  return { key: 'serpapi_amazon', probe: vi.fn(probe ?? (async () => null)) }
}

function candidateSet(pids: string[]): { candidateIds: Set<string>; candidatesByPid: Map<string, HarvestCandidate> } {
  return {
    candidateIds: new Set(pids),
    candidatesByPid: new Map(pids.map((pid) => [pid, candidate(pid)])),
  }
}

/** Shared input construction for the single-candidate ('pid-1') content-gate/scrub tests below —
 * same shape as every neighboring step-test's inline object. */
function runFor(winners: SourcingWinner[]): {
  runId: string
  candidateIds: Set<string>
  candidatesByPid: Map<string, HarvestCandidate>
  winners: SourcingWinner[]
  maxPriceToMarketBps: number
} {
  const { candidateIds, candidatesByPid } = candidateSet(['pid-1'])
  return { runId: RUN_ID, candidateIds, candidatesByPid, maxPriceToMarketBps: 13000, winners }
}

describe('validateAndSubmitWinners', () => {
  it('happy path: submits with the LIVE cost in the payload and a margin-bearing summary', async () => {
    const submit = vi.fn(async (_deps: SubmitProposalDeps, _input: SubmitProposalInput) => ({
      id: 'proposal-1',
      status: 'pending' as const,
    }))
    const alert = vi.fn(async () => {})
    const deps = makeDeps({ submit, alert })
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [winnerFor('cjp-1')],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'submitted' }])
    expect(alert).not.toHaveBeenCalled()
    expect(submit).toHaveBeenCalledTimes(1)

    const [submitDeps, submitInput] = submit.mock.calls[0]!
    expect(submitDeps).toBe(deps.submitDeps)
    expect(submitInput).toMatchObject({
      type: 'new_listing',
      sourceWorkflow: 'sourcing.weekly',
      agentRunId: RUN_ID,
    })
    // Live cost (1000c) overwrote the agent's claimed cost (1050c).
    expect((submitInput.payload as { variants: { supplierCostCents: number }[] }).variants[0]!.supplierCostCents).toBe(1000)
    // margin = floor((5000 - 1000 - 500) * 10000 / 5000) = 7000bps
    // profit = 5000 - 1000 (live cost) - 500 (freight) = 3500c = $35.00; est clause carries the
    // candidate's harvested listedNum (100) — populated regardless of the market/demand gates.
    expect(submitInput.summary).toBe('New listing: Cozy Dog Bed — 1 variant(s), 1 image(s), margin 7000bps, profit $35.00 | est: CJ 100 listed')

    // FIX C5: Stage 4.6 verified US stock, so freight MUST be quoted from US (mirroring the
    // order-time gate in run-place-order.ts). A CN quote returns China-origin ~15-30d options that
    // all fail the deliveryMaxDays filter, silently dropping every real winner.
    expect(deps.adapter.quoteShipping).toHaveBeenCalledWith(
      expect.objectContaining({ fromCountry: 'US', toCountry: 'US' }),
    )
  })

  it('allowance spends 10+10+10 per fully-verified winner (getProduct + getVariantStock + quoteShipping)', async () => {
    const allowance = new PointsAllowance()
    const deps = makeDeps({ allowance })
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [winnerFor('cjp-1')],
    })

    expect(allowance.spent()).toBe(30)
    expect(deps.adapter.getProduct).toHaveBeenCalledTimes(1)
    expect(deps.adapter.getVariantStock).toHaveBeenCalledTimes(1)
    expect(deps.adapter.quoteShipping).toHaveBeenCalledTimes(1)
  })

  it('a submit throw on winner 1 still submits winner 2 (drop-and-continue)', async () => {
    let calls = 0
    const submit = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error('db down')
      return { id: 'proposal-2', status: 'pending' as const }
    })
    const alert = vi.fn(async () => {})
    const deps = makeDeps({ submit, alert })
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1', 'cjp-2'])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [winnerFor('cjp-1'), winnerFor('cjp-2')],
    })

    expect(outcomes).toEqual([
      { supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_submit_failed' },
      { supplierProductId: 'cjp-2', outcome: 'submitted' },
    ])
    expect(submit).toHaveBeenCalledTimes(2)
    expect(alert).toHaveBeenCalledTimes(1)
    expect(alert).toHaveBeenCalledWith(
      'warning',
      'sourcing_winner_submit_failed',
      expect.objectContaining({ runId: RUN_ID, supplierProductId: 'cjp-1' }),
    )
  })

  it('step 1 — sourcing_winner_not_candidate: pid not among the run\'s harvested candidates', async () => {
    const alert = vi.fn(async () => {})
    const deps = makeDeps({ alert })
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [winnerFor('cjp-999')],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-999', outcome: 'dropped', reason: 'sourcing_winner_not_candidate' }])
    expect(alert).toHaveBeenCalledWith(
      'warning',
      'sourcing_winner_not_candidate',
      expect.objectContaining({ runId: RUN_ID, supplierProductId: 'cjp-999' }),
    )
    expect(deps.adapter.getProduct).not.toHaveBeenCalled()
  })

  it('step 1 — sourcing_winner_not_candidate: multi-supplier winner (variant pids disagree)', async () => {
    const deps = makeDeps()
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])
    const winner = winnerFor('cjp-1')
    ;(winner.payload as { variants: { supplierProductId: string }[] }).variants.push({
      ...(winner.payload as { variants: Record<string, unknown>[] }).variants[0]!,
      supplierProductId: 'cjp-1-other',
      supplierVariantId: 'cjp-1-other-v1',
      sku: 'SKU-other',
    } as never)

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [winner],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_not_candidate' }])
  })

  it('step 2 — sourcing_winner_invalid_payload: fails NewListingPayloadSchema (deliveryMinDays > deliveryMaxDays)', async () => {
    const alert = vi.fn(async () => {})
    const deps = makeDeps({ alert })
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [winnerFor('cjp-1', { payload: { deliveryMinDays: 10, deliveryMaxDays: 3 } })],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_invalid_payload' }])
    expect(alert).toHaveBeenCalledWith(
      'warning',
      'sourcing_winner_invalid_payload',
      expect.objectContaining({ runId: RUN_ID, supplierProductId: 'cjp-1' }),
    )
  })

  it('step 2b — sourcing_winner_missing_content: highlights absent', async () => {
    const deps = makeDeps()
    const winner = winnerFor('pid-1', { payload: { highlights: undefined } })
    const outcomes = await validateAndSubmitWinners(deps, runFor([winner]))
    expect(outcomes[0]).toMatchObject({ outcome: 'dropped', reason: 'sourcing_winner_missing_content' })
    expect(deps.submit).not.toHaveBeenCalled()
  })

  it('step 2b — sourcing_winner_missing_content: specs absent', async () => {
    const deps = makeDeps()
    const outcomes = await validateAndSubmitWinners(deps, runFor([winnerFor('pid-1', { payload: { specs: undefined } })]))
    expect(outcomes[0]!.reason).toBe('sourcing_winner_missing_content')
  })

  it('step 3 — sourcing_winner_bad_html: descriptionHtml violates the allowlist', async () => {
    const alert = vi.fn(async () => {})
    const deps = makeDeps({ alert })
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [winnerFor('cjp-1', { payload: { descriptionHtml: '<p onclick="x">bad</p>' } })],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_bad_html' }])
    expect(alert).toHaveBeenCalledWith(
      'warning',
      'sourcing_winner_bad_html',
      expect.objectContaining({ runId: RUN_ID, supplierProductId: 'cjp-1' }),
    )
  })

  it('step 4 — sourcing_winner_excluded_category: title hits the exclusion list', async () => {
    const alert = vi.fn(async () => {})
    const deps = makeDeps({ alert })
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [winnerFor('cjp-1', { payload: { title: 'Flea Collar Deluxe' } })],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_excluded_category' }])
    expect(alert).toHaveBeenCalledWith(
      'warning',
      'sourcing_winner_excluded_category',
      expect.objectContaining({ runId: RUN_ID, supplierProductId: 'cjp-1' }),
    )
  })

  it('step 4 — sourcing_winner_excluded_category: harvested categoryName hits the exclusion list', async () => {
    const deps = makeDeps()
    const candidateIds = new Set(['cjp-1'])
    const candidatesByPid = new Map([['cjp-1', candidate('cjp-1', { categoryName: 'Flea & Tick Aids' })]])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [winnerFor('cjp-1')],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_excluded_category' }])
  })

  it('step 4 — sourcing_winner_excluded_category: excluded term inside a spec label', async () => {
    const deps = makeDeps()
    const winner = winnerFor('pid-1', { payload: { specs: [{ label: 'Supplement type', value: 'n/a' }] } })
    const outcomes = await validateAndSubmitWinners(deps, runFor([winner]))
    expect(outcomes[0]!.reason).toBe('sourcing_winner_excluded_category')
  })

  it('step 5 — claims_scrubbed: title carries a disallowed claim phrase', async () => {
    const alert = vi.fn(async () => {})
    const deps = makeDeps({ alert })
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [winnerFor('cjp-1', { payload: { title: 'Hypoallergenic Dog Bed' } })],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'claims_scrubbed' }])
    expect(alert).toHaveBeenCalledWith(
      'warning',
      'claims_scrubbed',
      expect.objectContaining({ runId: RUN_ID, supplierProductId: 'cjp-1' }),
    )
  })

  it('step 5 — claims_scrubbed: rationale carries a disallowed claim phrase', async () => {
    const deps = makeDeps()
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [winnerFor('cjp-1', { winner: { rationale: 'Vet approved and clinically proven durability.' } })],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'claims_scrubbed' }])
  })

  it('step 5 — claims_scrubbed: claim term inside a highlight', async () => {
    const deps = makeDeps()
    const winner = winnerFor('pid-1', {
      payload: { highlights: ['Durable rope core', 'clinically proven comfort', 'Non-slip grip'] },
    })
    const outcomes = await validateAndSubmitWinners(deps, runFor([winner]))
    expect(outcomes[0]!.reason).toBe('claims_scrubbed')
  })

  it('step 5 — claims_scrubbed: claim term inside a spec VALUE and inside whatsInBox', async () => {
    const deps = makeDeps()
    for (const payload of [
      { specs: [{ label: 'Material', value: 'medical grade plastic' }] },
      { whatsInBox: '1x vet approved rope' },
    ]) {
      const outcomes = await validateAndSubmitWinners(deps, runFor([winnerFor('pid-1', { payload })]))
      expect(outcomes[0]!.reason).toBe('claims_scrubbed')
    }
  })

  it('step 5 — claims_scrubbed: whatsInBox ENDING in a bare CLAIM_TERM word (no trailing space) is still caught — the trailing-space evasion (whole-branch review)', async () => {
    // whatsInBox rides last among contentStrings, so a payload ending the whole scanned text in
    // the bare word 'cure' (no space after it) is exactly the evasion the guards.ts fix closes.
    // 'chew' is itself an EXCLUDED_CATEGORY_TERM, so the phrase below deliberately avoids it.
    const deps = makeDeps()
    const outcomes = await validateAndSubmitWinners(
      deps,
      runFor([winnerFor('pid-1', { payload: { whatsInBox: 'the ultimate boredom cure' } })]),
    )
    expect(outcomes[0]!.reason).toBe('claims_scrubbed')
  })

  it('step 7 — sourcing_winner_unverifiable: live cost drifts beyond COST_TOLERANCE_BPS', async () => {
    const alert = vi.fn(async () => {})
    const adapter = makeAdapter({
      getProduct: async (pid) => ({
        supplierProductId: pid,
        title: 'CJ Dog Bed',
        imageUrls: [],
        variants: [{ supplierVariantId: `${pid}-v1`, priceCents: 5000 }], // way beyond tolerance of claimed 1050
      }),
    })
    const deps = makeDeps({ adapter, alert })
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [winnerFor('cjp-1')],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_unverifiable' }])
    expect(alert).toHaveBeenCalledWith(
      'warning',
      'sourcing_winner_unverifiable',
      expect.objectContaining({ runId: RUN_ID, supplierProductId: 'cjp-1' }),
    )
  })

  it('step 7 — sourcing_winner_unverifiable: unknown supplierVariantId at CJ', async () => {
    const deps = makeDeps({
      adapter: makeAdapter({
        getProduct: async (pid) => ({
          supplierProductId: pid,
          title: 'CJ Dog Bed',
          imageUrls: [],
          variants: [{ supplierVariantId: 'some-other-vid', priceCents: 1000 }],
        }),
      }),
    })
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [winnerFor('cjp-1')],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_unverifiable' }])
  })

  it('step 7 — sourcing_winner_unverifiable: no US stock with quantity >= 1', async () => {
    const deps = makeDeps({
      adapter: makeAdapter({
        getVariantStock: async () => [
          { countryCode: 'US', quantity: 0, verified: true },
          { countryCode: 'CN', quantity: 500, verified: true },
        ],
      }),
    })
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [winnerFor('cjp-1')],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_unverifiable' }])
  })

  it('step 8 — sourcing_winner_margin_below_floor: freight-inclusive margin under the floor', async () => {
    const alert = vi.fn(async () => {})
    const adapter = makeAdapter({
      getProduct: async (pid) => ({
        supplierProductId: pid,
        title: 'CJ Dog Bed',
        imageUrls: [],
        variants: [{ supplierVariantId: `${pid}-v1`, priceCents: 500 }],
      }),
      quoteShipping: async () => [{ name: 'Standard', priceCents: 100, minDays: 3, maxDays: 7 }],
    })
    const deps = makeDeps({ adapter, alert })
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    // priceCents 1000, live cost 500 (claimed 510, within tolerance), freight 100
    // margin = floor((1000 - 500 - 100) * 10000 / 1000) = 4000bps < 6000 floor
    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [
        winnerFor('cjp-1', {
          payload: { variants: [{ sku: 'SKU-cjp-1', priceCents: 1000, supplierCostCents: 510, supplier: 'cj', supplierProductId: 'cjp-1', supplierVariantId: 'cjp-1-v1' }] },
        }),
      ],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_margin_below_floor' }])
    expect(alert).toHaveBeenCalledWith(
      'warning',
      'sourcing_winner_margin_below_floor',
      expect.objectContaining({ runId: RUN_ID, supplierProductId: 'cjp-1' }),
    )
  })

  it('step 8 — sourcing_winner_margin_below_floor: no freight option lands within deliveryMaxDays', async () => {
    const deps = makeDeps({
      adapter: makeAdapter({
        quoteShipping: async () => [{ name: 'Slow Boat', priceCents: 100, minDays: 10, maxDays: 20 }], // deliveryMaxDays is 7
      }),
    })
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [winnerFor('cjp-1')],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_margin_below_floor' }])
  })

  it('step 9 — sourcing_winner_submit_failed: submitProposal throws', async () => {
    const alert = vi.fn(async () => {})
    const submit = vi.fn(async () => {
      throw new Error('insert failed')
    })
    const deps = makeDeps({ submit, alert })
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [winnerFor('cjp-1')],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_submit_failed' }])
    expect(alert).toHaveBeenCalledWith(
      'warning',
      'sourcing_winner_submit_failed',
      expect.objectContaining({ runId: RUN_ID, supplierProductId: 'cjp-1' }),
    )
  })

  it('exposes COST_TOLERANCE_BPS as 500', () => {
    expect(COST_TOLERANCE_BPS).toBe(500)
  })
})

// To plant an agent-proposed imageUrl WITHOUT breaking the margin/cost numbers the default
// builder is tuned to pass, spread it onto the builder's own default variant (there is no
// variantFor helper). `runFor` again stands for the file's existing candidateSet-based input
// construction; payload overrides go under the `payload` key (builder signature at :36).
const withAgentImage = (pid: string) => {
  const base = winnerFor(pid).payload as { variants: Record<string, unknown>[] }
  return winnerFor(pid, {
    payload: { variants: [{ ...base.variants[0], imageUrl: 'https://agent.example.com/invented.jpg' }] },
  })
}

describe('step 7 — live variant image overwrite', () => {
  it('replaces the agent-proposed imageUrl with the live CJ value', async () => {
    const deps = makeDeps({
      adapter: makeAdapter({
        getProduct: async (pid) => ({
          supplierProductId: pid,
          title: 'CJ Dog Bed',
          imageUrls: [],
          variants: [{ supplierVariantId: `${pid}-v1`, priceCents: 1000, imageUrl: 'https://cj.example.com/live.jpg' }],
        }),
      }),
    })
    await validateAndSubmitWinners(deps, runFor([withAgentImage('pid-1')]))
    const submitted = (deps.submit as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(submitted.payload.variants[0].imageUrl).toBe('https://cj.example.com/live.jpg')
  })

  it('CLEARS the agent-proposed imageUrl when CJ shows no image for the variant', async () => {
    const deps = makeDeps() // default adapter: live variant has no imageUrl
    await validateAndSubmitWinners(deps, runFor([withAgentImage('pid-1')]))
    const submitted = (deps.submit as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(submitted.payload.variants[0].imageUrl).toBeUndefined()
  })

  it('treats a non-http(s) live value as absent', async () => {
    const deps = makeDeps({
      adapter: makeAdapter({
        getProduct: async (pid) => ({
          supplierProductId: pid,
          title: 'CJ Dog Bed',
          imageUrls: [],
          variants: [{ supplierVariantId: `${pid}-v1`, priceCents: 1000, imageUrl: 'not a url' }],
        }),
      }),
    })
    await validateAndSubmitWinners(deps, runFor([winnerFor('pid-1')]))
    const submitted = (deps.submit as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(submitted.payload.variants[0].imageUrl).toBeUndefined()
  })
})

describe('step 6: price-to-market gate', () => {
  it('gate skipped when marketLookups is null: winner submits, summary has NO market clause', async () => {
    const submit = vi.fn(async (_deps: SubmitProposalDeps, _input: SubmitProposalInput) => ({
      id: 'proposal-1',
      status: 'pending' as const,
    }))
    const deps = makeDeps({ submit }) // marketLookups: null by default
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [winnerFor('cjp-1')],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'submitted' }])
    expect(submit).toHaveBeenCalledTimes(1)
    const [, submitInput] = submit.mock.calls[0]!
    expect(submitInput.summary).not.toMatch(/market \$/)
  })

  it('armed + no marketLookupId -> dropped sourcing_winner_no_market_price (reason missing), BEFORE any CJ call', async () => {
    const alert = vi.fn(async () => {})
    const deps = makeDeps({ marketLookups: new MarketLookups(), alert })
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [winnerFor('cjp-1')], // no marketLookupId
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_no_market_price' }])
    expect(alert).toHaveBeenCalledWith(
      'warning',
      'sourcing_winner_no_market_price',
      expect.objectContaining({
        runId: RUN_ID,
        supplierProductId: 'cjp-1',
        detail: expect.objectContaining({ marketLookupId: null, reason: 'missing' }),
      }),
    )
    expect(deps.adapter.getProduct).not.toHaveBeenCalled()
  })

  it('armed + lookup for a DIFFERENT pid -> dropped (pid_mismatch)', async () => {
    const alert = vi.fn(async () => {})
    const registry = new MarketLookups()
    registry.record({ supplierProductId: 'other-pid', query: 'q', offers: marketOffers(1, 2, 3, 4, 5) })
    const deps = makeDeps({ marketLookups: registry, alert })
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [winnerFor('cjp-1', { winner: { marketLookupId: 'mkt_1' } })],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_no_market_price' }])
    expect(alert).toHaveBeenCalledWith(
      'warning',
      'sourcing_winner_no_market_price',
      expect.objectContaining({
        runId: RUN_ID,
        supplierProductId: 'cjp-1',
        detail: expect.objectContaining({ reason: 'pid_mismatch' }),
      }),
    )
    expect(deps.adapter.getProduct).not.toHaveBeenCalled()
  })

  it('armed + inconclusive lookup (4 offers) -> dropped (inconclusive)', async () => {
    const alert = vi.fn(async () => {})
    const registry = new MarketLookups()
    registry.record({ supplierProductId: 'cjp-1', query: 'q', offers: marketOffers(100, 200, 300, 400) })
    const deps = makeDeps({ marketLookups: registry, alert })
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [winnerFor('cjp-1', { winner: { marketLookupId: 'mkt_1' } })],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_no_market_price' }])
    expect(alert).toHaveBeenCalledWith(
      'warning',
      'sourcing_winner_no_market_price',
      expect.objectContaining({
        runId: RUN_ID,
        supplierProductId: 'cjp-1',
        detail: expect.objectContaining({ reason: 'inconclusive' }),
      }),
    )
    expect(deps.adapter.getProduct).not.toHaveBeenCalled()
  })

  it('median variant price at the ceiling passes; one cent above drops with full detail', async () => {
    // median(2000, 2400, 2499, 2600, 3000) = 2499; ceiling = floor(2499 * 13000 / 10000) = 3248
    const alert = vi.fn(async () => {})
    const submit = vi.fn(async (_deps: SubmitProposalDeps, _input: SubmitProposalInput) => ({
      id: 'proposal-1',
      status: 'pending' as const,
    }))
    const registry = new MarketLookups()
    registry.record({ supplierProductId: 'cjp-1', query: 'q', offers: marketOffers(2000, 2400, 2499, 2600, 3000) })
    // Margin floor lowered to 0: at priceCents 3248 with live cost 1000 and freight 500, margin is
    // ~5381bps — below the file's default 6000bps floor. This test is about the price-to-market
    // gate (step 6), not the margin gate (step 8), so the floor is relaxed to isolate it.
    const deps = makeDeps({ marketLookups: registry, alert, submit, settings: makeSettings(0) })
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    const atCeiling = winnerFor('cjp-1', {
      payload: {
        variants: [
          { sku: 'SKU-cjp-1-a', priceCents: 3248, supplierCostCents: 1050, supplier: 'cj', supplierProductId: 'cjp-1', supplierVariantId: 'cjp-1-v1' },
        ],
      },
      winner: { marketLookupId: 'mkt_1' },
    })
    const oneCentAbove = winnerFor('cjp-1', {
      payload: {
        variants: [
          { sku: 'SKU-cjp-1-b', priceCents: 3249, supplierCostCents: 1050, supplier: 'cj', supplierProductId: 'cjp-1', supplierVariantId: 'cjp-1-v1' },
        ],
      },
      winner: { marketLookupId: 'mkt_1' },
    })

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [atCeiling, oneCentAbove],
    })

    expect(outcomes).toEqual([
      { supplierProductId: 'cjp-1', outcome: 'submitted' },
      { supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_price_above_market' },
    ])
    const [, submitInput] = submit.mock.calls[0]!
    expect(submitInput.summary).toContain('market $24.99 median ×1.30')
    expect(alert).toHaveBeenCalledWith(
      'warning',
      'sourcing_winner_price_above_market',
      expect.objectContaining({
        runId: RUN_ID,
        supplierProductId: 'cjp-1',
        detail: expect.objectContaining({
          typicalCents: 3249,
          medianCents: 2499,
          ceilingCents: 3248,
          maxPriceToMarketBps: 13000,
        }),
      }),
    )
  })

  it('multi-variant: the MEDIAN variant price is gated (upper-middle on even counts)', async () => {
    // median(2000, 2400, 2499, 2600, 3000) = 2499; ceiling = floor(2499 * 13000 / 10000) = 3248
    function multiVariantPayload(pid: string, prices: number[], tag: string) {
      return {
        variants: prices.map((price, i) => ({
          sku: `SKU-${pid}-${tag}-${i}`,
          priceCents: price,
          supplierCostCents: 1050,
          supplier: 'cj',
          supplierProductId: pid,
          supplierVariantId: `${pid}-${tag}-${i}`,
        })),
      }
    }

    const registry = new MarketLookups()
    registry.record({ supplierProductId: 'cjp-1', query: 'q', offers: marketOffers(2000, 2400, 2499, 2600, 3000) })

    // Only the passing winner's variants ever reach CJ re-verification (the dropped winner is
    // caught by the gate first) — live cost 1000, matching the file's existing winnerFor defaults.
    const adapter = makeAdapter({
      getProduct: async (pid) => ({
        supplierProductId: pid,
        title: 'CJ Dog Bed',
        imageUrls: [],
        variants: [0, 1, 2, 3].map((i) => ({ supplierVariantId: `${pid}-pass-${i}`, priceCents: 1000 })),
      }),
    })
    // Margin floor lowered to 0 for the same reason as the ceiling test above — the lowest-priced
    // variant here (1999c) would otherwise fail the unrelated margin gate (step 8).
    const deps = makeDeps({ marketLookups: registry, adapter, settings: makeSettings(0) })
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    // sorted [1999, 3249, 3300, 5999] -> index floor(4*0.5)=2 -> 3300 -> DROPPED (3300 > 3248)
    const dropped = winnerFor('cjp-1', {
      payload: multiVariantPayload('cjp-1', [1999, 3249, 3300, 5999], 'drop'),
      winner: { marketLookupId: 'mkt_1' },
    })
    // sorted [1999, 3200, 3248, 5999] -> index floor(4*0.5)=2 -> 3248 -> PASSES (3248 == 3248)
    const passed = winnerFor('cjp-1', {
      payload: multiVariantPayload('cjp-1', [1999, 3200, 3248, 5999], 'pass'),
      winner: { marketLookupId: 'mkt_1' },
    })

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [dropped, passed],
    })

    expect(outcomes).toEqual([
      { supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_price_above_market' },
      { supplierProductId: 'cjp-1', outcome: 'submitted' },
    ])
  })
})

describe('step 8b decision context', () => {
  it('submits with a populated decisionContext and extended summary', async () => {
    const registry = new MarketLookups()
    const lookup = registry.record({ supplierProductId: 'cjp-1', query: 'cozy dog bed', offers: marketOffers(1000, 2000, 2199, 2400, 3000) })
    const probe = vi.fn(
      async (query: string): Promise<AmazonDemandSnapshot> => ({
        query,
        resultsSampled: 8,
        medianPriceCents: 2500,
        medianReviews: 3400,
        totalReviews: 40000,
      }),
    )
    const reviewsSeen = new ReviewsSeen()
    reviewsSeen.record('cjp-1', [
      { rating: 5, content: 'great' },
      { rating: 4, content: 'nice' },
    ])
    const trendSignalsByKeyword = new Map<string, TrendSignal>([['dog bed', { keyword: 'dog bed', score: 62.1, snapshot: {} }]])
    const submit = vi.fn(async (_deps: SubmitProposalDeps, _input: SubmitProposalInput) => ({ id: 'proposal-1', status: 'pending' as const }))
    const deps = makeDeps({
      submit,
      marketLookups: registry,
      demandProbe: { key: 'serpapi_amazon', probe },
      reviewsSeen,
      trendSignalsByKeyword,
    })
    const candidateIds = new Set(['cjp-1'])
    const candidatesByPid = new Map([['cjp-1', candidate('cjp-1', { listedNum: 1200, keyword: 'dog bed' })]])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 50000,
      winners: [winnerFor('cjp-1', { winner: { marketLookupId: lookup.lookupId } })],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'submitted' }])
    const [, submitInput] = submit.mock.calls[0]!
    const decisionContext = ListingDecisionContextSchema.parse(submitInput.decisionContext)
    // live cost (1000c) + freight (500c)
    expect(decisionContext.economics.variants[0]!.landedCents).toBe(1500)
    expect(decisionContext.economics.market!.medianCents).toBe(2199)
    expect(decisionContext.demand.amazon!.medianReviews).toBe(3400)
    expect(probe).toHaveBeenCalledWith(lookup.query)
    expect(submitInput.summary).toContain(', profit $')
    expect(submitInput.summary).toContain(' | est: amzn ~3400 reviews, CJ 1200 listed, trends 62')
  })

  it('probes ONLY survivors, reusing the lookup query', async () => {
    const registry = new MarketLookups()
    // cjp-2's lookup: median 1000, ceiling generous enough for its 5000c price to pass.
    const lookup2 = registry.record({ supplierProductId: 'cjp-2', query: 'cozy dog bed cjp-2', offers: marketOffers(500, 800, 1000, 1200, 1500) })
    const probe = vi.fn(async (query: string): Promise<AmazonDemandSnapshot> => ({ query, resultsSampled: 5, medianPriceCents: null, medianReviews: 100, totalReviews: 500 }))
    const deps = makeDeps({ marketLookups: registry, demandProbe: { key: 'serpapi_amazon', probe } })
    const candidateIds = new Set(['cjp-1', 'cjp-2'])
    const candidatesByPid = new Map([
      ['cjp-1', candidate('cjp-1')],
      ['cjp-2', candidate('cjp-2')],
    ])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 50000,
      // cjp-1 has NO marketLookupId -> dropped at step 6, never reaches the probe.
      winners: [winnerFor('cjp-1'), winnerFor('cjp-2', { winner: { marketLookupId: lookup2.lookupId } })],
    })

    expect(outcomes).toEqual([
      { supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_no_market_price' },
      { supplierProductId: 'cjp-2', outcome: 'submitted' },
    ])
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith(lookup2.query)
  })

  it('a probe throw alerts info demand_probe_failed and still submits (amazon null)', async () => {
    const registry = new MarketLookups()
    const lookup = registry.record({ supplierProductId: 'cjp-1', query: 'cozy dog bed', offers: marketOffers(1000, 2000, 2199, 2400, 3000) })
    const probe = vi.fn(async (): Promise<AmazonDemandSnapshot> => {
      throw new Error('SerpApi 500')
    })
    const alert = vi.fn(async () => {})
    const submit = vi.fn(async (_deps: SubmitProposalDeps, _input: SubmitProposalInput) => ({ id: 'proposal-1', status: 'pending' as const }))
    const deps = makeDeps({ submit, alert, marketLookups: registry, demandProbe: { key: 'serpapi_amazon', probe } })
    const candidateIds = new Set(['cjp-1'])
    const candidatesByPid = new Map([['cjp-1', candidate('cjp-1')]])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 50000,
      winners: [winnerFor('cjp-1', { winner: { marketLookupId: lookup.lookupId } })],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'submitted' }])
    expect(alert).toHaveBeenCalledWith(
      'info',
      'demand_probe_failed',
      expect.objectContaining({ runId: RUN_ID, supplierProductId: 'cjp-1', error: 'SerpApi 500' }),
    )
    const [, submitInput] = submit.mock.calls[0]!
    const decisionContext = ListingDecisionContextSchema.parse(submitInput.decisionContext)
    expect(decisionContext.demand.amazon).toBeNull()
    expect(submitInput.summary).not.toContain('amzn')
  })

  it('market gate skipped run: market and amazon are null, economics still populated, summary has no est amzn clause', async () => {
    const probe = makeDemandProbe()
    const submit = vi.fn(async (_deps: SubmitProposalDeps, _input: SubmitProposalInput) => ({ id: 'proposal-1', status: 'pending' as const }))
    const deps = makeDeps({ submit, marketLookups: null, demandProbe: probe }) // marketLookups null -> step 6 skipped entirely
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [winnerFor('cjp-1')],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'submitted' }])
    expect(probe.probe).not.toHaveBeenCalled()
    const [, submitInput] = submit.mock.calls[0]!
    const decisionContext = ListingDecisionContextSchema.parse(submitInput.decisionContext)
    expect(decisionContext.economics.market).toBeNull()
    expect(decisionContext.demand.amazon).toBeNull()
    expect(submitInput.summary).not.toContain('amzn')
  })

  it('null-source clauses are omitted, never rendered as 0', async () => {
    const submit = vi.fn(async (_deps: SubmitProposalDeps, _input: SubmitProposalInput) => ({ id: 'proposal-1', status: 'pending' as const }))
    const deps = makeDeps({ submit, demandProbe: null, trendSignalsByKeyword: new Map() })
    const candidateIds = new Set(['cjp-1'])
    const candidatesByPid = new Map([['cjp-1', candidate('cjp-1', { listedNum: null })]])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [winnerFor('cjp-1')],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'submitted' }])
    const [, submitInput] = submit.mock.calls[0]!
    expect(submitInput.summary).not.toMatch(/ \| est:/)
    expect(submitInput.summary).not.toContain('CJ')
    expect(submitInput.summary).not.toContain('trends')
    expect(submitInput.summary).not.toContain('amzn')
  })
})

describe('step 6b — Amazon price ceiling (owner ruling 2026-09-03)', () => {
  // Google offers whose median (5000c) lets the 5000c winner pass the Shopping gate at 1.3x —
  // the wide-spread-category shape (strollers) where only the Amazon ceiling can catch it.
  const googleOffers = () => marketOffers(4000, 4500, 5000, 5500, 6000)
  const snapshot = (medianPriceCents: number | null): AmazonDemandSnapshot => ({
    query: 'q',
    resultsSampled: 10,
    medianPriceCents,
    medianReviews: 900,
    totalReviews: 9000,
  })

  it('drops a winner priced above the Amazon ceiling even when the Google gate passes', async () => {
    const registry = new MarketLookups()
    const lookup = registry.record({ supplierProductId: 'cjp-1', query: 'dog stroller', offers: googleOffers() })
    const probe = vi.fn(async () => snapshot(2500)) // ceiling floor(2500*1.3) = 3250 < typical 5000
    const alert = vi.fn(async () => {})
    const submit = vi.fn(async () => ({ id: 'p1', status: 'pending' as const }))
    const deps = makeDeps({ submit, alert, marketLookups: registry, demandProbe: { key: 'serpapi_amazon', probe } })
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [winnerFor('cjp-1', { winner: { marketLookupId: lookup.lookupId } })],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_price_above_market' }])
    expect(alert).toHaveBeenCalledWith(
      'warning',
      'sourcing_winner_price_above_market',
      expect.objectContaining({
        detail: expect.objectContaining({ source: 'amazon', typicalCents: 5000, amazonMedianCents: 2500, ceilingCents: 3250 }),
      }),
    )
    expect(submit).not.toHaveBeenCalled()
  })

  it('passes at or under the Amazon ceiling, probing exactly once (step 8b reuses the snapshot)', async () => {
    const registry = new MarketLookups()
    const lookup = registry.record({ supplierProductId: 'cjp-1', query: 'dog stroller', offers: googleOffers() })
    const probe = vi.fn(async () => snapshot(4000)) // ceiling 5200 >= typical 5000
    const submit = vi.fn(async (_deps: SubmitProposalDeps, _input: SubmitProposalInput) => ({ id: 'p1', status: 'pending' as const }))
    const deps = makeDeps({ submit, marketLookups: registry, demandProbe: { key: 'serpapi_amazon', probe } })
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [winnerFor('cjp-1', { winner: { marketLookupId: lookup.lookupId } })],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'submitted' }])
    expect(probe).toHaveBeenCalledTimes(1)
    const [, submitInput] = submit.mock.calls[0]!
    const decisionContext = ListingDecisionContextSchema.parse(submitInput.decisionContext)
    expect(decisionContext.demand.amazon!.medianPriceCents).toBe(4000)
  })

  it('an inconclusive Amazon price (null median) never gates — winner submits with the snapshot on display', async () => {
    const registry = new MarketLookups()
    const lookup = registry.record({ supplierProductId: 'cjp-1', query: 'dog stroller', offers: googleOffers() })
    const probe = vi.fn(async () => snapshot(null))
    const submit = vi.fn(async (_deps: SubmitProposalDeps, _input: SubmitProposalInput) => ({ id: 'p1', status: 'pending' as const }))
    const deps = makeDeps({ submit, marketLookups: registry, demandProbe: { key: 'serpapi_amazon', probe } })
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      maxPriceToMarketBps: 13000,
      winners: [winnerFor('cjp-1', { winner: { marketLookupId: lookup.lookupId } })],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'submitted' }])
    const [, submitInput] = submit.mock.calls[0]!
    const decisionContext = ListingDecisionContextSchema.parse(submitInput.decisionContext)
    expect(decisionContext.demand.amazon!.medianPriceCents).toBeNull()
  })
})
