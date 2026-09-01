/**
 * The catalog-build knobs (spec 2026-08-31 catalog-p0 §5). Everything the owner can dial up for a
 * build week without touching the Monday cron's behaviour: `override > setting > constant`. The
 * constant tier is `SETTINGS_DEFAULTS` — `Settings.get` already falls back to it when no row
 * exists, and its four `sourcing.*` values are exactly today's hardcoded numbers (a test in
 * `sourcing-knobs.test.ts` pins them to `DEFAULT_MAX_WINNERS` / `CANDIDATE_TARGET` /
 * `HARVEST_MAX_PAGES_TOTAL` / `SOURCING_MAX_BUDGET_USD` so the two can never drift). So a run with
 * neither an override nor a settings row behaves bit-for-bit as it did before this module existed.
 */
import type { Settings } from '../settings.ts'
import { HARVEST_KEYWORDS } from './harvest.ts'

/** One run's CLI/caller overrides. Every field is optional; absent means "fall through". */
export interface SourcingOverrides {
  keywords?: string[]
  maxWinners?: number
  maxBudgetUsd?: number
  candidateTarget?: number
  maxPages?: number
}

/** The fully resolved knobs for one run — threaded as ONE object down the pipeline. */
export type SourcingKnobs = Required<Omit<SourcingOverrides, 'keywords'>> & {
  keywords: readonly string[]
  /** No override tier: setting > constant only (spec 2026-09-01 market-price Decision 6). */
  maxPriceToMarketBps: number
}

/** Hard ceiling on a `--keywords` override. More than this and one run's CJ page budget is spread
 * so thin that every pass gets one page — an owner typo, not an intent. */
export const MAX_OVERRIDE_KEYWORDS = 8

/**
 * Sanity range per numeric knob, checked against the RESOLVED value regardless of where it came
 * from. Deliberately a throw rather than a silent clamp for BOTH sources: a nonsense override is a
 * typo the operator must see before a real run starts, and a nonsense setting is an owner mistake
 * on /admin/settings that would otherwise quietly change every weekly run for weeks.
 */
export const SOURCING_KNOB_RANGES = {
  maxWinners: { min: 1, max: 12, integer: true },
  // Floor is MIN_CANDIDATES: below it every harvest would short-circuit as `no_candidates`.
  candidateTarget: { min: 3, max: 80, integer: true },
  maxPages: { min: 1, max: 40, integer: true },
  maxBudgetUsd: { min: 0.5, max: 10, integer: false },
  // 10000 (never above market) .. 20000 (2x market) — outside that is an owner typo, not intent.
  maxPriceToMarketBps: { min: 10_000, max: 20_000, integer: true },
} as const

type NumericKnob = keyof typeof SOURCING_KNOB_RANGES

/** `label` names the SOURCE of the value (the CLI flag or the settings key) so the thrown message
 * points the owner straight at the thing they have to fix. */
function checkRange(knob: NumericKnob, value: number, label: string): number {
  const { min, max, integer } = SOURCING_KNOB_RANGES[knob]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`sourcing knob ${knob} (${label}) must be a number, got ${JSON.stringify(value)}`)
  }
  if (integer && !Number.isInteger(value)) {
    throw new Error(`sourcing knob ${knob} (${label}) must be a whole number, got ${value}`)
  }
  if (value < min || value > max) {
    throw new Error(`sourcing knob ${knob} (${label}) must be between ${min} and ${max}, got ${value}`)
  }
  return value
}

/**
 * Trims, drops empties, dedupes case-insensitively (first occurrence wins, so the operator's own
 * casing survives), and enforces the ≤ 8 cap on what is LEFT — `"dog,Dog"` is one keyword, not two,
 * and must not eat two of the eight slots or two round-robin harvest passes over the same results.
 *
 * Returns null when nothing survives, so a PROGRAMMATIC caller falls back to `HARVEST_KEYWORDS`
 * rather than harvesting nothing at all. `parseRunSourcingArgs` deliberately does NOT accept that
 * fallback: a human who typed `--keywords` meant to steer the run, and silently reverting them to
 * the default five is the wrong answer to `--keywords ","`.
 */
export function normalizeKeywords(raw: readonly string[]): string[] | null {
  const seen = new Set<string>()
  const cleaned: string[] = []
  for (const entry of raw) {
    const trimmed = entry.trim()
    if (trimmed.length === 0) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    cleaned.push(trimmed)
  }
  if (cleaned.length > MAX_OVERRIDE_KEYWORDS) {
    throw new Error(`--keywords accepts at most ${MAX_OVERRIDE_KEYWORDS} keywords, got ${cleaned.length}`)
  }
  return cleaned.length > 0 ? cleaned : null
}

/**
 * Resolves one run's knobs: an explicit override wins, else the `sourcing.*` setting, else the
 * module constant. Throws (never clamps) on anything out of range — see SOURCING_KNOB_RANGES.
 * `keywords` has no setting: it is a per-run CLI concern only, so it is either the override or
 * `HARVEST_KEYWORDS`.
 */
export async function resolveSourcingKnobs(settings: Settings, overrides?: SourcingOverrides): Promise<SourcingKnobs> {
  const keywordOverride = overrides?.keywords ? normalizeKeywords(overrides.keywords) : null

  /** override (labelled by its CLI flag) > setting (labelled by its settings key); both range-checked. */
  function pick(knob: NumericKnob, override: number | undefined, flag: string, settingValue: number, settingKey: string): number {
    return override !== undefined
      ? checkRange(knob, override, `${flag} override`)
      : checkRange(knob, settingValue, `setting ${settingKey}`)
  }

  const [maxWinners, candidateTarget, maxPages, maxBudgetCents, maxPriceToMarketBps] = await Promise.all([
    settings.get('sourcing.max_winners'),
    settings.get('sourcing.candidate_target'),
    settings.get('sourcing.max_pages'),
    settings.get('sourcing.max_budget_cents'),
    settings.get('sourcing.max_price_to_market_bps'),
  ])

  return {
    keywords: keywordOverride ?? HARVEST_KEYWORDS,
    maxWinners: pick('maxWinners', overrides?.maxWinners, '--max-winners', maxWinners, 'sourcing.max_winners'),
    candidateTarget: pick('candidateTarget', overrides?.candidateTarget, '--candidates', candidateTarget, 'sourcing.candidate_target'),
    maxPages: pick('maxPages', overrides?.maxPages, '--pages', maxPages, 'sourcing.max_pages'),
    // The setting is CENTS (every money setting in SETTINGS_DEFAULTS is), the knob is USD.
    maxBudgetUsd: pick('maxBudgetUsd', overrides?.maxBudgetUsd, '--budget', maxBudgetCents / 100, 'sourcing.max_budget_cents'),
    maxPriceToMarketBps: checkRange('maxPriceToMarketBps', maxPriceToMarketBps, 'setting sourcing.max_price_to_market_bps'),
  }
}

const USAGE =
  'usage: run-sourcing [--force] [--keywords "a,b,c"] [--max-winners N] [--budget USD] [--candidates N] [--pages N]'

const NUMERIC_FLAGS = {
  '--max-winners': 'maxWinners',
  '--budget': 'maxBudgetUsd',
  '--candidates': 'candidateTarget',
  '--pages': 'maxPages',
} as const satisfies Record<string, Exclude<keyof SourcingOverrides, 'keywords'>>

/**
 * Pure argv parser for `scripts/run-sourcing.ts` (kept here, next to the knobs it produces, so it
 * is unit-testable — importing the script itself would execute it). Accepts both `--flag value`
 * and `--flag=value`. Anything unrecognised throws with the usage line rather than being silently
 * ignored: a typo'd flag on a real, credential-gated run must not quietly fall back to defaults.
 */
export function parseRunSourcingArgs(argv: readonly string[]): { force: boolean; overrides: SourcingOverrides } {
  let force = false
  const overrides: SourcingOverrides = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    const eq = arg.indexOf('=')
    const flag = eq === -1 ? arg : arg.slice(0, eq)
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1)

    if (!flag.startsWith('--')) {
      throw new Error(`run-sourcing: unexpected argument ${arg}\n${USAGE}`)
    }

    if (flag === '--force') {
      force = true
      continue
    }

    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`run-sourcing: ${flag} needs a value\n${USAGE}`)
      }
      i += 1
      return next
    }

    if (flag === '--keywords') {
      const raw = takeValue()
      const keywords = normalizeKeywords(raw.split(','))
      if (!keywords) {
        throw new Error(`run-sourcing: --keywords was given but contains no keywords ("${raw}")\n${USAGE}`)
      }
      overrides.keywords = keywords
      continue
    }

    const knob = (NUMERIC_FLAGS as Record<string, Exclude<keyof SourcingOverrides, 'keywords'> | undefined>)[flag]
    if (!knob) {
      throw new Error(`run-sourcing: unknown flag ${flag}\n${USAGE}`)
    }
    const raw = takeValue()
    const value = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(value)) {
      throw new Error(`run-sourcing: ${flag} needs a number, got "${raw}"\n${USAGE}`)
    }
    overrides[knob] = value
  }

  return { force, overrides }
}

/** One-line summary of the resolved knobs, printed at the start of a manual run. */
export function describeSourcingKnobs(knobs: SourcingKnobs): string {
  return [
    `keywords=[${knobs.keywords.join(', ')}]`,
    `maxWinners=${knobs.maxWinners}`,
    `candidateTarget=${knobs.candidateTarget}`,
    `maxPages=${knobs.maxPages}`,
    `maxBudgetUsd=${knobs.maxBudgetUsd}`,
    `maxPriceToMarketBps=${knobs.maxPriceToMarketBps}`,
  ].join(' ')
}
