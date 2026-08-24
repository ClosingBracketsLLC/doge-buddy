# Phase 5: Sourcing Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A weekly, budget-capped agent run that turns CJ trending data + trend validation into ≤3 ready-to-approve `new_listing` proposals, with every guard from the reviewed spec.

**Architecture:** Four-stage pipeline in `apps/ops`: plain-code harvest (CJ trending/new → `sourcing_signals` + dedupe → ≤15 candidates) → plain-code trend validation (SerpApi behind a `TrendsProvider` interface) → one Claude Agent SDK `query()` run with read-only MCP tools → plain-code validation/submission through the existing `submitProposal` gate. An atomic day-claim breaker, streaming cost accounting, and an orphan sweep make the money path race-free and crash-honest.

**Tech Stack:** Fastify 5, pg-boss 10, drizzle-orm, zod v4, `@anthropic-ai/claude-agent-sdk` (pinned exact), vitest against real Postgres (`postgres://doge:doge@localhost:5433/doge_buddy`).

**Spec:** `docs/superpowers/specs/2026-08-24-phase-5-sourcing-agent-design.md` (review-hardened 2026-08-24; where this plan and the spec disagree, the spec wins). Parent CJ wire truths: `docs/cj-api-notes.md`.

## Global Constraints

- **Zero migrations.** All tables exist in migration 0000 (`agent_runs`, `agent_run_events`, `agent_sessions`, `sourcing_signals`, `product_scores`). No schema changes, no new indexes.
- **SDK pinned exact:** `"@anthropic-ai/claude-agent-sdk": "0.3.241"` (no `^`/`~`). The installed `sdk.d.ts` is authoritative over docs when they disagree.
- **SDK options (spec §Stage 3):** model `claude-sonnet-5`; `maxTurns: 25`; `maxBudgetUsd: 2.00` (stop-loss); `settingSources: []`; `permissionMode: 'dontAsk'`; **`tools: ['WebSearch', 'WebFetch']`** (availability — NEVER `tools: []`, which strips web research and `allowedTools` cannot restore it); `allowedTools: ['mcp__sourcing__*', 'WebSearch', 'WebFetch']`; `persistSession: false`; own `systemPrompt` string; `env: { ...process.env, MCP_TOOL_TIMEOUT: '60000' }` (the `env` option REPLACES the subprocess env — always spread `process.env`).
- **Money rails:** CJ points allowance 25,000/run (in-run counter — `CjHttpClient`'s daily ledger stays untouched); SerpApi ≤10 requests/run; the agent NEVER holds a side-effecting tool — proposals are submitted by plain code only.
- **Margin formula (spec §Stage 4.7, mirrors `plan.ts:170`):** `Math.floor(((priceCents − supplierCostCents − freightCents) * 10_000) / priceCents) >= marginFloorBps` where `marginFloorBps` reads settings key `'fulfillment.margin_floor_bps'` (default 6000). Integer bps, floored, never rounded.
- **Guards reject, never rewrite.** Category/claims/HTML checks drop the winner with an alert; nothing is auto-corrected.
- **`sourcing.weekly` job semantics:** `retryLimit: 0`, `expireInSeconds: 3600`, cron `'0 13 * * 1'`, registration gated on `config.anthropic` with a loud boot log either way.
- **House idioms bind:** deps-object injection; `alert(severity, kind, detail)` calls always `.catch(() => {})` at call sites where a throw would break the caller; audit_log rows use actor `'system'`/`'owner'`, dotted actions, entityType/entityId; admin HTML only through the `html`/`esc`/`raw` helpers; `safeHandle` on every admin route.
- **Tests run against real Postgres** (`pnpm db:up` first); every task runs its suite with `set -o pipefail` before committing. Never commit on a red suite.
- **Secrets:** `ANTHROPIC_API_KEY`/`SERPAPI_KEY` live only in gitignored `.env` — never in fixtures, test files, or committed code.

---

### Task 1: `searchProducts` flag parameter (`trending` → `flag`)

**Files:**
- Modify: `packages/supplier/src/types.ts` (SupplierAdapter.searchProducts query type)
- Modify: `packages/supplier/src/adapters/cj/adapter.ts` (productFlag mapping)
- Modify: `packages/supplier/src/adapters/mock/` (mock searchProducts signature)
- Modify: any caller found by `grep -rn "trending" packages/ apps/ --include="*.ts"` (tests included)
- Test: `packages/supplier/test/` (extend the existing searchProducts unit tests)

**Interfaces:**
- Consumes: existing `SupplierProductSummary`, `CjHttpClient`.
- Produces: `searchProducts(q: { keyword?: string; categoryId?: string; countryCode?: string; flag?: 'trending' | 'new'; page?: number; pageSize?: number; minPriceCents?: number; maxPriceCents?: number })` — the `trending?: boolean` field is REMOVED, not kept alongside. Tasks 9's harvest calls `flag: 'trending'` and `flag: 'new'`.

- [ ] **Step 1: Write the failing test** — in the existing CJ adapter unit test file (find it via `grep -rln "searchProducts" packages/supplier/test`), following its existing mock-http pattern:

```ts
it('maps flag "trending" to productFlag 0 and "new" to productFlag 1', async () => {
  const calls: Record<string, string>[] = []
  const adapter = makeAdapterWithHttpSpy(calls) // reuse the file's existing spy helper for GET params
  await adapter.searchProducts({ flag: 'trending' })
  await adapter.searchProducts({ flag: 'new' })
  await adapter.searchProducts({})
  expect(calls[0].productFlag).toBe('0')
  expect(calls[1].productFlag).toBe('1')
  expect(calls[2].productFlag).toBeUndefined()
})
```

- [ ] **Step 2: Run it** — `pnpm --filter @doge-buddy/supplier test 2>&1 | tail -20` (with `set -o pipefail`). Expected: FAIL — `flag` not a known property / productFlag never `'1'`.
- [ ] **Step 3: Implement** — in `types.ts` replace `trending?: boolean` with `flag?: 'trending' | 'new'`. In the CJ adapter, replace the `productFlag: q.trending ? 0 : undefined` expression with:

```ts
productFlag: q.flag === 'trending' ? 0 : q.flag === 'new' ? 1 : undefined,
```

Update the mock adapter's signature identically (its behavior may ignore the flag). Fix every compile error the removal surfaces — those are the callers.
- [ ] **Step 4: Run the full supplier + ops suites** — both green. `pnpm --filter @doge-buddy/supplier test` and `pnpm --filter @doge-buddy/ops test`.
- [ ] **Step 5: Commit** — `git commit -m "feat(supplier): searchProducts flag param — trending|new (CJ productFlag 0|1)"`

---

### Task 2: `getProductReviews` adapter method

**Files:**
- Modify: `packages/supplier/src/types.ts`
- Modify: `packages/supplier/src/adapters/cj/adapter.ts`
- Modify: `packages/supplier/src/adapters/mock/` (parity)
- Modify: `packages/supplier/test/` (unit + a live-harness contract case)
- Modify: `docs/cj-api-notes.md` (record the wire shape as UNVERIFIED until the contract case runs live)

**Interfaces:**
- Produces (types.ts, on `SupplierAdapter`):

```ts
export interface SupplierProductReview {
  rating: number // 1-5
  content: string
  reviewDate?: string
  countryCode?: string
}
// on SupplierAdapter:
getProductReviews(supplierProductId: string, q?: { page?: number; pageSize?: number }): Promise<SupplierProductReview[]>
```

- CJ wire (per CJ docs, **unverified** — the contract harness proves it): `GET /product/productComments` with `pid`, `pageNum` (default 1), `pageSize` (default 20, cap 50). Treat the response defensively like `listV2` (CJ nests and renames freely): accept `data.list`, `data.content`, or `data` as the array; map `score|commentScore → rating` (Number, clamp 1–5, default 5 when absent), `comment|commentText|content → content` (String, default ''), `commentDate|createDate → reviewDate`, `countryCode → countryCode`. Points cost: assume 10 until the live run proves otherwise (record actual in cj-api-notes).

- [ ] **Step 1: Write the failing unit test** (mock-http pattern of the file):

```ts
it('getProductReviews maps CJ comment rows defensively', async () => {
  const adapter = makeAdapterReturning({ data: { list: [
    { score: 4, comment: 'good boy approved', commentDate: '2026-08-01' },
    { commentScore: '5', commentText: 'sturdy' },
  ] } })
  const reviews = await adapter.getProductReviews('1952308304475578369')
  expect(reviews).toEqual([
    { rating: 4, content: 'good boy approved', reviewDate: '2026-08-01', countryCode: undefined },
    { rating: 5, content: 'sturdy', reviewDate: undefined, countryCode: undefined },
  ])
})
```

- [ ] **Step 2: Run it** — FAIL (`getProductReviews is not a function`).
- [ ] **Step 3: Implement** — CJ adapter method via the existing `this.http.get` helper (mirror `getVariantStock`'s shape), path `product/productComments`, params `{ pid: supplierProductId, pageNum: q?.page ?? 1, pageSize: q?.pageSize ?? 20 }`, points 10. Mock adapter: return two canned reviews for any known pid, `[]` otherwise. Add a `CJ_CONTRACT`-gated case to the live harness (same skip pattern as the others) calling it against `CJ_CONTRACT_PID ?? '1952308304475578369'` and asserting only `Array.isArray` (shape gets recorded, not assumed). Append to `docs/cj-api-notes.md` §Still unverified: "product/productComments request/response shape + points cost — contract case exists, run live in Phase 5 Tier 2."
- [ ] **Step 4: Run both suites green.**
- [ ] **Step 5: Commit** — `git commit -m "feat(supplier): getProductReviews (CJ productComments, defensively mapped)"`

---

### Task 3: `subscribeProductWebhook` adapter method

**Files:**
- Modify: `packages/supplier/src/types.ts`
- Modify: `packages/supplier/src/adapters/cj/adapter.ts`
- Modify: `packages/supplier/src/adapters/mock/` (parity — records calls for tests)
- Test: `packages/supplier/test/` (unit + `CJ_CONTRACT`-gated live case)
- Modify: `docs/cj-api-notes.md` (§Still unverified entry)

**Interfaces:**
- Produces (on `SupplierAdapter`): `subscribeProductWebhook(supplierProductId: string): Promise<void>` — best-effort semantics are the CALLER's job (Task 16 wraps it); the adapter throws on wire failure like every other method.
- CJ wire (**unverified**, from the Phase 4A deferral name): `POST /webhook/product/subscribe` body `{ productIdList: [supplierProductId] }`. If Tier 2 reveals product webhooks are account-level (via `/webhook/set`), the method body becomes a documented no-op — that ruling belongs to whoever runs Tier 2, recorded in cj-api-notes.

- [ ] **Step 1: Failing unit test** — spy on POST path + body:

```ts
it('subscribeProductWebhook posts the pid list', async () => {
  const calls: { path: string; body: unknown }[] = []
  const adapter = makeAdapterWithPostSpy(calls)
  await adapter.subscribeProductWebhook('1952308304475578369')
  expect(calls[0].path).toBe('webhook/product/subscribe')
  expect(calls[0].body).toEqual({ productIdList: ['1952308304475578369'] })
})
```

- [ ] **Step 2: Run it** — FAIL.
- [ ] **Step 3: Implement** — CJ adapter via `this.http.post` (mirror an existing POST method's shape; points 0 — webhook config calls are not quota'd per cj-api-notes; if the live run disproves that, record it). Mock adapter: push the pid onto a public `subscribedProductIds: string[]` array (tests in Task 16 read it). Live-harness case: subscribe the test pid, assert no throw. cj-api-notes §Still unverified: "webhook/product/subscribe endpoint/body/points — could be account-level via /webhook/set; verify in Phase 5 Tier 2."
- [ ] **Step 4: Suites green.**
- [ ] **Step 5: Commit** — `git commit -m "feat(supplier): subscribeProductWebhook (wire unverified until Tier 2)"`

---

### Task 4: Config — `anthropic` + `serpapi` blocks

**Files:**
- Modify: `apps/ops/src/config.ts`
- Modify: `apps/ops/src/index.ts` (loud boot logs)
- Test: `apps/ops/test/config.test.ts` (extend the existing config tests)

**Interfaces:**
- Produces: `config.anthropic?: { apiKey: string }` and `config.serpapi?: { apiKey: string }` — each present iff its env var is a non-empty string. Task 7 gates the trends stage on `config.serpapi`; Task 14 gates cron registration on `config.anthropic`.

- [ ] **Step 1: Failing tests** (follow the existing config test file's env-building pattern exactly):

```ts
it('anthropic block present iff ANTHROPIC_API_KEY set', () => {
  expect(loadConfig(baseEnv()).anthropic).toBeUndefined()
  expect(loadConfig({ ...baseEnv(), ANTHROPIC_API_KEY: 'sk-ant-x' }).anthropic).toEqual({ apiKey: 'sk-ant-x' })
})
it('serpapi block present iff SERPAPI_KEY set', () => {
  expect(loadConfig(baseEnv()).serpapi).toBeUndefined()
  expect(loadConfig({ ...baseEnv(), SERPAPI_KEY: 'serp-x' }).serpapi).toEqual({ apiKey: 'serp-x' })
})
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — `EnvSchema`: `ANTHROPIC_API_KEY: z.string().min(1).optional()`, `SERPAPI_KEY: z.string().min(1).optional()`; map to the optional blocks in the returned config (mirror how the CJ block is built). In `index.ts`, next to the existing supplier-adapter boot log, add:

```ts
if (config.anthropic) app.log.info('sourcing agent: ANTHROPIC_API_KEY configured')
else app.log.warn('sourcing agent DISABLED: ANTHROPIC_API_KEY not set — sourcing.weekly cron will not register')
if (config.serpapi) app.log.info('sourcing agent: SERPAPI_KEY configured (trends stage armed)')
else app.log.warn('sourcing trends stage disabled: SERPAPI_KEY not set — runs proceed without google_trends signals')
```

- [ ] **Step 4: Ops suite green.**
- [ ] **Step 5: Commit** — `git commit -m "feat(ops): optional anthropic + serpapi config blocks with loud boot logs"`

---

### Task 5: `registerCron` options parameter

**Files:**
- Modify: `apps/ops/src/queue.ts` (`registerCron`, and thread options through `createQueueRetrying` if it doesn't already accept queue options)
- Test: `apps/ops/test/queue.test.ts` (or the file that currently tests `registerCron` — find via `grep -rln registerCron apps/ops/test`)

**Interfaces:**
- Produces:

```ts
export interface CronJobOptions {
  retryLimit?: number
  expireInSeconds?: number
}
export async function registerCron<ReqData extends object = object>(
  boss: PgBoss,
  name: string,
  cron: string,
  handler: PgBoss.WorkHandler<ReqData>,
  opts?: CronJobOptions,
): Promise<void>
```

- Omitted opts = today's behavior exactly (existing cron registrations don't change). With opts, the queue is created/updated with them: pg-boss 10's `createQueue(name, { name, retryLimit, expireInSeconds })` — and since `createQueueRetrying` may already have created the queue with defaults (idempotent create), when opts are provided call `boss.updateQueue(name, { ...opts })` after create so the settings stick even for a pre-existing queue. Verify the exact `updateQueue` signature against `node_modules/pg-boss` typings before writing it.

- [ ] **Step 1: Failing test** — against the real pg-boss instance the existing queue tests use:

```ts
it('registerCron with options pins retryLimit and expiration on the queue', async () => {
  await registerCron(boss, 'test.cron-opts', '0 13 * * 1', async () => {}, { retryLimit: 0, expireInSeconds: 3600 })
  const q = await boss.getQueue('test.cron-opts')
  expect(q?.retryLimit).toBe(0)
  expect(q?.expireInSeconds).toBe(3600)
})
```

- [ ] **Step 2: Run** — FAIL (options param doesn't exist; queue has default retryLimit).
- [ ] **Step 3: Implement** per the interface above.
- [ ] **Step 4: Ops suite green.**
- [ ] **Step 5: Commit** — `git commit -m "feat(ops): registerCron options — retryLimit/expireInSeconds per cron queue"`

---

### Task 6: Guards module — category exclusions, claims list, HTML allowlist

**Files:**
- Create: `apps/ops/src/sourcing/guards.ts`
- Test: `apps/ops/test/sourcing-guards.test.ts`

**Interfaces (produces — Tasks 9, 12, 13, 15 consume these exact names):**

```ts
export const EXCLUDED_CATEGORY_TERMS: readonly string[]
export const CLAIM_TERMS: readonly string[]
/** Case-insensitive substring match over the given text fields. Returns the matched term or null. */
export function matchExcludedCategory(...texts: (string | null | undefined)[]): string | null
/** Case-insensitive scan for disallowed claim phrases. Returns every matched term (empty = clean). */
export function findClaimViolations(...texts: (string | null | undefined)[]): string[]
/** Strips tags/entities to plain text for guard scans (no sanitizing — scanning only). */
export function htmlToText(html: string): string
/** Allowlist validator per spec §Stage 4.3. Returns null when valid, else a human-readable reason. */
export function validateDescriptionHtml(html: string): string | null
```

Constants (hardcoded, from the spec's day-one list — extend, don't trim):

```ts
export const EXCLUDED_CATEGORY_TERMS = [
  'supplement', 'vitamin', 'cbd', 'hemp', 'flea', 'tick', 'dewormer', 'medicated',
  'medicine', 'antibiotic', 'pharmaceutical', 'treat', 'treats', 'food', 'edible',
  'chew', 'consumable', 'calming', 'anxiety', 'probiotic', 'oil drops',
] as const
export const CLAIM_TERMS = [
  'cures', 'cure ', 'treats ', 'treatment', 'heals', 'therapeutic', 'anxiety relief',
  'vet approved', 'vet recommended', 'fda', 'clinically proven', 'medical grade',
  'pain relief', 'antibacterial', 'antimicrobial', 'hypoallergenic',
] as const
```

`validateDescriptionHtml` rules (reject, never rewrite): allowed tags exactly `p, br, ul, ol, li, strong, em, h2, h3`; ANY other tag (script/style/iframe/object/embed/svg/form/img/a included — links and images live in `imageUrls`, not the body) → invalid; any attribute at all on any tag → invalid (simplest safe rule — the allowlisted tags need no attributes); any occurrence of `javascript:` or `data:` (case-insensitive) anywhere → invalid. Implement with a tag-scanning regex over `/<\s*\/?\s*([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g` — group 1 must be allowlisted, group 2 must be empty or whitespace after trimming a trailing `/`. Word-boundary care in matchers: match `'treat'` via the padded forms in CLAIM_TERMS (`'treats '`, `'treat '`... note EXCLUDED_CATEGORY_TERMS deliberately includes both bare and padded variants); do NOT build clever stemming — literal lowercase `includes` per term is the whole matcher.

- [ ] **Step 1: Failing tests** — the exhaustive matrix:

```ts
describe('guards', () => {
  it('matchExcludedCategory hits on any text field, case-insensitively', () => {
    expect(matchExcludedCategory('Dog CALMING Bed', 'Beds')).toBe('calming')
    expect(matchExcludedCategory('Rope Toy', 'Pet Toys')).toBeNull()
    expect(matchExcludedCategory(undefined, 'Flea & Tick Collar')).toBe('flea')
  })
  it('findClaimViolations returns every hit', () => {
    expect(findClaimViolations('Vet Approved shampoo', '<p>clinically proven pain relief</p>')).toEqual(
      expect.arrayContaining(['vet approved', 'clinically proven', 'pain relief']),
    )
    expect(findClaimViolations('Durable rope toy for strong chewers... just kidding, tug rope')).toEqual([])
  })
  it('htmlToText strips tags for scanning', () => {
    expect(htmlToText('<p>anxiety <strong>relief</strong></p>')).toBe('anxiety relief')
  })
  describe('validateDescriptionHtml', () => {
    it.each([
      ['<p>Good <strong>toy</strong></p><ul><li>durable</li></ul>', null],
      ['<h2>Specs</h2><p>10cm</p>', null],
    ])('accepts %s', (html, expected) => expect(validateDescriptionHtml(html)).toBe(expected))
    it.each([
      '<script>alert(1)</script>',
      '<p onclick="x">hi</p>',
      '<img src="x">',
      '<a href="javascript:alert(1)">x</a>',
      '<p>see data:text/html;base64,x</p>',
      '<iframe src="https://x"></iframe>',
      '<P STYLE="x">shout</P>',
    ])('rejects %s', (html) => expect(validateDescriptionHtml(html)).not.toBeNull())
  })
})
```

- [ ] **Step 2: Run** — FAIL (module doesn't exist).
- [ ] **Step 3: Implement** per the interface block above. `htmlToText`: strip tags with `.replace(/<[^>]*>/g, ' ')`, decode `&amp; &lt; &gt; &quot; &#39; &nbsp;`, collapse whitespace.
- [ ] **Step 4: Ops suite green.**
- [ ] **Step 5: Commit** — `git commit -m "feat(ops): sourcing guards — category exclusions, claims scan, descriptionHtml allowlist"`

---

### Task 7: `TrendsProvider` + SerpApi adapter

**Files:**
- Create: `apps/ops/src/sourcing/trends.ts`
- Test: `apps/ops/test/sourcing-trends.test.ts`

**Interfaces (produces):**

```ts
export interface TrendSignal {
  keyword: string
  /** 0-100 mean interest over the window, or null when SerpApi returned nothing for the term */
  score: number | null
  snapshot: Record<string, unknown>
}
export interface TrendsProvider {
  readonly key: string // 'serpapi' now; 'google_trends_alpha' later
  fetchInterest(keywords: string[]): Promise<TrendSignal[]>
}
export const SERPAPI_MAX_REQUESTS_PER_RUN = 10
export function createSerpApiTrends(deps: {
  apiKey: string
  fetchFn?: typeof fetch // injection seam for tests; default globalThis.fetch
}): TrendsProvider
```

Behavior: batch keywords 5 at a time (SerpApi TIMESERIES limit) into `GET https://serpapi.com/search?engine=google_trends&data_type=TIMESERIES&q=<comma-joined>&date=today 3-m&api_key=...` (URL-encode; the api_key never appears in any log or error message — wrap fetch errors with a scrubbed message). A run-scoped counter refuses request #11 by returning the remaining keywords as `score: null` signals (no throw). Score = mean of each keyword's `interest_over_time.timeline_data[].values[]` value (SerpApi returns per-keyword series when multiple `q` terms are passed; map defensively, `null` when the series is absent). Snapshot = the per-keyword series slice, NOT the whole response.

- [ ] **Step 1: Failing tests** — inject `fetchFn` returning canned SerpApi JSON: (a) 7 keywords → exactly 2 requests, comma-joined 5 + 2; (b) scores averaged correctly against a fixture with two timeline points; (c) request cap: with 60 keywords, exactly 10 requests fired and the tail keywords come back `score: null`; (d) a fetch rejection produces `score: null` signals for that batch and the error message does NOT contain the api key.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** per above.
- [ ] **Step 4: Ops suite green.**
- [ ] **Step 5: Commit** — `git commit -m "feat(ops): TrendsProvider interface + SerpApi google_trends adapter (10-req cap)"`

---

### Task 8: Pricing constants + streaming usage accumulator

**Files:**
- Create: `apps/ops/src/agents/pricing.ts`
- Test: `apps/ops/test/agents-pricing.test.ts`

**Interfaces (produces — Task 12 consumes):**

```ts
export const MODEL_PRICING_USD_PER_MTOK: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
}
export interface UsageTally {
  perModel: Record<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }>
  estimatedCostUsd: number
}
export function createUsageAccumulator(): {
  /** Feed every SDK assistant message; unknown models tally tokens at claude-sonnet-5 rates (conservative). */
  add(message: { message: { model?: string; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } }): void
  tally(): UsageTally
}
```

`estimatedCostUsd` = Σ per model of `(input×p.input + output×p.output + cacheRead×p.cacheRead + cacheWrite×p.cacheWrite) / 1_000_000`, recomputed in `tally()`.

- [ ] **Step 1: Failing tests** — (a) two messages for claude-sonnet-5 (1000 in / 500 out / 2000 cacheRead each) → tokens summed, `estimatedCostUsd` = `2 × (1000×3 + 500×15 + 2000×0.3) / 1e6` exactly; (b) message with no usage → no-op; (c) unknown model tallies under its own key at sonnet rates.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Suite green.**
- [ ] **Step 5: Commit** — `git commit -m "feat(ops): agent pricing constants + streaming usage accumulator"`

---

### Task 9: Harvest — CJ passes, signals, dedupe, ranking, short-circuit

**Files:**
- Create: `apps/ops/src/sourcing/harvest.ts`
- Test: `apps/ops/test/sourcing-harvest.test.ts` (real Postgres; mock supplier adapter)

**Interfaces (produces):**

```ts
export interface HarvestCandidate {
  supplierProductId: string
  title: string
  categoryName: string | null
  sellPriceCents: number | null
  listedNum: number | null
  imageUrl: string | null
}
export const HARVEST_MAX_PAGES_TOTAL = 10
export const CANDIDATE_TARGET = 15
export const MIN_CANDIDATES = 3
export interface HarvestDeps {
  db: Db // same Db type alias the proposals modules use
  adapter: Pick<SupplierAdapter, 'searchProducts'>
  alert: Alert
  now?: () => Date
}
/** Runs both CJ passes, appends sourcing_signals, filters + ranks. */
export function runHarvest(deps: HarvestDeps): Promise<{ candidates: HarvestCandidate[]; pagesFetched: number }>
```

Behavior, in order:
1. Pass A `flag: 'trending'`, pass B `flag: 'new'`, `pageSize: 50`, pages alternating A1,B1,A2,B2… until `HARVEST_MAX_PAGES_TOTAL` pages total or both passes return an empty page. A thrown `searchProducts` page (CJ 429/5xx) alerts (`warning`, `sourcing_harvest_page_failed`, `{ pass, page, error }`) and ends THAT pass only — partial harvest is fine.
2. Every summary row (deduped by `supplierProductId` within the run) inserts one `sourcing_signals` row: `source: 'cj_trending'`, `supplierProductId`, `keyword: null`, `score: listedNum ?? null`, `snapshot`: the raw summary. Plain insert — the table is append-only.
3. Filter (spec §Stage 1, exact order):
   a. drop pids present in `supplier_variant_mappings` (`select distinct supplierProductId`);
   b. drop pids appearing in `proposals` rows where `type = 'new_listing'` AND (`status IN ('pending','approved','failed')` at any age OR (`status IN ('rejected','expired')` AND `decidedAt`/`updatedAt` within 90 days)) — extract the pid via SQL over the jsonb payload: `payload -> 'variants' -> 0 ->> 'supplierProductId'` (one query, `IN` list built in code is fine at this scale);
   c. drop rows where `matchExcludedCategory(title, categoryName)` hits (Task 6).
4. Rank survivors: `listedNum` descending, nulls last; tiebreak `sellPriceCents` ascending; take `CANDIDATE_TARGET`.

The SHORT-CIRCUIT (`< MIN_CANDIDATES`) is the ORCHESTRATOR's decision (Task 14) — harvest just returns what it found.

- [ ] **Step 1: Failing tests** (seed real DB rows; stub adapter returning canned summaries):
  - dedupe matrix: a pid in mappings, a pid in a pending proposal, a pid in a 30-day-old rejected proposal, a pid in a 100-day-old rejected proposal (SURVIVES), a title hitting 'calming' (dropped), a categoryName hitting 'Flea' (dropped), a clean survivor.
  - signals written: one row per unique pid fetched, `source 'cj_trending'`.
  - page-failure: pass A throws on page 2 → alert fired, pass B pages still fetched, candidates still returned.
  - ranking: listedNum ordering + 15-cap.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Ops suite green** (watch for dirty-DB rerun contamination — clean up seeded proposals/mappings/signals in afterEach, the fulfillment suite precedent).
- [ ] **Step 5: Commit** — `git commit -m "feat(ops): sourcing harvest — dual CJ pass, signals, dedupe matrix, ranking"`

---

### Task 10: Points allowance + the `sourcing` MCP server

**Files:**
- Create: `apps/ops/src/agents/points.ts`
- Create: `apps/ops/src/agents/mcp-tools.ts`
- Modify: `apps/ops/package.json` (add `"@anthropic-ai/claude-agent-sdk": "0.3.241"` — exact pin, no range; run `pnpm install`)
- Test: `apps/ops/test/agents-mcp-tools.test.ts`

**Interfaces (produces):**

```ts
// points.ts
export const SOURCING_POINTS_ALLOWANCE = 25_000
export class PointsAllowance {
  constructor(total?: number)
  /** Throws PointsAllowanceExceededError when spend would cross the total. */
  spend(points: number, what: string): void
  spent(): number
  remaining(): number
}
export class PointsAllowanceExceededError extends Error {}

// mcp-tools.ts
export const TOOL_POINT_COSTS = { get_product_detail: 10, get_reviews: 10, get_stock: 10, quote_freight: 10 } as const
export function createSourcingMcpServer(deps: {
  adapter: Pick<SupplierAdapter, 'getProduct' | 'getProductReviews' | 'getVariantStock' | 'quoteShipping'>
  allowance: PointsAllowance
}): ReturnType<typeof createSdkMcpServer>
```

Four `tool()` definitions (zod v4 raw shapes), each handler:
1. calls `allowance.spend(cost, name)` FIRST — on `PointsAllowanceExceededError` return `{ content: [{ type: 'text', text: 'CJ points allowance exhausted for this run — conclude with the research you already have.' }], isError: true }` (never throw);
2. calls the adapter method in try/catch — any error returns `isError: true` with a scrubbed message (`String(err instanceof Error ? err.message : err)` — CJ errors don't carry secrets, but never serialize whole error objects);
3. returns the result as `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`.

Tool schemas:

```ts
tool('get_product_detail', 'Full CJ product detail: title, description, variants with costs, images.',
  { supplierProductId: z.string().min(1) }, handler)
tool('get_reviews', 'Buyer reviews for a CJ product (rating 1-5 + text).',
  { supplierProductId: z.string().min(1), page: z.number().int().min(1).optional() }, handler)
tool('get_stock', 'Per-warehouse stock for a CJ variant.',
  { supplierVariantId: z.string().min(1) }, handler)
tool('quote_freight', 'US shipping options (price cents + day range) for a CJ variant, qty 1.',
  { supplierVariantId: z.string().min(1) }, handler) // wraps quoteShipping({ fromCountry: 'CN', toCountry: 'US', items: [{ supplierVariantId, quantity: 1 }] })
```

Server: `createSdkMcpServer({ name: 'sourcing', version: '1.0.0', tools: [...] })`.

- [ ] **Step 1: Failing tests** — call the tool HANDLERS directly (export the handlers or build the server and reach `tools`; whichever the SDK's returned shape allows — check the installed `sdk.d.ts`): (a) happy path per tool with a stub adapter → JSON round-trips, allowance decremented by 10; (b) exhausted allowance (total 5) → `isError: true`, message mentions allowance, adapter NOT called; (c) adapter throw → `isError: true`, loop-safe. Plus `PointsAllowance` unit tests: spend/remaining/throw-at-boundary (spend(10) at remaining 10 passes; at 9 throws).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Ops suite green.**
- [ ] **Step 5: Commit** — `git commit -m "feat(ops): per-run CJ points allowance + read-only sourcing MCP server (SDK pinned 0.3.241)"`

---

### Task 11: Atomic day-claim breaker + orphan sweep

**Files:**
- Create: `apps/ops/src/agents/lifecycle.ts`
- Test: `apps/ops/test/agents-lifecycle.test.ts` (real Postgres — the atomicity test needs it)

**Interfaces (produces):**

```ts
export const ORPHAN_AFTER_MINUTES = 20 // watchdog 15 + 5 margin (spec §Stage 3)
export type ClaimResult = { claimed: true; runId: string } | { claimed: false; existingRunId: string }
/** Spec Decision 10: check-and-insert inside one tx holding pg_advisory_xact_lock(hashtext(workflow)).
 *  Sweeps orphans FIRST (self-heal: a crashed last-run must not wedge this claim), then claims. */
export function claimDailyRun(db: Db, alert: Alert, input: {
  workflow: string; model: string; triggerRef: string; force?: boolean
}): Promise<ClaimResult>
/** Flips running rows older than ORPHAN_AFTER_MINUTES to 'aborted' + warning alert per row. Also called at ops boot. */
export function sweepOrphanRuns(db: Db, alert: Alert): Promise<number>
```

Implementation of `claimDailyRun` (this code is normative):

```ts
export async function claimDailyRun(db: Db, alert: Alert, input: { workflow: string; model: string; triggerRef: string; force?: boolean }): Promise<ClaimResult> {
  await sweepOrphanRuns(db, alert)
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'agent-run:' + input.workflow}))`)
    if (!input.force) {
      const [existing] = await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(and(
          eq(agentRuns.workflow, input.workflow),
          sql`(${agentRuns.startedAt} AT TIME ZONE 'utc') >= date_trunc('day', now() AT TIME ZONE 'utc')`,
        ))
        .limit(1)
      if (existing) return { claimed: false, existingRunId: existing.id }
    }
    const [row] = await tx
      .insert(agentRuns)
      .values({ workflow: input.workflow, model: input.model, triggerRef: input.triggerRef, status: 'running' })
      .returning({ id: agentRuns.id })
    return { claimed: true, runId: row.id }
  })
}
```

`sweepOrphanRuns`: one guarded `UPDATE … SET status='aborted', finishedAt=now() WHERE status='running' AND startedAt < now() - interval '20 minutes' RETURNING id, workflow`, then per row `alert('warning', 'agent_run_orphaned', { runId, workflow }).catch(() => {})` and an `audit_log` row (`actor 'system'`, `action 'agent_run.orphaned'`, entityType `'agent_run'`).

- [ ] **Step 1: Failing tests** — (a) first claim today → `claimed: true`, row exists status running; (b) second claim same day → `claimed: false` with the first's id; (c) `force: true` claims anyway (two rows); (d) **atomicity:** `Promise.all` of 10 concurrent `claimDailyRun` calls (each on its OWN drizzle client/pool connection — reuse the test helper's pool factory) → exactly 1 `claimed: true`; (e) yesterday's run doesn't block today (seed a row with `startedAt: sql\`now() - interval '25 hours'\`` and status `'succeeded'`); (f) orphan sweep: a `'running'` row 25 minutes old flips to `'aborted'`, alert + audit fired, and a subsequent claim succeeds (the self-heal); a 10-minute-old running row is untouched.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (also call `sweepOrphanRuns` once at ops boot in `index.ts`, after `startQueue`, before cron registrations — non-fatal on error: `.catch(() => app.log.warn('orphan sweep failed at boot'))`).
- [ ] **Step 4: Ops suite green.** **Step 5: Commit** — `git commit -m "feat(ops): atomic day-claim breaker + agent_runs orphan sweep"`

---

### Task 12: The agent runner

**Files:**
- Create: `apps/ops/src/agents/output-schema.ts`
- Create: `apps/ops/src/agents/sourcing-run.ts`
- Test: `apps/ops/test/agents-sourcing-run.test.ts` (real Postgres; fake SDK stream)

**Interfaces (produces):**

```ts
// output-schema.ts
export const SourcingWinnerSchema = z.object({
  payload: NewListingPayloadSchema, // from @doge-buddy/core
  rationale: z.string().min(1).max(2000),
  marginPct: z.number(),
  freightEstimateCents: z.number().int().nonnegative(),
})
export const SourcingOutputSchema = z.object({
  winners: z.array(SourcingWinnerSchema).max(3),
  notes: z.string().max(2000).optional(),
})
export type SourcingWinner = z.infer<typeof SourcingWinnerSchema>
export type SourcingOutput = z.infer<typeof SourcingOutputSchema>
export const SOURCING_OUTPUT_JSON_SCHEMA = z.toJSONSchema(SourcingOutputSchema)

// sourcing-run.ts
export const SOURCING_MODEL = 'claude-sonnet-5'
export const SOURCING_MAX_TURNS = 25
export const SOURCING_MAX_BUDGET_USD = 2.0
export const SOURCING_WATCHDOG_MS = 15 * 60 * 1000
export interface AgentRunResult {
  status: 'succeeded' | 'failed' | 'aborted'
  output: SourcingOutput | null
  costUsd: number | null      // authoritative when result message arrived, else accumulator estimate
  costEstimated: boolean
}
export interface SourcingRunDeps {
  db: Db
  alert: Alert
  mcpServer: ReturnType<typeof createSdkMcpServer>
  /** Injection seam. Production passes the SDK's query. Tests pass an async-generator factory. */
  queryFn?: (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<Record<string, unknown>>
}
export function runSourcingAgent(deps: SourcingRunDeps, input: {
  runId: string
  candidates: HarvestCandidate[]
  trendSignals: TrendSignal[]
}): Promise<AgentRunResult>
```

Behavior (normative):
1. Build the prompt per spec §Stage 3: candidates + signals serialized compactly (JSON lines), store context, BOTH guard lists verbatim (`EXCLUDED_CATEGORY_TERMS`, `CLAIM_TERMS`), the freight-inclusive margin formula written out with `marginFloorBps` interpolated, "pick winners ONLY from these candidates", output-schema instruction.
2. Options exactly per Global Constraints. `mcpServers: { sourcing: deps.mcpServer }`. Watchdog: prefer `options.abortController` if the installed `sdk.d.ts` has it (check first); otherwise hold the returned `Query` and call its `interrupt()` from the timer. Either way the timer is cleared in `finally`.
3. Stream loop: for each message — insert `agent_run_events` (`runId`, monotonic `seq` starting 0, `message` as jsonb); `type === 'assistant'` → `accumulator.add(message)`; every 5 events, guarded-update the run row's `totalCostUsd` to the current estimate (streaming lower bound, spec §Stage 3); `type === 'result'` → capture.
4. On result `subtype: 'success'`: parse `structured_output` through `SourcingOutputSchema.safeParse` — a parse failure is a FAILED run (`critical`, `sourcing_output_invalid`), not a throw. Update row: `totalCostUsd: result.total_cost_usd`, `modelUsage: result.modelUsage`, `numTurns`, `sessionId`, `finishedAt`, `status 'succeeded'`. On error subtypes (`error_max_budget_usd`, `error_max_turns`, anything): status `'failed'` (budget/turns truncation = `'aborted'`), cost from the result message when present.
5. `finally`: if no result message arrived (throw/abort), update the row with the accumulator tally — `totalCostUsd: tally.estimatedCostUsd`, `modelUsage: { ...tally.perModel, estimated: true }`, `finishedAt`, status `'aborted'` on watchdog abort else `'failed'` — and `alert('critical', 'sourcing_run_failed', { runId, error }).catch(() => {})`. The function NEVER throws; it returns the `AgentRunResult`.

- [ ] **Step 1: Failing tests** — fake `queryFn` async generators, real DB rows pre-claimed via Task 11:
  - **success stream**: init msg → 2 assistant msgs (with usage) → result success (`total_cost_usd: 1.23`, `structured_output`: one valid winner) → events persisted seq 0..3, row succeeded with 1.23 (NOT the estimate), output parsed. Assert the options the fake received: `tools` deep-equals `['WebSearch', 'WebFetch']`, `allowedTools` includes `mcp__sourcing__*`, `settingSources` `[]`, `maxBudgetUsd` 2.
  - **thrown stream**: generator yields 1 assistant msg (1000/500 tokens) then throws → row `'failed'`, `totalCostUsd` equals the accumulator figure for those tokens, `modelUsage.estimated === true`, alert fired, function resolved (no throw).
  - **budget truncation**: result with `subtype: 'error_max_budget_usd'`, `total_cost_usd: 2.01` → row `'aborted'`, cost 2.01, `output: null`.
  - **invalid structured output**: result success but `structured_output: { winners: [{ bogus: true }] }` → row `'succeeded'`? NO — row `'failed'`, alert `sourcing_output_invalid`. (Assert exactly this.)
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Ops suite green.**
- [ ] **Step 5: Commit** — `git commit -m "feat(ops): sourcing agent runner — streamed events, cost accounting, watchdog, output parse"`

---

### Task 13: Stage 4 — validate & submit winners

**Files:**
- Create: `apps/ops/src/sourcing/submit-winners.ts`
- Test: `apps/ops/test/sourcing-submit-winners.test.ts` (real Postgres)

**Interfaces (produces):**

```ts
export const COST_TOLERANCE_BPS = 500 // live CJ cost may drift ±5% from what the agent saw
export interface SubmitWinnersDeps {
  db: Db
  adapter: Pick<SupplierAdapter, 'getProduct' | 'getVariantStock' | 'quoteShipping'>
  allowance: PointsAllowance
  submit: typeof submitProposal    // injection seam; production passes submitProposal
  submitDeps: SubmitProposalDeps   // forwarded to submit()
  settings: SettingsReader         // however submit.ts types its settings dep — mirror it
  alert: Alert
}
export interface WinnerOutcome { supplierProductId: string; outcome: 'submitted' | 'dropped'; reason?: string }
export function validateAndSubmitWinners(deps: SubmitWinnersDeps, input: {
  runId: string
  candidateIds: Set<string>
  candidatesByPid: Map<string, HarvestCandidate>
  winners: SourcingWinner[]
}): Promise<WinnerOutcome[]>
```

Per winner, spec §Stage 4 steps 1–8 IN ORDER; each failure → `alert('warning', KIND, { runId, supplierProductId, detail }).catch(() => {})`, outcome `'dropped'` with `reason: KIND`, continue to the next winner. Kinds: `sourcing_winner_not_candidate`, `sourcing_winner_invalid_payload`, `sourcing_winner_bad_html`, `sourcing_winner_excluded_category`, `claims_scrubbed`, `sourcing_winner_unverifiable` (unknown pid/vid at CJ, cost mismatch beyond `COST_TOLERANCE_BPS`, or no US stock), `sourcing_winner_margin_below_floor`, `sourcing_winner_submit_failed` (submitProposal threw).

Normative details:
- Step 1: `candidateIds.has(payload.variants[0].supplierProductId)` — and every variant's `supplierProductId` must equal that same pid (multi-supplier winners are invalid).
- Step 5 summary composition: `summary = \`New listing: ${title} — ${variants.length} variant(s), margin ${minMarginBps}bps\`` built AFTER the margin computation, from the scrubbed title.
- Step 6: one `getProduct(pid)` per winner (`allowance.spend(10, 'verify:' + pid)` first). Every payload variant's `supplierVariantId` must exist in the detail's variants. Live cost check: `abs(liveCostCents − payload.supplierCostCents) * 10_000 / payload.supplierCostCents <= COST_TOLERANCE_BPS` — on pass, OVERWRITE the payload's `supplierCostCents` with the live figure (the live figure is what fulfillment pays); beyond tolerance → drop. Then `getVariantStock` (spend 10) on the FIRST variant: at least one warehouse with `countryCode 'US'` and quantity ≥ 1 (mirror how `plan.ts` reads `WarehouseStock`).
- Step 7: `quoteShipping({ fromCountry: 'CN', toCountry: 'US', items: [{ supplierVariantId: firstVid, quantity: 1 }] })` (spend 10). Eligible options: `maxDays <= payload.deliveryMaxDays`; none → drop (`sourcing_winner_margin_below_floor`, detail 'no freight within window'). `freightCents` = cheapest eligible. Margin per variant: `Math.floor(((priceCents − supplierCostCents − freightCents) * 10_000) / priceCents)`; every variant ≥ `marginFloorBps` from settings key `'fulfillment.margin_floor_bps'` (read via the same settings helper `submitProposal`'s callers use).
- Step 8: `deps.submit(deps.submitDeps, { type: 'new_listing', summary, payload, sourceWorkflow: 'sourcing.weekly', agentRunId: runId })`.

- [ ] **Step 1: Failing tests** — stub adapter + spy `submit`; one test per rejection kind (the eight above, each with a minimal winner fixture that fails exactly that step and passes the earlier ones), plus: happy path submits with the LIVE cost in the payload and margin-bearing summary; a `submit` throw on winner 1 still submits winner 2; allowance spends are 10+10+10 per fully-verified winner.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Ops suite green.**
- [ ] **Step 5: Commit** — `git commit -m "feat(ops): sourcing stage 4 — membership, guards, live re-verification, freight margin, submit"`

---

### Task 14: Pipeline orchestrator, cron wiring, `run-sourcing` script

**Files:**
- Create: `apps/ops/src/sourcing/pipeline.ts`
- Create: `apps/ops/src/jobs/sourcing-weekly.ts` (thin adapter, house pattern)
- Modify: `apps/ops/src/index.ts` (cron registration + boot orphan sweep)
- Create: `apps/ops/scripts/run-sourcing.ts`
- Modify: `apps/ops/package.json` (script `"run-sourcing": "tsx scripts/run-sourcing.ts"`)
- Test: `apps/ops/test/sourcing-pipeline.test.ts`

**Interfaces (produces):**

```ts
// pipeline.ts
export interface SourcingPipelineDeps {
  db: Db
  adapter: SupplierAdapter
  settings: SettingsReader
  alert: Alert
  enqueue: Enqueue
  notify: NotifyOwner
  adminBaseUrl?: string
  trends: TrendsProvider | null   // null = SERPAPI_KEY absent → stage 2 skipped
  queryFn?: SourcingRunDeps['queryFn'] // test seam, threaded through to the runner
  force?: boolean
}
export function runSourcingPipeline(deps: SourcingPipelineDeps): Promise<{
  runId: string | null
  outcome: 'refused' | 'no_candidates' | 'agent_failed' | 'completed'
  submitted: number
}>
```

Orchestration (normative order):
1. `claimDailyRun(db, alert, { workflow: 'sourcing.weekly', model: SOURCING_MODEL, triggerRef: force ? 'manual' : 'cron', force })` — `claimed: false` → `alert('info', 'sourcing_run_refused', { existingRunId })`, audit row (`system`, `'sourcing.run_refused'`), return `{ runId: null, outcome: 'refused', submitted: 0 }` **cleanly — never throw** (Decision 10: the job completes as a no-op).
2. `runHarvest` → `< MIN_CANDIDATES` → flip the claimed row to `'aborted'` with `totalCostUsd: '0'`, `alert('warning', 'sourcing_run_skipped_no_candidates', { found })`, return `'no_candidates'`.
3. Trends: `deps.trends` null → `alert('warning', 'trends_stage_skipped', {})`; else `fetchInterest(candidates.map(c => c.title))`, insert one `sourcing_signals` row per signal (`source 'google_trends'`, `keyword`, `score`, `snapshot`), failures alert-and-continue with empty signals.
4. Build `PointsAllowance` seeded with the harvest's spend: `allowance.spend(pagesFetched * 50, 'harvest')`.
5. `runSourcingAgent({ db, alert, mcpServer: createSourcingMcpServer({ adapter, allowance }), queryFn }, { runId, candidates, trendSignals })` → non-succeeded or null output → return `'agent_failed'` (the runner already recorded/alerted).
6. `validateAndSubmitWinners(...)` with `candidateIds` + `candidatesByPid` from stage 1; audit row (`system`, `'sourcing.run_completed'`, entityType `'agent_run'`, entityId runId, detail `{ submitted, dropped }`).

`jobs/sourcing-weekly.ts`: `export const sourcingWeeklyHandler = (deps: SourcingPipelineDeps) => async () => { await runSourcingPipeline(deps) }` — job never rethrows pipeline errors (wrap in try/catch → `alert('critical', 'sourcing_run_failed', …)`), because `retryLimit: 0` means a throw only paints the job red with no retry anyway.

`index.ts` (after the existing cron block, using Task 4's config + Task 5's options):

```ts
await sweepOrphanRuns(db, alert).catch(() => app.log.warn('agent orphan sweep failed at boot'))
if (config.anthropic) {
  const trends = config.serpapi ? createSerpApiTrends({ apiKey: config.serpapi.apiKey }) : null
  const sourcingDeps: SourcingPipelineDeps = { db, adapter: supplierAdapter, settings, alert, enqueue, notify, adminBaseUrl: config.adminBaseUrl, trends }
  await registerCron(queue.boss, 'sourcing.weekly', '0 13 * * 1', sourcingWeeklyHandler(sourcingDeps), { retryLimit: 0, expireInSeconds: 3600 })
  app.log.info('sourcing.weekly cron ARMED — Mondays 13:00 UTC, sonnet-5, $2.00 stop-loss')
}
```

(The disabled-warn lives in Task 4's log block. `ANTHROPIC_API_KEY` needs no explicit plumbing to the SDK — it reads the inherited env; the spread in `env` preserves it.)

`scripts/run-sourcing.ts` (mirror `seed-proposal.ts`'s bootstrap: load `.env`, build db/settings/alert/notify/adapter exactly as that script does): parse `--force` from argv, build deps as above (real Telegram notifier when configured, tee/console fallback), call `runSourcingPipeline`, print `{ runId, outcome, submitted }` and the allowance/SerpApi tallies, exit 0 on `refused`/`no_candidates`, 1 on `agent_failed`.

- [ ] **Step 1: Failing tests** — everything stubbed except real DB: (a) full happy path (stub adapter, stub trends, fake queryFn success with 2 valid winners) → 2 proposals pending in DB, run row succeeded, audit `sourcing.run_completed`; (b) second call same day without force → `'refused'`, no second run row, NO throw; (c) empty harvest → `'no_candidates'`, row aborted cost '0'; (d) trends null → agent still ran, `trends_stage_skipped` alert; (e) fake queryFn failure → `'agent_failed'`, zero proposals.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: FULL monorepo suite green** (`pnpm -r test 2>&1 | tail -30`, pipefail — this task wires index.ts).
- [ ] **Step 5: Commit** — `git commit -m "feat(ops): sourcing.weekly pipeline, armed cron, run-sourcing script"`

---

### Task 15: Admin — runs detail page, list columns, proposal description rendering

**Files:**
- Modify: `apps/ops/src/http/admin/routes.ts` (runs list + new `GET /admin/runs/:id`)
- Modify: `apps/ops/src/http/admin/render-proposal.ts` (descriptionHtml block)
- Create: `apps/ops/src/http/admin/render-run.ts`
- Test: `apps/ops/test/admin-runs.test.ts` (+ extend the existing proposal-page test file)

**Interfaces:**
- Consumes: `agent_runs`/`agent_run_events` rows; `validateDescriptionHtml` (Task 6); the `html`/`esc`/`raw`/`layout` helpers and `safeHandle` from Phase 4B.
- Produces: `renderRunDetail(run: AgentRunRow, events: AgentRunEventRow[]): RawHtml`.

Behavior:
- Runs LIST gains columns: cost (render `totalCostUsd` as `$X.XX`, suffix ` (est)` when `modelUsage.estimated === true`), turns (`numTurns ?? '—'`), finished (`finishedAt ?? '—'`); each id links to `/admin/runs/:id`.
- Detail page: header strip (workflow, status, model, started/finished, cost with est marker, turns, sessionId) + the event stream: per event a `<details>` block — summary line = seq + message `type`/`subtype` + (for assistant messages) the first 120 chars of any text block; body = `<pre>` of `JSON.stringify(message, null, 2)` **through `esc`** (transcripts contain untrusted CJ/web content — nothing renders raw). Non-UUID id / unknown id → the admin 404 path `safeHandle` already provides.
- Proposal detail (`render-proposal.ts`): for `new_listing` payloads add a "Description (as it will appear)" section — if `validateDescriptionHtml(descriptionHtml) === null` render it via `raw()` inside a bordered container, else render `esc(descriptionHtml)` in a `<pre>` with a red "failed HTML validation — showing source" note. (Manual/Phase-4-era proposals never validated at submit; re-validating at render keeps `raw()` unreachable for anything the allowlist wouldn't pass. This is the only new `raw()` call this task may add.)

- [ ] **Step 1: Failing tests** — seed a run + 3 events (init/assistant/result): list shows `$1.23`, est-marker case shows `(est)`; detail 200s, contains seq lines, and a `<script>` payload inside an event message arrives ESCAPED (`&lt;script&gt;` present, `<script>` absent — the regression assertion); proposal page: valid description renders the `<strong>` tag raw; a `<script>` description renders escaped with the failure note; unauthenticated request → login redirect (mirror the existing admin test helper).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Ops suite green.**
- [ ] **Step 5: Commit** — `git commit -m "feat(ops): /admin/runs detail + cost columns; proposal page renders validated description"`

---

### Task 16: Carried Phase 4 rulings — enqueue guard, imageUrls tighten, apply-time webhook subscribe

**Files:**
- Modify: `apps/ops/src/proposals/submit.ts` (auto-path enqueue guard)
- Modify: `packages/core/src/proposals.ts` (imageUrls http(s)-only)
- Modify: `apps/ops/src/proposals/run-apply.ts` + its deps threading in `apps/ops/src/queue.ts` (subscribe call)
- Test: extend `apps/ops/test/` submit/apply test files + `packages/core` schema tests

**Interfaces:**
- Consumes: `subscribeProductWebhook` (Task 3 — the mock records `subscribedProductIds`).
- Produces: no signature changes visible to other tasks; `ApplyProposalDeps` gains `adapter: Pick<SupplierAdapter, 'subscribeProductWebhook'>` (threaded from `startQueue`'s existing `adapter` dep).

Three independent fixes, one commit each is fine — or one commit if the diffs stay small:

1. **Enqueue guard (submit.ts auto path):** wrap the auto-mode `enqueueProposalApply` in try/catch — on throw: `alert('critical', 'apply_enqueue_failed', { proposalId }).catch(() => {})`, and return `{ id, status: 'approved' }` normally (the proposal stays approved; `/admin` resend-apply is the recovery, exactly the action-route precedent). Test: enqueue spy throws → submitProposal resolves, alert fired, proposal row is `'approved'`.
2. **imageUrls tighten (core):** the array element schema becomes `z.url().refine((u) => u.startsWith('http://') || u.startsWith('https://'), 'imageUrls must be http(s)')`. Tests: `javascript:alert(1)` and `data:text/html;x` rejected; `https://cf.cjdropshipping.com/x.png` accepted. Run the FULL monorepo suite — seeds/fixtures already use http(s) URLs, but verify.
3. **Apply-time subscribe (run-apply.ts):** in the apply executor, strictly AFTER the `applying → applied` transition commits, collect the payload's unique `supplierProductId`s and for each: `await deps.adapter.subscribeProductWebhook(pid).catch((err) => deps.alert('warning', 'product_webhook_subscribe_failed', { proposalId, supplierProductId: pid, error: String(err instanceof Error ? err.message : err) }).catch(() => {}))`. A resumed/retried apply that finds the row already `'applied'` returns before reaching this call (existing behavior — assert it stays that way). Tests: happy apply → mock adapter's `subscribedProductIds` contains the pid; subscribe throw → apply still succeeds, warning alert fired; re-run of an applied proposal → no second subscribe.

- [ ] **Step 1: Write the failing tests** (all three areas as specified above).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: FULL monorepo suite green.**
- [ ] **Step 5: Commit** — `git commit -m "feat(ops): carried rulings — auto-path enqueue guard, http(s) imageUrls, apply-time CJ product-webhook subscribe"`

---

## Execution order & review gates

Tasks 1–8 are independent foundations (any order; 1→2→3 share files, keep sequential). 9 needs 1+6. 10 needs 2+the SDK pin. 11 is independent. 12 needs 8+10+11. 13 needs 6+10 (+2's types). 14 needs 4+5+7+9+11+12+13. 15 needs 6+11 (seed data). 16 needs 3. Suggested serial order: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16.

Every task: suite green with `set -o pipefail` before commit; no secrets in fixtures; the final whole-branch review runs on the most capable model per SDD.
