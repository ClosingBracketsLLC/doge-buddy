import { describe, expect, it } from 'vitest'
import { SOURCING_MAX_BUDGET_USD } from '../src/agents/sourcing-run.ts'
import { DEFAULT_MAX_WINNERS } from '../src/agents/output-schema.ts'
import { SETTINGS_DEFAULTS, type SettingKey, type Settings } from '../src/settings.ts'
import { CANDIDATE_TARGET, HARVEST_KEYWORDS, HARVEST_MAX_PAGES_TOTAL } from '../src/sourcing/harvest.ts'
import { DEFAULT_MAX_PRICE_TO_MARKET_BPS } from '../src/sourcing/market-price.ts'
import { MAX_OVERRIDE_KEYWORDS, parseRunSourcingArgs, resolveSourcingKnobs } from '../src/sourcing/knobs.ts'

/** DB-free `Settings` double: `knobs.ts` is pure logic over `Settings.get`, so the precedence
 * matrix below never needs the shared Postgres. The real settings table is exercised end-to-end by
 * `sourcing-pipeline.test.ts`. */
function fakeSettings(values: Partial<Record<SettingKey, unknown>> = {}): Settings {
  return {
    get: (async (key: SettingKey) =>
      Object.prototype.hasOwnProperty.call(values, key) ? values[key] : SETTINGS_DEFAULTS[key]) as Settings['get'],
    set: (async () => {}) as Settings['set'],
  }
}

describe('resolveSourcingKnobs', () => {
  it('the four settings defaults ARE the code constants — the two tiers can never drift', () => {
    expect(SETTINGS_DEFAULTS['sourcing.max_winners']).toBe(DEFAULT_MAX_WINNERS)
    expect(SETTINGS_DEFAULTS['sourcing.candidate_target']).toBe(CANDIDATE_TARGET)
    expect(SETTINGS_DEFAULTS['sourcing.max_pages']).toBe(HARVEST_MAX_PAGES_TOTAL)
    expect(SETTINGS_DEFAULTS['sourcing.max_budget_cents'] / 100).toBe(SOURCING_MAX_BUDGET_USD)
  })

  it('constants are the baseline when no setting row and no override exists', async () => {
    const knobs = await resolveSourcingKnobs(fakeSettings())

    expect(knobs.keywords).toEqual([...HARVEST_KEYWORDS])
    expect(knobs.maxWinners).toBe(3)
    expect(knobs.candidateTarget).toBe(CANDIDATE_TARGET)
    expect(knobs.maxPages).toBe(HARVEST_MAX_PAGES_TOTAL)
    expect(knobs.maxBudgetUsd).toBe(SOURCING_MAX_BUDGET_USD)
  })

  it('settings beat the constants (budget setting is cents, resolved to USD)', async () => {
    const knobs = await resolveSourcingKnobs(
      fakeSettings({
        'sourcing.max_winners': 6,
        'sourcing.candidate_target': 40,
        'sourcing.max_pages': 20,
        'sourcing.max_budget_cents': 550,
      }),
    )

    expect(knobs.maxWinners).toBe(6)
    expect(knobs.candidateTarget).toBe(40)
    expect(knobs.maxPages).toBe(20)
    expect(knobs.maxBudgetUsd).toBe(5.5)
  })

  it('overrides beat the settings, per knob and independently', async () => {
    const settings = fakeSettings({
      'sourcing.max_winners': 6,
      'sourcing.candidate_target': 40,
      'sourcing.max_pages': 20,
      'sourcing.max_budget_cents': 550,
    })

    const knobs = await resolveSourcingKnobs(settings, { maxWinners: 2, maxPages: 3 })

    expect(knobs.maxWinners).toBe(2) // override
    expect(knobs.maxPages).toBe(3) // override
    expect(knobs.candidateTarget).toBe(40) // setting
    expect(knobs.maxBudgetUsd).toBe(5.5) // setting
  })

  it('keywords: no setting exists — the override replaces HARVEST_KEYWORDS, trimmed, empties dropped', async () => {
    const knobs = await resolveSourcingKnobs(fakeSettings(), { keywords: ['  dog puzzle ', '', '   ', 'dog snuffle mat'] })
    expect(knobs.keywords).toEqual(['dog puzzle', 'dog snuffle mat'])
  })

  it('keywords: an all-empty override from a PROGRAMMATIC caller falls back to HARVEST_KEYWORDS', async () => {
    // The CLI refuses this instead (see parseRunSourcingArgs below) — a human who typed
    // --keywords must not be silently reverted to the default five.
    const knobs = await resolveSourcingKnobs(fakeSettings(), { keywords: ['', '  '] })
    expect(knobs.keywords).toEqual([...HARVEST_KEYWORDS])
  })

  it('keywords: deduped case-insensitively, first occurrence wins', async () => {
    const knobs = await resolveSourcingKnobs(fakeSettings(), { keywords: ['dog', 'Dog', 'dog bed'] })
    expect(knobs.keywords).toEqual(['dog', 'dog bed'])
  })

  it('keywords: the ≤ 8 cap counts DEDUPED keywords, not raw entries', async () => {
    // 10 raw entries that collapse to 6 distinct keywords must be accepted, not rejected.
    const raw = ['dog toy', 'Dog Toy', 'dog bed', 'DOG BED', 'dog leash', 'dog bowl', 'dog brush', 'dog crate', 'dog toy', ' dog bed ']
    const knobs = await resolveSourcingKnobs(fakeSettings(), { keywords: raw })
    expect(knobs.keywords).toEqual(['dog toy', 'dog bed', 'dog leash', 'dog bowl', 'dog brush', 'dog crate'])
  })

  it(`keywords: exactly ${MAX_OVERRIDE_KEYWORDS} is accepted, more throws a clear error`, async () => {
    const eight = Array.from({ length: MAX_OVERRIDE_KEYWORDS }, (_, i) => `dog kw${i}`)
    await expect(resolveSourcingKnobs(fakeSettings(), { keywords: eight })).resolves.toMatchObject({ keywords: eight })

    await expect(resolveSourcingKnobs(fakeSettings(), { keywords: [...eight, 'dog kw8'] })).rejects.toThrow(
      /at most 8 keywords/i,
    )
  })

  it.each([
    ['maxWinners', { maxWinners: 0 }, /maxWinners/],
    ['maxWinners', { maxWinners: 13 }, /maxWinners/],
    ['candidateTarget', { candidateTarget: 2 }, /candidateTarget/],
    ['candidateTarget', { candidateTarget: 81 }, /candidateTarget/],
    ['maxPages', { maxPages: 0 }, /maxPages/],
    ['maxPages', { maxPages: 41 }, /maxPages/],
    ['maxBudgetUsd', { maxBudgetUsd: 0.4 }, /maxBudgetUsd/],
    ['maxBudgetUsd', { maxBudgetUsd: 10.5 }, /maxBudgetUsd/],
  ])('an out-of-range %s override throws (sanity clamp)', async (_name, override, matcher) => {
    await expect(resolveSourcingKnobs(fakeSettings(), override)).rejects.toThrow(matcher)
  })

  it('a non-integer count override throws', async () => {
    await expect(resolveSourcingKnobs(fakeSettings(), { maxWinners: 2.5 })).rejects.toThrow(/whole number/i)
  })

  it('an out-of-range SETTING throws too — a bad setting is an owner mistake, never silently clamped', async () => {
    await expect(resolveSourcingKnobs(fakeSettings({ 'sourcing.max_winners': 99 }))).rejects.toThrow(
      /sourcing\.max_winners/,
    )
    await expect(resolveSourcingKnobs(fakeSettings({ 'sourcing.max_budget_cents': 5000 }))).rejects.toThrow(
      /sourcing\.max_budget_cents/,
    )
  })

  it('max_price_to_market default is pinned to the code constant (13000 bps)', async () => {
    expect(SETTINGS_DEFAULTS['sourcing.max_price_to_market_bps']).toBe(DEFAULT_MAX_PRICE_TO_MARKET_BPS)
    const knobs = await resolveSourcingKnobs(fakeSettings())
    expect(knobs.maxPriceToMarketBps).toBe(13000)
  })

  it('max_price_to_market setting beats the constant and is range-checked (10000-20000, integer)', async () => {
    const knobs = await resolveSourcingKnobs(fakeSettings({ 'sourcing.max_price_to_market_bps': 15000 }))
    expect(knobs.maxPriceToMarketBps).toBe(15000)

    await expect(resolveSourcingKnobs(fakeSettings({ 'sourcing.max_price_to_market_bps': 9999 }))).rejects.toThrow(
      /maxPriceToMarketBps \(setting sourcing\.max_price_to_market_bps\) must be between 10000 and 20000/,
    )
    await expect(resolveSourcingKnobs(fakeSettings({ 'sourcing.max_price_to_market_bps': 20001 }))).rejects.toThrow(
      /must be between 10000 and 20000/,
    )
  })
})

describe('parseRunSourcingArgs', () => {
  it('no flags: no force, no overrides', () => {
    expect(parseRunSourcingArgs([])).toEqual({ force: false, overrides: {} })
  })

  it('--force alone', () => {
    expect(parseRunSourcingArgs(['--force'])).toEqual({ force: true, overrides: {} })
  })

  it('brief case (e): --keywords "a, b" --max-winners 5 --budget 4.5', () => {
    expect(parseRunSourcingArgs(['--keywords', 'a, b', '--max-winners', '5', '--budget', '4.5'])).toEqual({
      force: false,
      overrides: { keywords: ['a', 'b'], maxWinners: 5, maxBudgetUsd: 4.5 },
    })
  })

  it('--candidates and --pages, mixed with --force in any position', () => {
    expect(parseRunSourcingArgs(['--candidates', '40', '--force', '--pages', '20'])).toEqual({
      force: true,
      overrides: { candidateTarget: 40, maxPages: 20 },
    })
  })

  it('accepts --flag=value form', () => {
    expect(parseRunSourcingArgs(['--max-winners=8', '--keywords=dog toy,dog bed'])).toEqual({
      force: false,
      overrides: { maxWinners: 8, keywords: ['dog toy', 'dog bed'] },
    })
  })

  it('drops empty keyword entries and trims', () => {
    expect(parseRunSourcingArgs(['--keywords', ' dog toy , , dog bed '])).toEqual({
      force: false,
      overrides: { keywords: ['dog toy', 'dog bed'] },
    })
  })

  it('deduplicates keywords case-insensitively, first occurrence wins', () => {
    expect(parseRunSourcingArgs(['--keywords', 'dog,Dog,dog bed'])).toEqual({
      force: false,
      overrides: { keywords: ['dog', 'dog bed'] },
    })
  })

  it.each<[string, string[]]>([
    ['--keywords ""', ['--keywords', '']],
    ['--keywords ","', ['--keywords', ',']],
    ['--keywords " , "', ['--keywords', ' , ']],
    ['--keywords=', ['--keywords=']],
    ['--keywords=,,', ['--keywords=,,']],
  ])('an explicitly supplied %s yields nothing and is an error, never a silent fallback', (_label, args) => {
    expect(() => parseRunSourcingArgs(args)).toThrow(/--keywords was given but contains no keywords/i)
    expect(() => parseRunSourcingArgs(args)).toThrow(/usage/i)
  })

  it('an unknown flag throws with the usage line', () => {
    expect(() => parseRunSourcingArgs(['--winners', '5'])).toThrow(/unknown flag --winners/i)
    expect(() => parseRunSourcingArgs(['--winners', '5'])).toThrow(/--max-winners/)
  })

  it('a bare positional argument throws with the usage line', () => {
    expect(() => parseRunSourcingArgs(['5'])).toThrow(/usage/i)
  })

  it('a missing flag value throws', () => {
    expect(() => parseRunSourcingArgs(['--max-winners'])).toThrow(/--max-winners needs a value/i)
  })

  it('a non-numeric flag value throws', () => {
    expect(() => parseRunSourcingArgs(['--budget', 'lots'])).toThrow(/--budget/)
  })

  it('rejects more than 8 keywords at parse time', () => {
    const nine = Array.from({ length: 9 }, (_, i) => `kw${i}`).join(',')
    expect(() => parseRunSourcingArgs(['--keywords', nine])).toThrow(/at most 8 keywords/i)
  })
})
