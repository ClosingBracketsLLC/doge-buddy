import type { ShippingOption, SupplierProductDetail, WarehouseStock } from '@doge-buddy/supplier'
import { describe, expect, it, vi } from 'vitest'
import type { SourcingWinner } from '../src/agents/output-schema.ts'
import { PointsAllowance } from '../src/agents/points.ts'
import type { SubmitProposalDeps, SubmitProposalInput } from '../src/proposals/submit.ts'
import type { HarvestCandidate } from '../src/sourcing/harvest.ts'
import {
  COST_TOLERANCE_BPS,
  validateAndSubmitWinners,
  type SubmitWinnersDeps,
} from '../src/sourcing/submit-winners.ts'
import type { Settings } from '../src/settings.ts'

const RUN_ID = 'run-test-1'

function candidate(pid: string, overrides: Partial<HarvestCandidate> = {}): HarvestCandidate {
  return {
    supplierProductId: pid,
    title: 'CJ Dog Bed',
    categoryName: 'Pet Beds',
    sellPriceCents: 1800,
    listedNum: 100,
    imageUrl: null,
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
    ...overrides,
  }
}

function candidateSet(pids: string[]): { candidateIds: Set<string>; candidatesByPid: Map<string, HarvestCandidate> } {
  return {
    candidateIds: new Set(pids),
    candidatesByPid: new Map(pids.map((pid) => [pid, candidate(pid)])),
  }
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
    expect(submitInput.summary).toBe('New listing: Cozy Dog Bed — 1 variant(s), margin 7000bps')
  })

  it('allowance spends 10+10+10 per fully-verified winner (getProduct + getVariantStock + quoteShipping)', async () => {
    const allowance = new PointsAllowance()
    const deps = makeDeps({ allowance })
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
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
      winners: [winnerFor('cjp-1', { payload: { deliveryMinDays: 10, deliveryMaxDays: 3 } })],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_invalid_payload' }])
    expect(alert).toHaveBeenCalledWith(
      'warning',
      'sourcing_winner_invalid_payload',
      expect.objectContaining({ runId: RUN_ID, supplierProductId: 'cjp-1' }),
    )
  })

  it('step 3 — sourcing_winner_bad_html: descriptionHtml violates the allowlist', async () => {
    const alert = vi.fn(async () => {})
    const deps = makeDeps({ alert })
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
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
      winners: [winnerFor('cjp-1', { payload: { title: 'Calming Dog Bed' } })],
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
    const candidatesByPid = new Map([['cjp-1', candidate('cjp-1', { categoryName: 'Calming Aids' })]])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
      winners: [winnerFor('cjp-1')],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_excluded_category' }])
  })

  it('step 5 — claims_scrubbed: title carries a disallowed claim phrase', async () => {
    const alert = vi.fn(async () => {})
    const deps = makeDeps({ alert })
    const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])

    const outcomes = await validateAndSubmitWinners(deps, {
      runId: RUN_ID,
      candidateIds,
      candidatesByPid,
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
      winners: [winnerFor('cjp-1', { winner: { rationale: 'Vet approved and clinically proven durability.' } })],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'claims_scrubbed' }])
  })

  it('step 6 — sourcing_winner_unverifiable: live cost drifts beyond COST_TOLERANCE_BPS', async () => {
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
      winners: [winnerFor('cjp-1')],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_unverifiable' }])
    expect(alert).toHaveBeenCalledWith(
      'warning',
      'sourcing_winner_unverifiable',
      expect.objectContaining({ runId: RUN_ID, supplierProductId: 'cjp-1' }),
    )
  })

  it('step 6 — sourcing_winner_unverifiable: unknown supplierVariantId at CJ', async () => {
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
      winners: [winnerFor('cjp-1')],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_unverifiable' }])
  })

  it('step 6 — sourcing_winner_unverifiable: no US stock with quantity >= 1', async () => {
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
      winners: [winnerFor('cjp-1')],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_unverifiable' }])
  })

  it('step 7 — sourcing_winner_margin_below_floor: freight-inclusive margin under the floor', async () => {
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

  it('step 7 — sourcing_winner_margin_below_floor: no freight option lands within deliveryMaxDays', async () => {
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
      winners: [winnerFor('cjp-1')],
    })

    expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_margin_below_floor' }])
  })

  it('step 8 — sourcing_winner_submit_failed: submitProposal throws', async () => {
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
