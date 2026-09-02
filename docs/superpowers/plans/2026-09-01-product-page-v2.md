# Product Page v2 + Listing Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A product page where switching variants changes the image and specs, a real thumbnail gallery, honest structured content (highlights/specs/what's-in-box), clearly-labeled supplier marketplace reviews, and trust badges — with every new piece of data written once at listing time by plain code, and every section degrading to exactly today's page when its data is absent.

**Architecture:** Shared zod schemas in `@doge-buddy/core` define the JSON shapes stored in `dogebuddy.*` product metafields. The sourcing agent proposes the content; Stage 6 scrubs it with the existing guards and overwrites variant images with live CJ values; the apply worker fetches supplier reviews itself (never trusts agent review text) and writes everything in the existing `productSet`; `backfill-listings` gains a v2 pass to repair the 2–3 already-live products. The Hydrogen storefront reads the metafields through the same schemas and renders seven new null-safe components.

**Tech Stack:** zod v4, Drizzle/Postgres (no new migration), Shopify Admin GraphQL 2026-07 (ops) / Storefront API 2026-04 (Hydrogen 2026.4.5), vitest (+ @testing-library/react in the storefront), pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-09-01-product-page-v2-design.md` — read it before starting any task; every decision number referenced below (`Decision N`, `§A4` etc.) points there.

## Global Constraints

- Metafield namespace is `dogebuddy`. New keys: `highlights` (type `json`), `specs` (`json`), `supplier_reviews` (`json`), `whats_in_box` (`single_line_text_field`). Existing keys (`ships_from`, `delivery_min_days`, `delivery_max_days`) are untouched.
- `SUPPLIER_REVIEWS_MAX = 10`. Review text is plain text, sanitized, capped at 500 chars.
- The reviews disclosure line is FIXED VERBATIM (Decision 4): `From the supplier's buyers on other marketplaces — not yet from Doge Buddy customers.` (em dash, exact casing, trailing period). Heading: `Marketplace reviews`.
- NO `review`/`aggregateRating` in Product JSON-LD (Decision 6) — add a regression test, never the markup.
- Reject-never-rewrite: content that hits `findClaimViolations` is dropped (a winner, a review), never edited.
- Absent/unparseable metafield ⇒ the storefront section renders `null`; the page must equal today's page. Never a 500 from bad metafield JSON.
- On an EXISTING Shopify product, never send `variants` or `files` through `productSet`/`productUpdate` (rewrites inventory, re-uploads media — `apply-new-listing.ts:125-133`). Media repair uses `productCreateMedia` + `productVariantAppendMedia` only.
- Every NEW Shopify Admin operation gets the house comment convention: `// LIVE-VERIFIED <date> by introspection of the 2026-07 Admin schema:` when the probe in Task 8 confirmed it, else `// FIXTURE-ASSUMPTION (2026-07 API), verify on the first credential-gated run:`. Introspection alone is NOT "live-verified" for a mutation's runtime behavior — the backfill live run (owner-side, after this plan) is the first real call.
- Code style: ops/packages are semicolon-free, single quotes; `apps/storefront` uses Shopify's prettier config (semicolons). Match the file you're in.
- After any task in `apps/ops`: run BOTH `pnpm --filter @doge-buddy/ops test <file>` AND `pnpm --filter @doge-buddy/ops typecheck` (the test script is vitest-only; CI gates on typecheck separately). Same for other packages. Ops DB-backed tests need `pnpm db:up` (and the migrate-after-db:up gotcha applies in worktrees — run `pnpm db:migrate` if tables are missing).
- The storefront GraphQL codegen must be re-run after fragment changes: `pnpm --filter @doge-buddy/storefront codegen`.
- Storefront policy links: the returns policy route is `/policies/returns` (NOT the spec's `/policies/refund-policy` — that handle does not exist; `POLICY_COPY` handle is `returns` and `Footer.tsx` already links `/policies/returns`). This is a deliberate, recorded deviation from Decision 11's literal link text.
- Do not touch `TrustStrip` (`components/brand/TrustStrip.tsx`) — its copy is pinned verbatim by `brand.test.tsx`.

---

### Task 1: Shared content schemas in `@doge-buddy/core`

**Files:**
- Create: `packages/core/src/content.ts`
- Modify: `packages/core/src/index.ts` (add one barrel line)
- Test: `packages/core/test/content.test.ts`

**Interfaces:**
- Consumes: nothing new (zod is already a core dep).
- Produces: `ProductHighlightsSchema`/`ProductHighlights`, `ProductSpecsSchema`/`ProductSpecs`, `SupplierReviewSchema`/`SupplierReview`, `SupplierReviewsSchema`/`SupplierReviews`, `SUPPLIER_REVIEWS_MAX`. Later tasks (2, 6, 7, 9, 11, 13, 15) import exactly these names from `@doge-buddy/core`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/content.test.ts
import { describe, expect, it } from 'vitest'
import {
  ProductHighlightsSchema,
  ProductSpecsSchema,
  SupplierReviewsSchema,
  SUPPLIER_REVIEWS_MAX,
} from '../src/content.ts'

describe('ProductHighlightsSchema', () => {
  it('accepts 3-5 bullets of 3-120 chars', () => {
    expect(ProductHighlightsSchema.safeParse(['Durable rope core', 'Machine washable', 'Non-slip grip']).success).toBe(true)
  })
  it.each([
    [['one', 'two'], 'fewer than 3'],
    [['a1', 'b2', 'c3'], 'bullets under 3 chars'],
    [['ok bullet', 'ok bullet 2', 'ok bullet 3', 'ok 4', 'ok 5', 'ok 6'], 'more than 5'],
  ])('rejects %j (%s)', (input) => {
    expect(ProductHighlightsSchema.safeParse(input).success).toBe(false)
  })
})

describe('ProductSpecsSchema', () => {
  it('accepts 1-10 label/value rows', () => {
    expect(ProductSpecsSchema.safeParse([{ label: 'Material', value: 'Cotton rope' }]).success).toBe(true)
  })
  it('rejects a label over 40 chars', () => {
    expect(ProductSpecsSchema.safeParse([{ label: 'x'.repeat(41), value: 'v' }]).success).toBe(false)
  })
  it('rejects an empty array', () => {
    expect(ProductSpecsSchema.safeParse([]).success).toBe(false)
  })
})

describe('SupplierReviewsSchema', () => {
  const review = { rating: 5, text: 'Great toy, my dog loves it' }
  it('accepts a full valid value', () => {
    const parsed = SupplierReviewsSchema.safeParse({
      average: 4.6,
      count: 1238,
      reviews: [{ ...review, date: '2026-05-01', country: 'US' }],
      fetchedAt: '2026-09-01T00:00:00.000Z',
    })
    expect(parsed.success).toBe(true)
  })
  it.each([
    [{ rating: 0, text: 'ok' }, 'rating 0'],
    [{ rating: 6, text: 'ok' }, 'rating 6'],
    [{ rating: 4.5, text: 'ok' }, 'non-integer rating'],
    [{ rating: 5, text: '' }, 'empty text'],
    [{ rating: 5, text: 'ok', country: 'USA' }, '3-letter country'],
  ])('rejects a review %j (%s)', (bad) => {
    expect(
      SupplierReviewsSchema.safeParse({ average: 4, count: 1, reviews: [bad], fetchedAt: '2026-09-01T00:00:00.000Z' }).success,
    ).toBe(false)
  })
  it(`caps reviews at ${SUPPLIER_REVIEWS_MAX}`, () => {
    const reviews = Array.from({ length: SUPPLIER_REVIEWS_MAX + 1 }, () => review)
    expect(SupplierReviewsSchema.safeParse({ average: 5, count: 11, reviews, fetchedAt: 'x' }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @doge-buddy/core test test/content.test.ts`
Expected: FAIL — cannot resolve `../src/content.ts`.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/content.ts
import { z } from 'zod'

/**
 * Product-page v2 structured content (spec 2026-09-01 §Data shapes): the JSON values stored in
 * `dogebuddy.*` product metafields. Shared so the ops writers (payload validation, the apply
 * worker, backfill) and the storefront reader parse the exact same shapes — a stored value that
 * fails these schemas is treated as ABSENT by the storefront (the section renders null and the
 * page equals the pre-v2 page), never a 500.
 */

export const SUPPLIER_REVIEWS_MAX = 10

export const ProductHighlightsSchema = z.array(z.string().min(3).max(120)).min(3).max(5)
export type ProductHighlights = z.infer<typeof ProductHighlightsSchema>

export const ProductSpecsSchema = z
  .array(
    z.object({
      label: z.string().min(1).max(40),
      value: z.string().min(1).max(120),
    }),
  )
  .min(1)
  .max(10)
export type ProductSpecs = z.infer<typeof ProductSpecsSchema>

export const SupplierReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  text: z.string().min(1).max(500), // plain text — sanitized upstream, never HTML
  date: z.string().optional(), // as the supplier returned it, display-only
  country: z.string().length(2).optional(),
})
export type SupplierReview = z.infer<typeof SupplierReviewSchema>

export const SupplierReviewsSchema = z.object({
  average: z.number().min(1).max(5), // over ALL fetched reviews, not just the kept ones
  count: z.number().int().nonnegative(), // supplier's total where available, else fetched count
  reviews: z.array(SupplierReviewSchema).max(SUPPLIER_REVIEWS_MAX),
  fetchedAt: z.string(), // ISO — the storefront shows "as of <date>"
})
export type SupplierReviews = z.infer<typeof SupplierReviewsSchema>
```

Add to `packages/core/src/index.ts` (alongside the existing `export * from './proposals.ts'` lines):

```ts
export * from './content.ts'
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @doge-buddy/core test && pnpm --filter @doge-buddy/core typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/content.ts packages/core/src/index.ts packages/core/test/content.test.ts
git commit -m "feat(core): product-page-v2 content schemas (highlights/specs/supplier reviews)"
```

---

### Task 2: `NewListingPayloadSchema` v2 fields

**Files:**
- Modify: `packages/core/src/proposals.ts:14-46`
- Test: `packages/core/test/proposals.test.ts` (add cases to the existing file)

**Interfaces:**
- Consumes: `ProductHighlightsSchema`, `ProductSpecsSchema` from `./content.ts` (Task 1).
- Produces: `listingVariant` gains `imageUrl?: string` (http(s)); `NewListingPayload` gains `highlights?: ProductHighlights`, `specs?: ProductSpecs`, `whatsInBox?: string`. Tasks 4, 5, 7 rely on these exact field names. `SourcingWinnerSchema` (`apps/ops/src/agents/output-schema.ts:12`) embeds this schema directly, so the agent's structured-output JSON schema picks the new fields up with NO change there.

- [ ] **Step 1: Write the failing tests** — add to `packages/core/test/proposals.test.ts`:

```ts
describe('NewListingPayloadSchema v2 fields', () => {
  const base = {
    type: 'new_listing' as const,
    title: 'Rope Toy',
    descriptionHtml: '<p>A rope toy.</p>',
    categoryTag: 'toys' as const,
    imageUrls: ['https://cdn.example.com/a.jpg'],
    shipsFrom: 'US' as const,
    deliveryMinDays: 3,
    deliveryMaxDays: 7,
    variants: [
      {
        sku: 'ROPE-1',
        priceCents: 1999,
        supplierCostCents: 500,
        supplier: 'cj' as const,
        supplierProductId: 'pid-1',
        supplierVariantId: 'vid-1',
      },
    ],
  }

  it('still parses a legacy payload without any v2 field (stored pre-v2 proposals must keep applying)', () => {
    expect(NewListingPayloadSchema.safeParse(base).success).toBe(true)
  })

  it('parses a full v2 payload', () => {
    const parsed = NewListingPayloadSchema.safeParse({
      ...base,
      highlights: ['Durable rope core', 'Machine washable', 'Non-slip grip'],
      specs: [{ label: 'Material', value: 'Cotton' }],
      whatsInBox: '1x rope toy',
      variants: [{ ...base.variants[0], imageUrl: 'https://cdn.example.com/v1.jpg' }],
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a non-http(s) variant imageUrl', () => {
    const parsed = NewListingPayloadSchema.safeParse({
      ...base,
      variants: [{ ...base.variants[0], imageUrl: 'ftp://cdn.example.com/v1.jpg' }],
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects whatsInBox over 200 chars', () => {
    expect(NewListingPayloadSchema.safeParse({ ...base, whatsInBox: 'x'.repeat(201) }).success).toBe(false)
  })
})
```

(Import `NewListingPayloadSchema` the way the file already does; reuse an existing base-payload fixture if the file has one instead of duplicating `base`.)

- [ ] **Step 2: Run to verify the new cases fail**

Run: `pnpm --filter @doge-buddy/core test test/proposals.test.ts`
Expected: the two v2-field cases FAIL (unknown keys are stripped by zod, so the full-v2 parse "succeeds" but the ftp rejection case fails — the imageUrl field doesn't exist yet to be validated). At minimum the ftp case fails.

- [ ] **Step 3: Implement** — in `packages/core/src/proposals.ts`:

Add the import at the top: `import { ProductHighlightsSchema, ProductSpecsSchema } from './content.ts'`

In `listingVariant` (line 14), after `supplierVariantId`:

```ts
  // v2 (spec 2026-09-01 Decision 1): the variant's own image. The agent proposes it from CJ's
  // `variantImage`; Stage 6 OVERWRITES it with the live CJ value during re-verification — same
  // trust pattern as supplierCostCents. Absent = the variant has no dedicated image.
  imageUrl: z
    .url()
    .refine((u) => u.startsWith('http://') || u.startsWith('https://'), 'imageUrl must be http(s)')
    .optional(),
```

In `NewListingPayloadSchema`'s object (before the `.refine`), after `variants`:

```ts
    // v2 structured content (spec 2026-09-01 §A1). Optional at the SCHEMA level so stored pre-v2
    // proposals and support-side payloads still parse and apply (rendering the pre-v2 page); the
    // sourcing prompt REQUIRES highlights+specs, and Stage 6 drops `sourcing.weekly` winners
    // without them (`sourcing_winner_missing_content`).
    highlights: ProductHighlightsSchema.optional(),
    specs: ProductSpecsSchema.optional(),
    whatsInBox: z.string().max(200).optional(),
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @doge-buddy/core test && pnpm --filter @doge-buddy/core typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/proposals.ts packages/core/test/proposals.test.ts
git commit -m "feat(core): new_listing payload gains variant imageUrl + highlights/specs/whatsInBox"
```

---

### Task 3: Sourcing agent prompt — demand the v2 content

**Files:**
- Modify: `apps/ops/src/agents/sourcing-run.ts:123-130` (HARD RULE) and `:149-151` (task step 3)
- Test: `apps/ops/test/agents-sourcing-run.test.ts` (update any pinned prompt strings; add substring asserts)

**Interfaces:**
- Consumes: nothing new — pure prompt text.
- Produces: prompt text that Tasks 4/5's gates assume the agent was told about. No code contract.

- [ ] **Step 1: Write the failing test** — in `apps/ops/test/agents-sourcing-run.test.ts`, find where the built prompt/system prompt is asserted (the file tests `buildPrompt`/`buildSystemPrompt` or the runner's assembled prompt) and add, following the file's existing assertion style:

```ts
it('task step 3 demands v2 content: >=3 images, per-variant imageUrl, highlights, specs', () => {
  const prompt = buildPrompt(baseInput, 3) // reuse the file's existing input fixture + call shape
  expect(prompt).toContain('LEAST 3 http(s) imageUrls')
  expect(prompt).toContain("variantImage")
  expect(prompt).toContain('3-5 factual `highlights` bullets')
  expect(prompt).toContain('`specs` table')
  expect(prompt).toContain('whatsInBox')
})

it('HARD RULE names the v2 content fields as scanned', () => {
  const prompt = buildPrompt(baseInput, 3)
  expect(prompt).toContain('not in highlights, specs, or whatsInBox')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @doge-buddy/ops test test/agents-sourcing-run.test.ts`
Expected: the two new cases FAIL.

- [ ] **Step 3: Implement** — in `apps/ops/src/agents/sourcing-run.ts`:

Replace lines 124-126 (inside the `## Disallowed claims — HARD RULE` block; keep the surrounding lines):

```ts
    'These exact words/phrases must NOT appear ANYWHERE in a winner — not in title, not in',
    'descriptionHtml, not in highlights, specs, or whatsInBox, and not in your rationale (ALL of',
    'these are scanned; a single occurrence, case-insensitive, discards the ENTIRE winner):',
```

Replace lines 149-151 (task step 3):

```ts
    '3. Build a complete new_listing payload for each candidate that clears the margin floor: one',
    '   categoryTag, real variants with SKUs/priceCents/supplierCostCents from the detail call, at',
    "   LEAST 3 http(s) imageUrls from the detail call, each variant's imageUrl copied from that",
    "   variant's variantImage in get_product_detail (omit it for variants CJ shows no image for),",
    '   3-5 factual `highlights` bullets (what the item IS: material, size, cleaning, use), a',
    '   `specs` table as [{label, value}] rows from CJ detail data (size/material/weight), an',
    '   optional one-line `whatsInBox`, US-appropriate delivery days, and clean marketing copy',
    '   (no disallowed claims).',
```

- [ ] **Step 4: Run the full ops suite for this file + typecheck** — other tests in the file may pin the old step-3 text; update them in place.

Run: `pnpm --filter @doge-buddy/ops test test/agents-sourcing-run.test.ts && pnpm --filter @doge-buddy/ops typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/agents/sourcing-run.ts apps/ops/test/agents-sourcing-run.test.ts
git commit -m "feat(sourcing): prompt demands >=3 images, variant images, highlights/specs/whatsInBox"
```

---

### Task 4: Stage 6 — content gate + scrub/exclusion over the new strings

**Files:**
- Modify: `apps/ops/src/sourcing/submit-winners.ts` (steps 2/4/5 area, `:94-124`, and the summary at `:237`)
- Test: `apps/ops/test/sourcing-submit-winners.test.ts`

**Interfaces:**
- Consumes: `NewListingPayload.highlights/specs/whatsInBox` (Task 2).
- Produces: drop reason string `sourcing_winner_missing_content`; the summary format `New listing: <title> — N variant(s), M image(s), margin <bps>bps<marketClause>`. The admin/Telegram surfaces read the summary as an opaque string — no other consumer.

- [ ] **Step 1: Update the `winnerFor()` builder FIRST** — in `apps/ops/test/sourcing-submit-winners.test.ts`, the default payload built by `winnerFor()` (`:36-66`) must gain valid v2 content, or every existing test dies on the new gate. Add to its default payload object:

```ts
      highlights: ['Durable rope core', 'Machine washable', 'Non-slip grip'],
      specs: [{ label: 'Material', value: 'Cotton' }],
```

- [ ] **Step 2: Write the failing tests** — add to the same file, following its `'step N — <drop_reason>: <case>'` naming:

```ts
it('step 2b — sourcing_winner_missing_content: highlights absent', async () => {
  const deps = makeDeps()
  const winner = winnerFor('pid-1', { highlights: undefined })
  const outcomes = await validateAndSubmitWinners(deps, inputFor([winner]))
  expect(outcomes[0]).toMatchObject({ outcome: 'dropped', reason: 'sourcing_winner_missing_content' })
  expect(deps.submit).not.toHaveBeenCalled()
})

it('step 2b — sourcing_winner_missing_content: specs absent', async () => {
  const deps = makeDeps()
  const outcomes = await validateAndSubmitWinners(deps, inputFor([winnerFor('pid-1', { specs: undefined })]))
  expect(outcomes[0]!.reason).toBe('sourcing_winner_missing_content')
})

it('step 5 — claims_scrubbed: claim term inside a highlight', async () => {
  const deps = makeDeps()
  const winner = winnerFor('pid-1', {
    highlights: ['Durable rope core', 'anxiety relief for pups', 'Non-slip grip'],
  })
  const outcomes = await validateAndSubmitWinners(deps, inputFor([winner]))
  expect(outcomes[0]!.reason).toBe('claims_scrubbed')
})

it('step 5 — claims_scrubbed: claim term inside a spec VALUE and inside whatsInBox', async () => {
  const deps = makeDeps()
  for (const overrides of [
    { specs: [{ label: 'Benefit', value: 'clinically proven comfort' }] },
    { whatsInBox: '1x vet approved rope' },
  ]) {
    const outcomes = await validateAndSubmitWinners(deps, inputFor([winnerFor('pid-1', overrides)]))
    expect(outcomes[0]!.reason).toBe('claims_scrubbed')
  }
})

it('step 4 — sourcing_winner_excluded_category: excluded term inside a spec label', async () => {
  const deps = makeDeps()
  const winner = winnerFor('pid-1', { specs: [{ label: 'Supplement type', value: 'n/a' }] })
  const outcomes = await validateAndSubmitWinners(deps, inputFor([winner]))
  expect(outcomes[0]!.reason).toBe('sourcing_winner_excluded_category')
})
```

(Use the file's existing helper for building the input — if it's not literally `inputFor`, mirror how existing tests construct `ValidateAndSubmitWinnersInput`. `winnerFor`'s payload overrides are spread `Record<string, unknown>`, so `{ highlights: undefined }` deletes the default.)

Also update the happy-path summary assertion (`:142-163`) to the new format — with the builder's defaults (1 image): `New listing: ... — 1 variant(s), 1 image(s), margin ...`.

- [ ] **Step 3: Run to verify the new cases fail**

Run: `pnpm --filter @doge-buddy/ops test test/sourcing-submit-winners.test.ts`
Expected: new cases FAIL (winners submit instead of dropping).

- [ ] **Step 4: Implement** — in `apps/ops/src/sourcing/submit-winners.ts`:

After step 2's parse succeeds (right after `let payload` is assigned from the safeParse at `:97-101`), insert:

```ts
  // Step 2b: v2 content gate (spec 2026-09-01 §A3). Every winner in THIS pipeline is a
  // `sourcing.weekly` submission (see the hardcoded sourceWorkflow at the submit call below), and
  // the prompt demands highlights + specs — a winner without them is an agent that ignored the
  // task, not a legacy payload (legacy/support payloads enter via submitProposal directly and
  // never pass through here; they parse and apply fine without content, rendering the pre-v2 page).
  if (!payload.highlights || !payload.specs) {
    return drop('sourcing_winner_missing_content', {
      hasHighlights: Boolean(payload.highlights),
      hasSpecs: Boolean(payload.specs),
    })
  }
```

Just above step 4 (`:110`), build the shared string list once:

```ts
  // v2: the structured-content strings ride through BOTH text gates below exactly like
  // title/description (spec 2026-09-01 §A3). Labels are scanned as well as values — a claim
  // smuggled into a label is still our publication (small deliberate widening of the spec's
  // "values" wording, same reject stance).
  const contentStrings = [
    ...(payload.highlights ?? []),
    ...(payload.specs ?? []).flatMap((s) => [s.label, s.value]),
    payload.whatsInBox,
  ]
```

Step 4 becomes:

```ts
  const excludedTerm = matchExcludedCategory(
    payload.title,
    htmlToText(payload.descriptionHtml),
    harvestCategoryName,
    ...contentStrings,
  )
```

Step 5 becomes:

```ts
  const claimHits = findClaimViolations(
    payload.title,
    htmlToText(payload.descriptionHtml),
    winner.rationale,
    ...contentStrings,
  )
```

The summary (`:237`) becomes (Decision 10 — the image count is the human gate's signal, there is NO count gate):

```ts
  const summary = `New listing: ${payload.title} — ${payload.variants.length} variant(s), ${payload.imageUrls.length} image(s), margin ${minMarginBps}bps${marketClause}`
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @doge-buddy/ops test test/sourcing-submit-winners.test.ts && pnpm --filter @doge-buddy/ops typecheck`
Expected: PASS (including every pre-existing case, now with content in the builder).

- [ ] **Step 6: Commit**

```bash
git add apps/ops/src/sourcing/submit-winners.ts apps/ops/test/sourcing-submit-winners.test.ts
git commit -m "feat(sourcing): stage-6 content gate + claims/exclusion scrub over highlights/specs/whatsInBox"
```

---

### Task 5: Stage 6 — live variant-image overwrite

**Files:**
- Modify: `apps/ops/src/sourcing/submit-winners.ts:181-187` (the step-7 overwrite block)
- Test: `apps/ops/test/sourcing-submit-winners.test.ts`

**Interfaces:**
- Consumes: `SupplierVariantDetail.imageUrl` (`packages/supplier/src/types.ts:24-31`, already mapped from CJ's `variantImage` at `mapping.ts:82`); `listingVariant.imageUrl` (Task 2).
- Produces: submitted payloads whose `variants[].imageUrl` is exactly the live CJ value (or absent). Task 7's apply worker consumes that field.

- [ ] **Step 1: Write the failing tests** — the default `makeAdapter().getProduct` (`:78-86`) returns variants without `imageUrl`; use `overrides.getProduct` per case:

```ts
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
    const winner = winnerFor('pid-1', {
      variants: [variantFor('pid-1', { imageUrl: 'https://agent.example.com/invented.jpg' })],
    })
    await validateAndSubmitWinners(deps, inputFor([winner]))
    const submitted = (deps.submit as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(submitted.payload.variants[0].imageUrl).toBe('https://cj.example.com/live.jpg')
  })

  it('CLEARS the agent-proposed imageUrl when CJ shows no image for the variant', async () => {
    const deps = makeDeps() // default adapter: live variant has no imageUrl
    const winner = winnerFor('pid-1', {
      variants: [variantFor('pid-1', { imageUrl: 'https://agent.example.com/invented.jpg' })],
    })
    await validateAndSubmitWinners(deps, inputFor([winner]))
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
    await validateAndSubmitWinners(deps, inputFor([winnerFor('pid-1')]))
    const submitted = (deps.submit as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(submitted.payload.variants[0].imageUrl).toBeUndefined()
  })
})
```

(`variantFor` = however the file builds a payload variant today — reuse/extend its builder; the pid-v1 supplierVariantId must match the adapter's.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @doge-buddy/ops test test/sourcing-submit-winners.test.ts`
Expected: the three new cases FAIL (agent's URL survives).

- [ ] **Step 3: Implement** — replace the overwrite block at `:181-187` with:

```ts
    payload = {
      ...payload,
      variants: payload.variants.map((v) => {
        const live = liveByVid.get(v.supplierVariantId)!
        // v2 (spec 2026-09-01 Decision 1): the LIVE CJ variant image replaces whatever the agent
        // proposed — undefined CLEARS it (a variant CJ shows no image for gets none), and a
        // non-http(s) live value is treated as absent so this overwrite can never plant an
        // unfetchable URL in the payload. Same trust pattern as the cost overwrite above.
        const liveImage =
          live.imageUrl && (live.imageUrl.startsWith('http://') || live.imageUrl.startsWith('https://'))
            ? live.imageUrl
            : undefined
        return { ...v, supplierCostCents: live.priceCents, imageUrl: liveImage }
      }),
    }
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @doge-buddy/ops test test/sourcing-submit-winners.test.ts && pnpm --filter @doge-buddy/ops typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/sourcing/submit-winners.ts apps/ops/test/sourcing-submit-winners.test.ts
git commit -m "feat(sourcing): stage-6 overwrites variant imageUrl with the live CJ value"
```

---

### Task 6: Review pipeline module (pure)

**Files:**
- Create: `apps/ops/src/proposals/supplier-reviews.ts`
- Test: `apps/ops/test/supplier-reviews.test.ts`

**Interfaces:**
- Consumes: `SupplierProductReview` (`packages/supplier/src/types.ts:33-38` — fields `rating`, `content`, `reviewDate?`, `countryCode?`); `findClaimViolations`, `htmlToText` (`apps/ops/src/sourcing/guards.ts`); `SUPPLIER_REVIEWS_MAX`, `SupplierReviewsSchema`, `SupplierReviews` (Task 1).
- Produces: `buildSupplierReviews(fetched: SupplierProductReview[], now: Date): SupplierReviews | null`. Tasks 7 and 9 call exactly this.

- [ ] **Step 1: Write the failing test**

```ts
// apps/ops/test/supplier-reviews.test.ts
import { describe, expect, it } from 'vitest'
import type { SupplierProductReview } from '@doge-buddy/supplier'
import { buildSupplierReviews } from '../src/proposals/supplier-reviews.ts'

const NOW = new Date('2026-09-01T12:00:00.000Z')
const review = (over: Partial<SupplierProductReview> = {}): SupplierProductReview => ({
  rating: 5,
  content: 'Great toy, my dog loves it',
  ...over,
})

describe('buildSupplierReviews', () => {
  it('returns null for an empty fetch', () => {
    expect(buildSupplierReviews([], NOW)).toBeNull()
  })

  it('sanitizes HTML to plain text and caps at 500 chars', () => {
    const out = buildSupplierReviews([review({ content: `<b>Nice</b> &amp; sturdy ${'x'.repeat(600)}` })], NOW)
    expect(out!.reviews[0]!.text.startsWith('Nice & sturdy')).toBe(true)
    expect(out!.reviews[0]!.text.length).toBeLessThanOrEqual(500)
    expect(out!.reviews[0]!.text).not.toContain('<b>')
  })

  it('DROPS (never rewrites) a review whose text hits the claims list', () => {
    const out = buildSupplierReviews([review({ content: 'cured my dogs anxiety relief!' }), review()], NOW)
    expect(out!.reviews).toHaveLength(1)
    expect(out!.reviews[0]!.text).toBe('Great toy, my dog loves it')
  })

  it('returns null when every review is scrubbed away (empty section is worse than none)', () => {
    expect(buildSupplierReviews([review({ content: 'anxiety relief' })], NOW)).toBeNull()
    expect(buildSupplierReviews([review({ content: '<p></p>' })], NOW)).toBeNull()
  })

  it('sorts rating-desc then date-desc and keeps 10', () => {
    const fetched = [
      review({ rating: 4, reviewDate: '2026-01-01' }),
      review({ rating: 5, reviewDate: '2026-01-01' }),
      review({ rating: 5, reviewDate: '2026-06-01' }),
      ...Array.from({ length: 12 }, (_, i) => review({ rating: 3, reviewDate: `2026-02-${String(i + 1).padStart(2, '0')}` })),
    ]
    const out = buildSupplierReviews(fetched, NOW)!
    expect(out.reviews).toHaveLength(10)
    expect(out.reviews[0]).toMatchObject({ rating: 5, date: '2026-06-01' })
    expect(out.reviews[1]).toMatchObject({ rating: 5, date: '2026-01-01' })
    expect(out.reviews[2]).toMatchObject({ rating: 4 })
  })

  it('averages over ALL fetched (dropped ones included) and counts the fetched length', () => {
    const out = buildSupplierReviews([review({ rating: 5 }), review({ rating: 1, content: 'vet approved junk' })], NOW)!
    expect(out.average).toBe(3)
    expect(out.count).toBe(2)
    expect(out.reviews).toHaveLength(1)
  })

  it('normalizes country to 2-letter uppercase and drops junk country codes', () => {
    const out = buildSupplierReviews([review({ countryCode: 'us' }), review({ countryCode: 'USA' })], NOW)!
    expect(out.reviews.map((r) => r.country)).toEqual(['US', undefined])
  })

  it('stamps fetchedAt from the injected clock', () => {
    expect(buildSupplierReviews([review()], NOW)!.fetchedAt).toBe('2026-09-01T12:00:00.000Z')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @doge-buddy/ops test test/supplier-reviews.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
// apps/ops/src/proposals/supplier-reviews.ts
import { SUPPLIER_REVIEWS_MAX, SupplierReviewsSchema, type SupplierReviews } from '@doge-buddy/core'
import type { SupplierProductReview } from '@doge-buddy/supplier'
import { findClaimViolations, htmlToText } from '../sourcing/guards.ts'

const REVIEW_TEXT_MAX = 500

const clampRating = (rating: number): number => Math.min(5, Math.max(1, Math.round(rating)))

/**
 * Turns a raw supplier review fetch into the `dogebuddy.supplier_reviews` metafield value, or
 * `null` when nothing publishable survives — an empty reviews section is worse than none (spec
 * 2026-09-01 §Error handling). Shared by the apply worker (§A4.3) and backfill's v2 pass (§A5).
 *
 * Pipeline per spec §A4.3: sanitize each review to plain text (strip tags, collapse whitespace,
 * cap 500 chars), DROP any review whose text hits `findClaimViolations` — a supplier review
 * saying "cured my dog's anxiety" becomes OUR publication on our page, so reject-never-rewrite,
 * same stance as every other guard — drop empties, sort rating-desc then date-desc, keep 10.
 * `average` is over ALL fetched reviews (the kept subset must not launder into a better score);
 * `count` is the fetched length — the adapter returns a bare `SupplierProductReview[]` with no
 * total field (the `product/productComments` wire shape is still on cj-api-notes' "Still
 * unverified" list; the adapter maps it all-optional and this function assumes nothing more).
 */
export function buildSupplierReviews(fetched: SupplierProductReview[], now: Date): SupplierReviews | null {
  if (fetched.length === 0) return null

  const kept = fetched
    .map((r) => ({
      rating: clampRating(r.rating),
      text: htmlToText(r.content).slice(0, REVIEW_TEXT_MAX).trim(),
      ...(r.reviewDate ? { date: r.reviewDate } : {}),
      ...(r.countryCode && /^[A-Za-z]{2}$/.test(r.countryCode)
        ? { country: r.countryCode.toUpperCase() }
        : {}),
    }))
    .filter((r) => r.text.length > 0)
    .filter((r) => findClaimViolations(r.text).length === 0)
    .sort((a, b) => b.rating - a.rating || ((b as { date?: string }).date ?? '').localeCompare((a as { date?: string }).date ?? ''))
    .slice(0, SUPPLIER_REVIEWS_MAX)

  if (kept.length === 0) return null

  const average = fetched.reduce((sum, r) => sum + clampRating(r.rating), 0) / fetched.length

  return SupplierReviewsSchema.parse({
    average: Math.round(average * 10) / 10,
    count: fetched.length,
    reviews: kept,
    fetchedAt: now.toISOString(),
  })
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @doge-buddy/ops test test/supplier-reviews.test.ts && pnpm --filter @doge-buddy/ops typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/proposals/supplier-reviews.ts apps/ops/test/supplier-reviews.test.ts
git commit -m "feat(ops): supplier-review sanitize/scrub/sort/cap pipeline for the reviews metafield"
```

---

### Task 7: Apply worker — variant files, content metafields, review fetch, seed definitions

**Files:**
- Modify: `apps/ops/src/proposals/apply-new-listing.ts` (create path `:174-221`, flip `:317`, metafields hoist)
- Modify: `apps/ops/src/proposals/apply-shared.ts:107-110` (widen the adapter `Pick`)
- Modify: `apps/ops/src/seed/sample-data.ts:18-22` (`METAFIELD_DEFINITIONS`)
- Test: `apps/ops/test/proposal-apply.test.ts`

**Interfaces:**
- Consumes: `buildSupplierReviews` (Task 6); `NewListingPayload` v2 fields (Task 2); `adapter.getProductReviews` (`packages/supplier/src/types.ts:126` — already implemented for CJ and mock).
- Produces: `ApplyProposalDeps.adapter` `Pick` gains `'getProductReviews'` (the real wiring passes the full adapter, which structurally satisfies it — only test fakes need the new method). `productSet` CREATE input gains per-variant `file` and four content metafields; the ACTIVE flip re-sends metafields. New `info` alert kind `listing_reviews_unavailable`.

- [ ] **Step 1: Write the failing tests** — in `apps/ops/test/proposal-apply.test.ts`:

First extend the fixtures: `fakeAdapter()` (`:87-121`) gains a scripted `getProductReviews` (default: two clean reviews) and a recorder, e.g. `reviewReads: string[]`:

```ts
    getProductReviews: async (pid: string) => {
      reviewReads.push(pid)
      return [
        { rating: 5, content: 'Great toy, my dog loves it', reviewDate: '2026-06-01', countryCode: 'US' },
        { rating: 4, content: 'Sturdy and washable' },
      ]
    },
```

`newListingPayload()` (`:17`) gains v2 fields:

```ts
    highlights: ['Durable rope core', 'Machine washable', 'Non-slip grip'],
    specs: [{ label: 'Material', value: 'Cotton' }],
    whatsInBox: '1x rope toy',
    // and on its (single) variant:
    imageUrl: 'https://cdn.example.com/variant-1.jpg',
```

Then the new cases (capture `productSet` inputs by extending `fakeShopify`'s recorder to also push the input object, or by an `overrides.productSet` that stores its args):

```ts
it('CREATE productSet carries per-variant file, the v2 metafields, and product files exclude variant images', async () => {
  const inputs: Record<string, unknown>[] = []
  const shopify = fakeShopify({
    productSet: async (input) => {
      inputs.push(input)
      return { productId: 'gid://shopify/Product/901', variants: [{ id: 'gid://shopify/ProductVariant/9001', sku: (input as any).variants?.[0]?.sku, inventoryItemId: 'gid://shopify/InventoryItem/9001' }] }
    },
  })
  const { deps, row } = await seededNewListing({ shopify }) // reuse the file's existing seeding pattern
  await executeApplyProposal(deps, row)

  const create = inputs[0] as any
  expect(create.variants[0].file).toEqual({ originalSource: 'https://cdn.example.com/variant-1.jpg', contentType: 'IMAGE' })
  const keys = (create.metafields as { key: string; value: string }[]).map((m) => m.key)
  expect(keys).toEqual(expect.arrayContaining(['highlights', 'specs', 'whats_in_box', 'supplier_reviews', 'ships_from']))
  const reviews = JSON.parse((create.metafields as any[]).find((m) => m.key === 'supplier_reviews').value)
  expect(reviews).toMatchObject({ average: 4.5, count: 2 })
  expect(reviews.reviews).toHaveLength(2)
  // the variant's image URL must not double as a product-level file
  expect(create.files.map((f: { originalSource: string }) => f.originalSource)).not.toContain('https://cdn.example.com/variant-1.jpg')

  const flip = inputs[1] as any
  expect(flip.status).toBe('ACTIVE')
  expect(flip.metafields).toBeDefined() // metafields hoisted onto the flip (idempotent re-send)
  expect(flip.variants).toBeUndefined()
  expect(flip.files).toBeUndefined()
})

it('review fetch failure: listing proceeds, info alert listing_reviews_unavailable, no supplier_reviews metafield', async () => {
  const inputs: Record<string, unknown>[] = []
  const adapter = fakeAdapter({ getProductReviews: async () => { throw new Error('cj 500') } })
  // ... seed + run as above, assert:
  expect(alertCalls).toContainEqual(['info', 'listing_reviews_unavailable', expect.objectContaining({ error: 'cj 500' })])
  const keys = (inputs[0] as any).metafields.map((m: { key: string }) => m.key)
  expect(keys).not.toContain('supplier_reviews')
  // proposal still lands 'applied'
})

it('legacy payload (no v2 fields): applies clean with only the original three metafields', async () => {
  // seed with a payload that omits highlights/specs/whatsInBox and variant imageUrl
  // assert: no 'highlights'/'specs'/'whats_in_box' keys, no variant file, status applied
})
```

(Follow the file's real seeding helper (`seedProposal`) and `baseDeps()` — the sketches above name the assertions, the mechanics come from neighboring tests. `alert` in `baseDeps` is already a recorded fake or make it one.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @doge-buddy/ops test test/proposal-apply.test.ts`
Expected: new cases FAIL; existing cases still pass (v2 payload fields are ignored by the current worker).

- [ ] **Step 3: Implement** — in `apply-shared.ts`, widen the `Pick` (`:107-110`) to add `'getProductReviews'` and extend the docstring sentence: `getProductReviews` for `new_listing`'s apply-time supplier-review fetch (product-page v2 §A4.3).

In `apply-new-listing.ts`, inside `applyNewListing` after `catalogFields` (`:134-144`):

1. Declare before the create branch:

```ts
  let supplierReviews: ReturnType<typeof buildSupplierReviews> = null
```

2. In the `if (!productGid)` create branch, after the stock reads (`:179-181`) and before `productSet`:

```ts
    // v2 (spec 2026-09-01 §A4.3): fetch the supplier's marketplace reviews — plain code, never
    // the agent; the worker's own fetch is the only version ever published (Decision 3). 10 CJ
    // points from the listing's normal flow (this worker has no PointsAllowance — it is not
    // agent-driven). The productComments wire shape is on cj-api-notes' "Still unverified" list:
    // the adapter maps it all-optional, and failure or zero usable reviews just means the listing
    // proceeds without the metafield.
    const supplierPid = payload.variants[0]!.supplierProductId
    let reviewFetchError: string | undefined
    try {
      supplierReviews = buildSupplierReviews(await deps.adapter.getProductReviews(supplierPid), new Date())
    } catch (err) {
      reviewFetchError = err instanceof Error ? err.message : String(err)
      supplierReviews = null
    }
    if (!supplierReviews) {
      await deps
        .alert('info', 'listing_reviews_unavailable', {
          proposalId,
          supplierProductId: supplierPid,
          ...(reviewFetchError ? { error: reviewFetchError } : {}),
        })
        .catch(() => {})
    }
```

3. Build the metafields as a function of what's in scope (replacing the inline array at `:200-204`) — place next to `catalogFields`' construction so both productSet calls can use it, but note it must be BUILT after the review fetch; simplest is a small builder:

```ts
  /**
   * Metafields for BOTH `productSet` calls (create + the DRAFT→ACTIVE flip). Hoisted for the same
   * reason as `catalogFields` (see that comment): re-sending them on the flip costs nothing and is
   * idempotent — same values. `supplier_reviews` only rides when this run actually fetched them
   * (the create path); a resumed run's flip omits the key, which leaves the stored metafield
   * untouched (productSet upserts the metafields it is given, it does not clear omitted ones).
   */
  const buildMetafields = () => [
    { namespace: 'dogebuddy', key: 'ships_from', type: 'single_line_text_field', value: payload.shipsFrom },
    { namespace: 'dogebuddy', key: 'delivery_min_days', type: 'number_integer', value: String(payload.deliveryMinDays) },
    { namespace: 'dogebuddy', key: 'delivery_max_days', type: 'number_integer', value: String(payload.deliveryMaxDays) },
    // v2 structured content (spec 2026-09-01 Decision 7) — JSON the storefront parses with the
    // shared @doge-buddy/core schemas. Only written when the payload carries it (legacy payloads
    // apply fine and render the pre-v2 page).
    ...(payload.highlights
      ? [{ namespace: 'dogebuddy', key: 'highlights', type: 'json', value: JSON.stringify(payload.highlights) }]
      : []),
    ...(payload.specs
      ? [{ namespace: 'dogebuddy', key: 'specs', type: 'json', value: JSON.stringify(payload.specs) }]
      : []),
    ...(payload.whatsInBox
      ? [{ namespace: 'dogebuddy', key: 'whats_in_box', type: 'single_line_text_field', value: payload.whatsInBox }]
      : []),
    ...(supplierReviews
      ? [{ namespace: 'dogebuddy', key: 'supplier_reviews', type: 'json', value: JSON.stringify(supplierReviews) }]
      : []),
  ]
```

4. In the create `productSet` input: `metafields: buildMetafields(),` and change `files` to exclude URLs already attached per-variant:

```ts
      files: payload.imageUrls
        .filter((url) => !payload.variants.some((v) => v.imageUrl === url))
        .map((url) => ({ originalSource: url, contentType: 'IMAGE' })),
```

and the variants map gains (after the `compareAtPrice` spread):

```ts
        // FIXTURE-ASSUMPTION (2026-07 API), live-verify on the first v2 listing: per-variant
        // `file` ({ originalSource, contentType }) on ProductVariantSetInput attaches the
        // variant's image in the same productSet. If the live schema rejects it, the fallback is
        // the backfill pair (productCreateMedia + productVariantAppendMedia) run post-create —
        // spec 2026-09-01 Decision 13 / §Error handling.
        ...(v.imageUrl ? { file: { originalSource: v.imageUrl, contentType: 'IMAGE' } } : {}),
```

5. The flip (`:317`) becomes:

```ts
  await deps.shopify.productSet({ id: productGid, status: 'ACTIVE', ...catalogFields, metafields: buildMetafields() })
```

6. Imports: `import { buildSupplierReviews } from './supplier-reviews.ts'`.

In `apps/ops/src/seed/sample-data.ts`, extend `METAFIELD_DEFINITIONS`:

```ts
  { name: 'Highlights', namespace: 'dogebuddy', key: 'highlights', type: 'json', ownerType: 'PRODUCT' },
  { name: 'Specs', namespace: 'dogebuddy', key: 'specs', type: 'json', ownerType: 'PRODUCT' },
  { name: 'Supplier reviews', namespace: 'dogebuddy', key: 'supplier_reviews', type: 'json', ownerType: 'PRODUCT' },
  { name: "What's in the box", namespace: 'dogebuddy', key: 'whats_in_box', type: 'single_line_text_field', ownerType: 'PRODUCT' },
```

- [ ] **Step 4: Run the touched suites + typecheck** — seed tests may pin the definitions count; update them in the same commit.

Run: `pnpm --filter @doge-buddy/ops test test/proposal-apply.test.ts && pnpm --filter @doge-buddy/ops test && pnpm --filter @doge-buddy/ops typecheck`
Expected: PASS (the full-suite run catches every other fake that must gain `getProductReviews` — `apply-refund/support-reply/deprecate` test fakes share `ApplyProposalDeps`).

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/proposals/apply-new-listing.ts apps/ops/src/proposals/apply-shared.ts apps/ops/src/seed/sample-data.ts apps/ops/test/proposal-apply.test.ts
git commit -m "feat(ops): apply worker writes variant files, content metafields, and fetched supplier reviews"
```

---

### Task 8: Shopify Admin media + metafieldsSet operations

**Files:**
- Modify: `packages/shopify-admin/src/operations.ts` (append 5 operations)
- Test: `packages/shopify-admin/test/operations.test.ts` (mirror the file's existing mocked-client pattern)
- Scratchpad (not committed): an introspection probe script

**Interfaces:**
- Consumes: `ShopifyAdminClient.graphql` + `assertNoUserErrors` (both already in the file).
- Produces (Task 9 consumes these exact signatures):
  - `productCreateMedia(client, productGid: string, media: { originalSource: string; alt?: string }[]): Promise<{ id: string; status: string }[]>`
  - `productVariantAppendMedia(client, productGid: string, variantMedia: { variantId: string; mediaIds: string[] }[]): Promise<void>`
  - `productVariantMediaState(client, productGid: string): Promise<{ id: string; sku?: string; mediaId: string | null }[]>`
  - `mediaImageStatus(client, mediaGid: string): Promise<string>`
  - `metafieldsSet(client, metafields: { ownerId: string; namespace: string; key: string; type: string; value: string }[]): Promise<void>`

- [ ] **Step 1: Run the read-only introspection probe** (house rule: introspect the LIVE 2026-07 schema for every new Shopify call). Write to the scratchpad, run with the MAIN checkout's env (worktrees have no `.env`):

```ts
// <scratchpad>/media-introspect.mts — read-only introspection, run once, paste findings into comments
import { loadDotEnv } from '/home/robert/Desktop/code/ClosingBrackets/doge-buddy/apps/ops/src/config.ts' // or however catalog-probe2.mts loaded env — copy that file's header verbatim
// ... construct ShopifyTokenManager + ShopifyAdminClient exactly like apps/ops/scripts/backfill-listings.ts:106-107 ...
const q = async (query: string) => console.log(JSON.stringify(await client.graphql(query), null, 2))
await q(`{ __type(name: "Mutation") { fields { name } } }`) // grep output for: productCreateMedia, productVariantAppendMedia, metafieldsSet
await q(`{ __type(name: "CreateMediaInput") { inputFields { name type { kind name ofType { name } } } } }`)
await q(`{ __type(name: "ProductVariantAppendMediaInput") { inputFields { name } } }`)
await q(`{ __type(name: "ProductCreateMediaPayload") { fields { name } } }`) // userErrors vs mediaUserErrors
await q(`{ __type(name: "ProductVariantAppendMediaPayload") { fields { name } } }`)
await q(`{ __type(name: "MetafieldsSetInput") { inputFields { name } } }`)
await q(`{ __type(name: "ProductVariant") { fields { name } } }`) // confirm media / image field
await q(`{ __type(name: "MediaImage") { fields { name } } }`) // confirm status
```

Run: `set -a && . /home/robert/Desktop/code/ClosingBrackets/doge-buddy/apps/ops/.env && set +a && pnpm --filter @doge-buddy/ops exec tsx <scratchpad>/media-introspect.mts` (the `. .env` form, NOT `env $(grep|xargs)` — that corrupts PEM newlines).

Record every confirmed argument/field name in the new operations' `// LIVE-VERIFIED 2026-09-01 by introspection` comments. **Decision points the probe settles:**
- If `productCreateMedia` is ABSENT from the 2026-07 Mutation fields (Shopify has been deprecating it in favor of `productUpdate(media:)`), STOP and flag in your task report before writing code — the orchestrator will re-plan that one op around `productUpdate`'s already-live-verified `media: [CreateMediaInput!]` argument (its payload must then select `product { media }` to recover created media ids). Do not improvise silently.
- If the create payload's error field is `mediaUserErrors` (likely) rather than `userErrors`, check it explicitly instead of `assertNoUserErrors` (which reads `.userErrors`).
- If credentials are unavailable in this environment, proceed with the code below marked `// FIXTURE-ASSUMPTION (2026-07 API), verify on the first backfill run:` and say so in the task report.

- [ ] **Step 2: Write the failing tests** — mirror `packages/shopify-admin/test/operations.test.ts`'s existing pattern (mocked `client.graphql`, assert document + variables + userErrors throw). One representative case per op:

```ts
describe('productCreateMedia', () => {
  it('sends productId + media and returns created media ids/statuses', async () => {
    const client = mockClient({
      productCreateMedia: {
        media: [{ id: 'gid://shopify/MediaImage/1', status: 'UPLOADED' }],
        mediaUserErrors: [],
      },
    })
    const out = await productCreateMedia(client, 'gid://shopify/Product/1', [{ originalSource: 'https://x/a.jpg' }])
    expect(out).toEqual([{ id: 'gid://shopify/MediaImage/1', status: 'UPLOADED' }])
    expect(client.lastVariables()).toMatchObject({ productId: 'gid://shopify/Product/1' })
  })
  it('throws on mediaUserErrors', async () => { /* errors array non-empty -> rejects */ })
})
// analogous single happy-path + error case for productVariantAppendMedia, productVariantMediaState,
// mediaImageStatus, metafieldsSet — copy the mock/client helper the file already uses.
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @doge-buddy/shopify-admin test`
Expected: new cases FAIL (functions don't exist).

- [ ] **Step 4: Implement** — append to `operations.ts`, following the file's five-part convention (comment → `const *_MUTATION`/`_QUERY` with `#graphql` → private `interface *Data` → exported function → error assert). The probe's findings replace/confirm the comment text:

```ts
// LIVE-VERIFIED 2026-09-01 by introspection of the 2026-07 Admin schema (see the product-page-v2
// plan, Task 8) — mutation runtime behavior is first exercised by the backfill-listings v2 run:
//  - `Mutation.productCreateMedia(productId: ID!, media: [CreateMediaInput!]!)`;
//    `CreateMediaInput { originalSource, alt, mediaContentType }`; payload carries
//    `mediaUserErrors` (NOT `userErrors`) and `media { ... on MediaImage { id status } }`.
//  - Media processing is ASYNC: created media starts UPLOADED and must reach READY before
//    `productVariantAppendMedia` will accept it — callers poll `mediaImageStatus` below.
const PRODUCT_CREATE_MEDIA_MUTATION = `#graphql
  mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media { ... on MediaImage { id status } }
      mediaUserErrors { field message }
    }
  }
`

interface ProductCreateMediaData {
  productCreateMedia: {
    media: { id: string; status: string }[] | null
    mediaUserErrors: ShopifyUserErrorEntry[]
  }
}

export async function productCreateMedia(
  client: ShopifyAdminClient,
  productGid: string,
  media: { originalSource: string; alt?: string }[],
): Promise<{ id: string; status: string }[]> {
  const data = await client.graphql<ProductCreateMediaData>(PRODUCT_CREATE_MEDIA_MUTATION, {
    productId: productGid,
    media: media.map((m) => ({ originalSource: m.originalSource, mediaContentType: 'IMAGE', ...(m.alt ? { alt: m.alt } : {}) })),
  })
  const errors = data.productCreateMedia.mediaUserErrors
  if (errors.length > 0) {
    throw new Error(`productCreateMedia: ${errors.map((e) => e.message).join('; ')}`)
  }
  return data.productCreateMedia.media ?? []
}
```

```ts
const PRODUCT_VARIANT_APPEND_MEDIA_MUTATION = `#graphql
  mutation ProductVariantAppendMedia($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
    productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
      productVariants { id }
      userErrors { field message }
    }
  }
`

interface ProductVariantAppendMediaData {
  productVariantAppendMedia: { productVariants: { id: string }[] | null; userErrors: ShopifyUserErrorEntry[] }
}

export async function productVariantAppendMedia(
  client: ShopifyAdminClient,
  productGid: string,
  variantMedia: { variantId: string; mediaIds: string[] }[],
): Promise<void> {
  const data = await client.graphql<ProductVariantAppendMediaData>(PRODUCT_VARIANT_APPEND_MEDIA_MUTATION, {
    productId: productGid,
    variantMedia,
  })
  assertNoUserErrors(data, 'productVariantAppendMedia')
}
```

```ts
// Read side for the backfill's idempotency check — a variant that already shows media is SKIPPED
// (spec 2026-09-01 §A5). `media(first: 1)` rather than the deprecated `image` field.
const PRODUCT_VARIANT_MEDIA_STATE_QUERY = `#graphql
  query ProductVariantMediaState($id: ID!) {
    product(id: $id) {
      variants(first: 250) {
        nodes { id sku media(first: 1) { nodes { id } } }
      }
    }
  }
`

interface ProductVariantMediaStateData {
  product: {
    variants: { nodes: { id: string; sku: string | null; media: { nodes: { id: string }[] } }[] }
  } | null
}

export async function productVariantMediaState(
  client: ShopifyAdminClient,
  productGid: string,
): Promise<{ id: string; sku?: string; mediaId: string | null }[]> {
  const data = await client.graphql<ProductVariantMediaStateData>(PRODUCT_VARIANT_MEDIA_STATE_QUERY, { id: productGid })
  return (data.product?.variants.nodes ?? []).map((v) => ({
    id: v.id,
    sku: v.sku ?? undefined,
    mediaId: v.media.nodes[0]?.id ?? null,
  }))
}
```

```ts
const MEDIA_IMAGE_STATUS_QUERY = `#graphql
  query MediaImageStatus($id: ID!) {
    node(id: $id) { ... on MediaImage { status } }
  }
`

interface MediaImageStatusData {
  node: { status?: string } | null
}

/** Media processing status (UPLOADED → PROCESSING → READY | FAILED) — poll before append. */
export async function mediaImageStatus(client: ShopifyAdminClient, mediaGid: string): Promise<string> {
  const data = await client.graphql<MediaImageStatusData>(MEDIA_IMAGE_STATUS_QUERY, { id: mediaGid })
  return data.node?.status ?? 'UNKNOWN'
}
```

```ts
const METAFIELDS_SET_MUTATION = `#graphql
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`

interface MetafieldsSetData {
  metafieldsSet: { metafields: { id: string }[] | null; userErrors: ShopifyUserErrorEntry[] }
}

/** Upserts metafields on existing owners — the backfill's write path for `supplier_reviews`
 * (a full `productSet` on an existing product is forbidden — apply-new-listing.ts:125-133). */
export async function metafieldsSet(
  client: ShopifyAdminClient,
  metafields: { ownerId: string; namespace: string; key: string; type: string; value: string }[],
): Promise<void> {
  const data = await client.graphql<MetafieldsSetData>(METAFIELDS_SET_MUTATION, { metafields })
  assertNoUserErrors(data, 'metafieldsSet')
}
```

(Adjust error-field names to whatever the probe showed; export everything through the package's existing barrel if `operations.ts` isn't the entrypoint itself.)

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @doge-buddy/shopify-admin test && pnpm --filter @doge-buddy/shopify-admin typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shopify-admin/src/operations.ts packages/shopify-admin/test/operations.test.ts
git commit -m "feat(shopify-admin): media create/append/status, variant media state, metafieldsSet"
```

---

### Task 9: Backfill v2 pass — variant images + reviews for live products

**Files:**
- Create: `apps/ops/src/catalog/backfill-v2.ts`
- Modify: `apps/ops/scripts/backfill-listings.ts` (wire the pass after the existing one)
- Test: `apps/ops/test/catalog-backfill-v2.test.ts`

**Interfaces:**
- Consumes: Task 8's five operations (curried, same style as `BackfillOps` in `scripts/backfill-listings.ts:117-125`); `buildSupplierReviews` (Task 6); `adapter.getProduct`/`getProductReviews`; tables `products`/`productVariants`/`supplierVariantMappings` (`supplierProductId` IS on the mapping — `packages/db/src/schema.ts:61`).
- Produces:

```ts
export interface BackfillV2Ops {
  productVariantMediaState(productGid: string): Promise<{ id: string; sku?: string; mediaId: string | null }[]>
  productCreateMedia(productGid: string, media: { originalSource: string; alt?: string }[]): Promise<{ id: string; status: string }[]>
  mediaImageStatus(mediaGid: string): Promise<string>
  productVariantAppendMedia(productGid: string, variantMedia: { variantId: string; mediaIds: string[] }[]): Promise<void>
  metafieldsSet(metafields: { ownerId: string; namespace: string; key: string; type: string; value: string }[]): Promise<void>
}
export interface BackfillV2Deps {
  db: Db
  ops: BackfillV2Ops
  adapter: Pick<SupplierAdapter, 'getProduct' | 'getProductReviews'>
  alert: Alert
  log: (line: string) => void
  now?: () => Date
  sleep?: (ms: number) => Promise<void> // injectable for tests; default setTimeout
}
export interface BackfillV2Result {
  products: number
  variantImagesAdded: number
  reviewsWritten: number
  failures: string[]
}
export async function backfillProductPageV2(deps: BackfillV2Deps, opts: { dryRun: boolean }): Promise<BackfillV2Result>
```

- [ ] **Step 1: Write the failing tests** — new file `apps/ops/test/catalog-backfill-v2.test.ts`, copying `catalog-backfill.test.ts`'s conventions exactly: real Postgres, `PREFIX`-scoped uids + cleanup, a **scripted throw-on-unscripted ops object** (the suite touches the shared dev DB — an unscripted product gid must throw, never default-answer), injected `now`, and here also injected `sleep: async () => {}`. Cases:

```ts
it('adds media + appends to a variant that has a CJ image and no Shopify media', async () => {
  // seed: active product w/ gid, one variant w/ shopifyVariantGid + mapping (supplierProductId 'cj-p1')
  // script: getProduct -> variant imageUrl 'https://cj/x.jpg'; productVariantMediaState -> mediaId: null
  //         productCreateMedia -> [{ id: 'gid://shopify/MediaImage/1', status: 'UPLOADED' }]
  //         mediaImageStatus -> 'READY'
  // assert: productVariantAppendMedia called with { variantId: <gid>, mediaIds: ['gid://shopify/MediaImage/1'] }
  //         result.variantImagesAdded === 1
})

it('SKIPS a variant that already has Shopify media (idempotency)', async () => {
  // productVariantMediaState -> mediaId: 'gid://shopify/MediaImage/9'
  // assert: productCreateMedia NEVER called for it; rerunning the pass is a no-op
})

it('skips a variant CJ shows no image for', async () => { /* getProduct variant has no imageUrl */ })

it('polls until READY and gives up on FAILED with a warning alert, no append', async () => {
  // mediaImageStatus scripted: 'PROCESSING', then 'FAILED'
  // assert: alert('warning', 'backfill_media_not_ready', ...); productVariantAppendMedia not called
})

it('writes the supplier_reviews metafield from a fresh fetch', async () => {
  // getProductReviews -> two clean reviews
  // assert: metafieldsSet called once with ownerId=<product gid>, key 'supplier_reviews', type 'json',
  //         and a value that SupplierReviewsSchema.parse accepts; result.reviewsWritten === 1
})

it('zero usable reviews -> info alert listing_reviews_unavailable, no metafieldsSet', async () => {})

it('does NOT touch highlights/specs metafields (no agent ran for live products — spec §A5)', async () => {
  // assert metafieldsSet only ever received the supplier_reviews key
})

it('dry-run: logs the plan, makes ZERO ops/adapter-write calls, still counts products', async () => {})

it('failure containment: a product whose CJ detail read throws lands in failures, the next product still processes', async () => {})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm db:up && pnpm --filter @doge-buddy/ops test test/catalog-backfill-v2.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `backfill-v2.ts`** — structure (mirror `backfill.ts`'s per-product try/catch containment and its candidates query `backfill.ts:151-155` and variant/mapping join `:206-222`):

```ts
export async function backfillProductPageV2(deps: BackfillV2Deps, opts: { dryRun: boolean }): Promise<BackfillV2Result> {
  const now = deps.now ?? (() => new Date())
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const result: BackfillV2Result = { products: 0, variantImagesAdded: 0, reviewsWritten: 0, failures: [] }

  const candidates = await deps.db
    .select()
    .from(products)
    .where(and(eq(products.status, 'active'), isNotNull(products.shopifyProductGid)))
    .orderBy(asc(products.createdAt), asc(products.id))

  for (const product of candidates) {
    result.products += 1
    try {
      // 1. Variant rows + first mapping per variant (same dedupe as backfill.ts:206-222), but this
      //    pass needs shopifyVariantGid + supplierProductId/supplierVariantId.
      //    Skip the product entirely when no variant has a cj mapping.
      // 2. One CJ detail read: const detail = await deps.adapter.getProduct(pid)
      //    cjImageByVid = Map(supplierVariantId -> http(s)-only imageUrl)
      // 3. Shopify media state: await deps.ops.productVariantMediaState(productGid) keyed by variant gid.
      // 4. Per variant with a CJ image, a shopifyVariantGid, and mediaId === null:
      //    dryRun ? log(`[dry-run] would add media for ${sku}`) :
      //      const [media] = await deps.ops.productCreateMedia(productGid, [{ originalSource: url, alt: product.title }])
      //      poll: up to 15 attempts, sleep(2000) between, until mediaImageStatus(media.id) === 'READY'
      //        ('FAILED' or attempts exhausted -> alert('warning', 'backfill_media_not_ready', {...}); continue)
      //      await deps.ops.productVariantAppendMedia(productGid, [{ variantId, mediaIds: [media.id] }])
      //      result.variantImagesAdded += 1
      // 5. Reviews (same pipeline as apply — spec §A5 writes ONLY supplier_reviews; content
      //    metafields are NOT synthesized, no agent ran for these products):
      //    fetched = await deps.adapter.getProductReviews(pid) (try/catch -> treat as [])
      //    const reviews = buildSupplierReviews(fetched, now())
      //    reviews === null -> alert('info', 'listing_reviews_unavailable', { source: 'backfill', ... })
      //    else dryRun ? log : await deps.ops.metafieldsSet([{ ownerId: productGid, namespace: 'dogebuddy',
      //      key: 'supplier_reviews', type: 'json', value: JSON.stringify(reviews) }]); result.reviewsWritten += 1
    } catch (err) {
      result.failures.push(`${product.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return result
}
```

(The numbered comments above are the shape — write them as real code with the exact drizzle imports `backfill.ts` uses. Every alert kind used: `backfill_media_not_ready` (warning), `listing_reviews_unavailable` (info).)

Wire into `scripts/backfill-listings.ts` after the existing `backfillListings` call (`:128-131`): build

```ts
  const v2Ops = {
    productVariantMediaState: (gid: string) => productVariantMediaState(client, gid),
    productCreateMedia: (gid: string, media: { originalSource: string; alt?: string }[]) => productCreateMedia(client, gid, media),
    mediaImageStatus: (gid: string) => mediaImageStatus(client, gid),
    productVariantAppendMedia: (gid: string, vm: { variantId: string; mediaIds: string[] }[]) => productVariantAppendMedia(client, gid, vm),
    metafieldsSet: (m: Parameters<typeof metafieldsSet>[1]) => metafieldsSet(client, m),
  }
  const v2 = await backfillProductPageV2({ db, ops: v2Ops, adapter, alert, log: console.log }, { dryRun })
  console.log(`v2 pass: ${v2.products} product(s), ${v2.variantImagesAdded} variant image(s), ${v2.reviewsWritten} review metafield(s), ${v2.failures.length} failure(s)`)
```

and fold `v2.failures` into the script's existing exit-code logic. Note the script's dry-run path constructs the Shopify client only when creds exist — mirror however pass 1 guards that (dry-run must not need creds).

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @doge-buddy/ops test test/catalog-backfill-v2.test.ts && pnpm --filter @doge-buddy/ops test test/catalog-backfill.test.ts && pnpm --filter @doge-buddy/ops typecheck`
Expected: PASS, and the pre-existing backfill suite untouched.

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/catalog/backfill-v2.ts apps/ops/scripts/backfill-listings.ts apps/ops/test/catalog-backfill-v2.test.ts
git commit -m "feat(ops): backfill-listings v2 pass — variant images + supplier_reviews for live products"
```

---

### Task 10: Storefront — metafield parsing lib + query + loader

**Files:**
- Create: `apps/storefront/app/lib/product-content.ts`
- Modify: `apps/storefront/app/routes/products.$handle.tsx` (fragments `:179-264`, loader `:92-94`)
- Regenerate: `apps/storefront/storefrontapi.generated.d.ts` (via codegen)
- Test: `apps/storefront/app/lib/__tests__/product-content.test.ts`

**Interfaces:**
- Consumes: core schemas (Task 1).
- Produces: `parseProductContent(product) => ProductContent` where

```ts
export interface ProductContent {
  highlights: ProductHighlights | null;
  specs: ProductSpecs | null;
  supplierReviews: SupplierReviews | null;
  whatsInBox: string | null;
}
```

  and the loader returns `{product, content}`. The fragment gains `media`, `weight`/`weightUnit`, and 4 metafield aliases (`highlights`, `specs`, `whatsInBox`, `supplierReviews`). Tasks 11–16 consume `content.*` and `product.media.nodes`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/storefront/app/lib/__tests__/product-content.test.ts
import {parseProductContent} from '../product-content';

const mf = (value: string) => ({value});

it('parses valid metafield JSON through the shared schemas', () => {
  const content = parseProductContent({
    highlights: mf(JSON.stringify(['Durable rope core', 'Machine washable', 'Non-slip grip'])),
    specs: mf(JSON.stringify([{label: 'Material', value: 'Cotton'}])),
    supplierReviews: mf(
      JSON.stringify({
        average: 4.6,
        count: 1238,
        reviews: [{rating: 5, text: 'Great toy'}],
        fetchedAt: '2026-09-01T00:00:00.000Z',
      }),
    ),
    whatsInBox: mf('1x rope toy'),
  });
  expect(content.highlights).toHaveLength(3);
  expect(content.specs?.[0]).toEqual({label: 'Material', value: 'Cotton'});
  expect(content.supplierReviews?.count).toBe(1238);
  expect(content.whatsInBox).toBe('1x rope toy');
});

it.each([
  ['absent metafields', {}],
  ['invalid JSON', {highlights: mf('{not json'), specs: mf('['), supplierReviews: mf('x')}],
  ['JSON failing the schema', {highlights: mf('["a"]'), specs: mf('[]'), supplierReviews: mf('{"average":9}')}],
])('degrades to all-null on %s (never throws)', (_name, product) => {
  const content = parseProductContent(product);
  expect(content).toEqual({highlights: null, specs: null, supplierReviews: null, whatsInBox: null});
});

it('trims whatsInBox and nulls a blank one', () => {
  expect(parseProductContent({whatsInBox: mf('  ')}).whatsInBox).toBeNull();
  expect(parseProductContent({whatsInBox: mf(' 1x toy ')}).whatsInBox).toBe('1x toy');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @doge-buddy/storefront test app/lib/__tests__/product-content.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the lib**

```tsx
// apps/storefront/app/lib/product-content.ts
import {
  ProductHighlightsSchema,
  ProductSpecsSchema,
  SupplierReviewsSchema,
} from '@doge-buddy/core';
import type {
  ProductHighlights,
  ProductSpecs,
  SupplierReviews,
} from '@doge-buddy/core';

/**
 * Parses the dogebuddy product-content metafields (product-page-v2 spec §B1). ANY failure —
 * missing metafield, invalid JSON, JSON that fails the shared schema — yields null for that
 * field, so the section renders nothing and the page equals the pre-v2 page. Never a 500.
 */

// Structural schema type so this app doesn't need its own zod dependency — the schemas come
// from @doge-buddy/core.
type Parser<T> = {
  safeParse: (value: unknown) => {success: true; data: T} | {success: false};
};

function parseJsonMetafield<T>(
  schema: Parser<T>,
  raw: string | null | undefined,
): T | null {
  if (!raw) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

type MetafieldValue = {value: string} | null | undefined;

export interface ProductContent {
  highlights: ProductHighlights | null;
  specs: ProductSpecs | null;
  supplierReviews: SupplierReviews | null;
  whatsInBox: string | null;
}

export function parseProductContent(product: {
  highlights?: MetafieldValue;
  specs?: MetafieldValue;
  supplierReviews?: MetafieldValue;
  whatsInBox?: MetafieldValue;
}): ProductContent {
  const whatsInBox = product.whatsInBox?.value?.trim() ?? '';
  return {
    highlights: parseJsonMetafield(ProductHighlightsSchema, product.highlights?.value),
    specs: parseJsonMetafield(ProductSpecsSchema, product.specs?.value),
    supplierReviews: parseJsonMetafield(SupplierReviewsSchema, product.supplierReviews?.value),
    whatsInBox: whatsInBox ? whatsInBox.slice(0, 200) : null,
  };
}
```

- [ ] **Step 4: Extend the fragments** in `products.$handle.tsx` — in `PRODUCT_VARIANT_FRAGMENT` (after `unitPrice`, `:209-212`):

```graphql
    weight
    weightUnit
```

In `PRODUCT_FRAGMENT` (after the `deliveryMaxDays` metafield, `:259-261`):

```graphql
    media(first: 10) {
      nodes {
        ... on MediaImage {
          id
          image {
            __typename
            id
            url
            altText
            width
            height
          }
        }
      }
    }
    highlights: metafield(namespace: "dogebuddy", key: "highlights") {
      value
    }
    specs: metafield(namespace: "dogebuddy", key: "specs") {
      value
    }
    whatsInBox: metafield(namespace: "dogebuddy", key: "whats_in_box") {
      value
    }
    supplierReviews: metafield(namespace: "dogebuddy", key: "supplier_reviews") {
      value
    }
```

(`__typename` inside `image` is deliberate — it makes the media image structurally identical to `ProductVariantFragment['image']` so `ProductImage` accepts it unchanged.)

In `loadCriticalData`, change the return (`:92-94`) to:

```tsx
  return {
    product,
    content: parseProductContent(product),
  };
```

with `import {parseProductContent} from '~/lib/product-content';` — parsing lives in the loader so a malformed metafield can only ever produce `null`s, computed once server-side.

- [ ] **Step 5: Codegen + run**

Run: `pnpm --filter @doge-buddy/storefront codegen && pnpm --filter @doge-buddy/storefront test && pnpm --filter @doge-buddy/storefront typecheck`
Expected: PASS; `storefrontapi.generated.d.ts` now carries `media`, `weight`, `weightUnit`, and the four new metafield aliases. Commit the regenerated file.

- [ ] **Step 6: Commit**

```bash
git add apps/storefront/app/lib/product-content.ts apps/storefront/app/lib/__tests__/product-content.test.ts apps/storefront/app/routes/products.\$handle.tsx apps/storefront/storefrontapi.generated.d.ts
git commit -m "feat(storefront): product v2 query (media, weight, content metafields) + null-safe parsing"
```

---

### Task 11: `ProductGallery`

**Files:**
- Create: `apps/storefront/app/components/product/ProductGallery.tsx`
- Test: `apps/storefront/app/components/product/__tests__/product-gallery.test.tsx`

**Interfaces:**
- Consumes: `ProductImage` (`~/components/ProductImage`) unchanged; `Image` from `@shopify/hydrogen`.
- Produces:

```tsx
export interface GalleryImage {
  __typename: 'Image';
  id?: string | null;
  url: string;
  altText?: string | null;
  width?: number | null;
  height?: number | null;
}
export interface GalleryMediaNode {
  id: string;
  image?: GalleryImage | null;
}
export function ProductGallery(props: {media: GalleryMediaNode[]; variantImage: GalleryImage | null | undefined}): JSX.Element;
```

  Task 16 renders `<ProductGallery media={product.media.nodes} variantImage={selectedVariant?.image} />` (the generated types are structurally assignable to these).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/storefront/app/components/product/__tests__/product-gallery.test.tsx
import {fireEvent, render, screen} from '@testing-library/react';
import {ProductGallery} from '../ProductGallery';

const img = (n: number) => ({
  __typename: 'Image' as const,
  id: `img-${n}`,
  url: `https://cdn.example.com/${n}.jpg`,
  altText: `Image ${n}`,
  width: 800,
  height: 800,
});
const media = (n: number) => ({id: `media-${n}`, image: img(n)});

it('renders the mascot placeholder with no media and no variant image (today\'s page)', () => {
  render(<ProductGallery media={[]} variantImage={null} />);
  expect(screen.getByRole('img', {name: /doge buddy mascot/i})).toBeInTheDocument();
});

it('renders no thumbnail row for a single image', () => {
  render(<ProductGallery media={[media(1)]} variantImage={null} />);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it('clicking a thumb swaps the main image', () => {
  render(<ProductGallery media={[media(1), media(2)]} variantImage={img(1)} />);
  fireEvent.click(screen.getByRole('button', {name: /show image 2/i}));
  const main = screen.getAllByRole('img')[0]!;
  expect(main.getAttribute('src')).toContain('2.jpg');
});

it('variant image wins by default; a variant CHANGE resets an explicit thumb choice', () => {
  const {rerender} = render(
    <ProductGallery media={[media(1), media(2), media(3)]} variantImage={img(1)} />,
  );
  fireEvent.click(screen.getByRole('button', {name: /show image 3/i}));
  expect(screen.getAllByRole('img')[0]!.getAttribute('src')).toContain('3.jpg');
  rerender(<ProductGallery media={[media(1), media(2), media(3)]} variantImage={img(2)} />);
  expect(screen.getAllByRole('img')[0]!.getAttribute('src')).toContain('2.jpg');
});

it('falls back to the first media image when the variant has none', () => {
  render(<ProductGallery media={[media(1), media(2)]} variantImage={null} />);
  expect(screen.getAllByRole('img')[0]!.getAttribute('src')).toContain('1.jpg');
});
```

(Hydrogen's `<Image>` renders an `<img>` with the url in `src`/`srcSet` under jsdom; if the exact attribute differs, assert on `srcset` — check what the DOM shows and pin that.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @doge-buddy/storefront test app/components/product/__tests__/product-gallery.test.tsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```tsx
// apps/storefront/app/components/product/ProductGallery.tsx
import {useEffect, useState} from 'react';
import {Image} from '@shopify/hydrogen';
import {ProductImage} from '~/components/ProductImage';

export interface GalleryImage {
  __typename: 'Image';
  id?: string | null;
  url: string;
  altText?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface GalleryMediaNode {
  id: string;
  image?: GalleryImage | null;
}

/**
 * Main product image + thumbnail row (product-page-v2 spec Decision 9). Main image precedence:
 * explicitly clicked thumb → selected variant's image → first media image → mascot placeholder
 * (ProductImage's own fallback). A variant change snaps back to the variant's image by clearing
 * the explicit choice. One image = no thumb row (today's rendering).
 */
export function ProductGallery({
  media,
  variantImage,
}: {
  media: GalleryMediaNode[];
  variantImage: GalleryImage | null | undefined;
}) {
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const variantImageId = variantImage?.id ?? null;
  useEffect(() => {
    setSelectedMediaId(null);
  }, [variantImageId]);

  const images = media.filter(
    (node): node is GalleryMediaNode & {image: GalleryImage} => Boolean(node.image),
  );
  const selected = selectedMediaId
    ? images.find((node) => node.id === selectedMediaId)
    : undefined;
  const mainImage = selected?.image ?? variantImage ?? images[0]?.image ?? null;

  return (
    <div>
      <ProductImage image={mainImage} />
      {images.length > 1 ? (
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {images.map((node, index) => {
            const isCurrent =
              mainImage != null &&
              (node.image.id === mainImage.id || node.image.url === mainImage.url);
            return (
              <button
                key={node.id}
                type="button"
                aria-label={`Show image ${index + 1}`}
                aria-current={isCurrent}
                onClick={() => setSelectedMediaId(node.id)}
                className={`h-20 w-20 shrink-0 overflow-hidden rounded-xl border-2 bg-surface-raised ${
                  isCurrent ? 'border-ink' : 'border-ink/20'
                }`}
              >
                <Image
                  alt={node.image.altText || 'Product image thumbnail'}
                  aspectRatio="1/1"
                  data={node.image}
                  loading="lazy"
                  sizes="80px"
                />
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
```

(`ProductImage`'s prop is `ProductVariantFragment['image']`; `GalleryImage` is structurally assignable to it. If tsc disagrees on an optionality detail after codegen, align `GalleryImage`'s field optionality to the generated type rather than touching `ProductImage`.)

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @doge-buddy/storefront test app/components/product/__tests__/product-gallery.test.tsx && pnpm --filter @doge-buddy/storefront typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/storefront/app/components/product/ProductGallery.tsx apps/storefront/app/components/product/__tests__/product-gallery.test.tsx
git commit -m "feat(storefront): ProductGallery with thumb row and variant snap-back"
```

---

### Task 12: `ProductHighlights`, `ProductSpecs`, `WhatsInBox`

**Files:**
- Create: `apps/storefront/app/components/product/ProductHighlights.tsx`
- Create: `apps/storefront/app/components/product/ProductSpecs.tsx`
- Create: `apps/storefront/app/components/product/WhatsInBox.tsx`
- Test: `apps/storefront/app/components/product/__tests__/product-content-sections.test.tsx`

**Interfaces:**
- Consumes: `ProductHighlights`/`ProductSpecs` types from `@doge-buddy/core` (Task 1).
- Produces:

```tsx
export function ProductHighlights(props: {highlights: ProductHighlights | null}): JSX.Element | null;
export function ProductSpecs(props: {specs: ProductSpecs | null; variantWeight?: number | null; variantWeightUnit?: string | null}): JSX.Element | null;
export function formatVariantWeight(weight?: number | null, unit?: string | null): string | null;
export function WhatsInBox(props: {text: string | null}): JSX.Element | null;
```

  Task 16 wires `variantWeight={selectedVariant?.weight}` / `variantWeightUnit={selectedVariant?.weightUnit}` (available on Storefront 2026-04 — verified against Hydrogen 2026.4.5's bundled schema).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/storefront/app/components/product/__tests__/product-content-sections.test.tsx
import {render, screen} from '@testing-library/react';
import {ProductHighlights} from '../ProductHighlights';
import {ProductSpecs, formatVariantWeight} from '../ProductSpecs';
import {WhatsInBox} from '../WhatsInBox';

describe('ProductHighlights', () => {
  it('renders nothing without data', () => {
    expect(render(<ProductHighlights highlights={null} />).container).toBeEmptyDOMElement();
  });
  it('renders one bullet per highlight', () => {
    render(<ProductHighlights highlights={['Durable rope core', 'Machine washable', 'Non-slip grip']} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('Machine washable')).toBeInTheDocument();
  });
});

describe('ProductSpecs', () => {
  const specs = [{label: 'Material', value: 'Cotton'}];
  it('renders nothing without data', () => {
    expect(render(<ProductSpecs specs={null} />).container).toBeEmptyDOMElement();
  });
  it('renders the rows', () => {
    render(<ProductSpecs specs={specs} />);
    expect(screen.getByText('Material')).toBeInTheDocument();
    expect(screen.getByText('Cotton')).toBeInTheDocument();
  });
  it('appends a live Weight row and drops an agent-written Weight duplicate', () => {
    render(
      <ProductSpecs
        specs={[...specs, {label: 'Weight', value: 'about 1 pound'}]}
        variantWeight={250}
        variantWeightUnit="GRAMS"
      />,
    );
    expect(screen.getByText('250 g')).toBeInTheDocument();
    expect(screen.queryByText('about 1 pound')).not.toBeInTheDocument();
  });
  it('keeps the agent Weight row when the variant carries no weight (spec B2 fallback)', () => {
    render(<ProductSpecs specs={[...specs, {label: 'Weight', value: 'about 1 pound'}]} />);
    expect(screen.getByText('about 1 pound')).toBeInTheDocument();
  });
});

describe('formatVariantWeight', () => {
  it.each([
    [250, 'GRAMS', '250 g'],
    [1.5, 'KILOGRAMS', '1.5 kg'],
    [8, 'OUNCES', '8 oz'],
    [2, 'POUNDS', '2 lb'],
    [0, 'GRAMS', null],
    [null, 'GRAMS', null],
    [250, 'FURLONGS', null],
  ])('(%s, %s) -> %s', (weight, unit, expected) => {
    expect(formatVariantWeight(weight, unit)).toBe(expected);
  });
});

describe('WhatsInBox', () => {
  it('renders nothing without data', () => {
    expect(render(<WhatsInBox text={null} />).container).toBeEmptyDOMElement();
  });
  it('renders the line under its heading', () => {
    render(<WhatsInBox text="1x rope toy" />);
    expect(screen.getByRole('heading', {name: "What's in the box"})).toBeInTheDocument();
    expect(screen.getByText('1x rope toy')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @doge-buddy/storefront test app/components/product/__tests__/product-content-sections.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
// apps/storefront/app/components/product/ProductHighlights.tsx
import type {ProductHighlights as Highlights} from '@doge-buddy/core';

export function ProductHighlights({highlights}: {highlights: Highlights | null}) {
  if (!highlights || highlights.length === 0) return null;
  return (
    <ul className="mt-6 space-y-2">
      {highlights.map((highlight) => (
        <li key={highlight} className="flex items-start gap-2 text-ink">
          <span aria-hidden="true" className="mt-0.5 font-display text-accent">
            ✓
          </span>
          {highlight}
        </li>
      ))}
    </ul>
  );
}
```

```tsx
// apps/storefront/app/components/product/ProductSpecs.tsx
import type {ProductSpecs as Specs} from '@doge-buddy/core';

const WEIGHT_UNITS: Record<string, string> = {
  GRAMS: 'g',
  KILOGRAMS: 'kg',
  OUNCES: 'oz',
  POUNDS: 'lb',
};

export function formatVariantWeight(
  weight?: number | null,
  unit?: string | null,
): string | null {
  if (weight == null || weight <= 0) return null;
  const suffix = unit ? WEIGHT_UNITS[unit] : undefined;
  if (!suffix) return null;
  return `${Math.round(weight * 100) / 100} ${suffix}`;
}

export function ProductSpecs({
  specs,
  variantWeight,
  variantWeightUnit,
}: {
  specs: Specs | null;
  variantWeight?: number | null;
  variantWeightUnit?: string | null;
}) {
  const weightText = formatVariantWeight(variantWeight, variantWeightUnit);
  // The LIVE selected-variant weight beats any agent-written Weight row (spec B2) — the agent
  // row only survives as the fallback when the variant carries no weight.
  const rows = [
    ...(specs ?? []).filter(
      (row) => !(weightText && row.label.trim().toLowerCase() === 'weight'),
    ),
    ...(weightText ? [{label: 'Weight', value: weightText}] : []),
  ];
  if (rows.length === 0) return null;
  return (
    <div className="mt-8">
      <h2 className="font-display text-2xl text-ink">Specs</h2>
      <table className="mt-2 w-full border-collapse text-sm">
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b border-ink/10">
              <th scope="row" className="w-1/3 py-2 pr-4 text-left font-medium text-ink/70">
                {row.label}
              </th>
              <td className="py-2 text-ink">{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

```tsx
// apps/storefront/app/components/product/WhatsInBox.tsx
export function WhatsInBox({text}: {text: string | null}) {
  if (!text) return null;
  return (
    <div className="mt-8">
      <h2 className="font-display text-2xl text-ink">What's in the box</h2>
      <p className="mt-2 text-ink">{text}</p>
    </div>
  );
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @doge-buddy/storefront test app/components/product/__tests__/product-content-sections.test.tsx && pnpm --filter @doge-buddy/storefront typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/storefront/app/components/product/ProductHighlights.tsx apps/storefront/app/components/product/ProductSpecs.tsx apps/storefront/app/components/product/WhatsInBox.tsx apps/storefront/app/components/product/__tests__/product-content-sections.test.tsx
git commit -m "feat(storefront): highlights, specs (live variant weight), what's-in-box sections"
```

---

### Task 13: `TrustBadges` + `ShippingReturnsAccordion`

**Files:**
- Create: `apps/storefront/app/components/product/TrustBadges.tsx`
- Create: `apps/storefront/app/components/product/ShippingReturnsAccordion.tsx`
- Test: `apps/storefront/app/components/product/__tests__/trust-and-policies.test.tsx`

**Interfaces:**
- Consumes: `POLICY_COPY` from `@doge-buddy/core` (`packages/core/src/policies.ts:20` — handles `shipping`/`returns`, `sections[].paragraphs`); `Link` from `react-router` (the test setup already mocks it as `<a>`).
- Produces: `TrustBadges()` (no props) and `ShippingReturnsAccordion(props: {shipsFrom?: string | null; minDays?: string | null; maxDays?: string | null})`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/storefront/app/components/product/__tests__/trust-and-policies.test.tsx
import {render, screen} from '@testing-library/react';
import {POLICY_COPY} from '@doge-buddy/core';
import {TrustBadges} from '../TrustBadges';
import {ShippingReturnsAccordion} from '../ShippingReturnsAccordion';

describe('TrustBadges', () => {
  it('renders the four badges (Decision 11)', () => {
    render(<TrustBadges />);
    expect(screen.getByText('US warehouses')).toBeInTheDocument();
    expect(screen.getByText('3–7 day delivery')).toBeInTheDocument();
    expect(screen.getByText('Secure checkout by Shopify')).toBeInTheDocument();
    expect(screen.getByText(/All sales final/)).toBeInTheDocument();
  });
  it('links the honesty badge to the real returns policy route', () => {
    render(<TrustBadges />);
    expect(screen.getByRole('link', {name: /policy/i})).toHaveAttribute('href', '/policies/returns');
  });
});

describe('ShippingReturnsAccordion', () => {
  it('builds both summaries from POLICY_COPY verbatim (no new copy authored)', () => {
    render(<ShippingReturnsAccordion shipsFrom="US warehouse" minDays="3" maxDays="7" />);
    const shippingLead = POLICY_COPY.find((p) => p.handle === 'shipping')!.sections[0]!.paragraphs[0]!;
    const returnsLead = POLICY_COPY.find((p) => p.handle === 'returns')!.sections[0]!.paragraphs[0]!;
    expect(screen.getByText(shippingLead)).toBeInTheDocument();
    expect(screen.getByText(returnsLead)).toBeInTheDocument();
    expect(screen.getByText('Ships from US warehouse · 3–7 days')).toBeInTheDocument();
  });
  it('links both full policy pages', () => {
    render(<ShippingReturnsAccordion />);
    expect(screen.getByRole('link', {name: /shipping policy/i})).toHaveAttribute('href', '/policies/shipping');
    expect(screen.getByRole('link', {name: /returns policy/i})).toHaveAttribute('href', '/policies/returns');
  });
  it('omits the delivery line when metafields are absent, but still renders', () => {
    render(<ShippingReturnsAccordion />);
    expect(screen.queryByText(/Ships from/)).not.toBeInTheDocument();
    expect(screen.getByText('Shipping')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @doge-buddy/storefront test app/components/product/__tests__/trust-and-policies.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
// apps/storefront/app/components/product/TrustBadges.tsx
import {Link} from 'react-router';

function BadgeIcon({path}: {path: string}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={path} />
    </svg>
  );
}

const ICONS = {
  warehouse: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  truck:
    'M1 5h14v11H1z M15 8h4l3 3v5h-7z M5.5 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M17.5 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  lock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
  check: 'M9 12l2 2 4-4 M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
};

/**
 * Trust badge row directly under the add-to-cart (product-page-v2 spec Decision 11). The last
 * badge deliberately links the load-bearing all-sales-final policy instead of hiding it — the
 * live route is /policies/returns (the spec's "/policies/refund-policy" handle does not exist).
 * The Footer's TrustStrip is a separate component and stays untouched.
 */
export function TrustBadges() {
  const badgeClass =
    'flex items-center gap-2 rounded-xl border-2 border-ink bg-badge px-3 py-2 text-sm font-medium text-ink';
  return (
    <ul className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
      <li className={badgeClass}>
        <BadgeIcon path={ICONS.warehouse} />
        US warehouses
      </li>
      <li className={badgeClass}>
        <BadgeIcon path={ICONS.truck} />
        3–7 day delivery
      </li>
      <li className={badgeClass}>
        <BadgeIcon path={ICONS.lock} />
        Secure checkout by Shopify
      </li>
      <li className={badgeClass}>
        <BadgeIcon path={ICONS.check} />
        <span>
          All sales final —{' '}
          <Link to="/policies/returns" className="text-info underline">
            policy
          </Link>
        </span>
      </li>
    </ul>
  );
}
```

```tsx
// apps/storefront/app/components/product/ShippingReturnsAccordion.tsx
import {Link} from 'react-router';
import {POLICY_COPY} from '@doge-buddy/core';

/**
 * <details> summaries of the shipping + returns policies (product-page-v2 spec B2). Every
 * paragraph is taken verbatim from POLICY_COPY — no new policy copy is authored here; each block
 * ends with a link to the full policy page.
 */
export function ShippingReturnsAccordion({
  shipsFrom,
  minDays,
  maxDays,
}: {
  shipsFrom?: string | null;
  minDays?: string | null;
  maxDays?: string | null;
}) {
  const shipping = POLICY_COPY.find((policy) => policy.handle === 'shipping');
  const returns = POLICY_COPY.find((policy) => policy.handle === 'returns');
  if (!shipping || !returns) return null;

  const detailsClass = 'rounded-2xl border-2 border-ink bg-surface-raised px-4 py-3';
  const summaryClass = 'cursor-pointer font-display text-lg text-ink';

  return (
    <div className="mt-8 space-y-2">
      <details className={detailsClass}>
        <summary className={summaryClass}>Shipping</summary>
        {shipsFrom && minDays && maxDays ? (
          <p className="mt-2 text-sm font-medium text-ink">
            Ships from {shipsFrom} · {minDays}–{maxDays} days
          </p>
        ) : null}
        {shipping.sections[0]!.paragraphs.slice(0, 2).map((paragraph) => (
          <p key={paragraph} className="mt-2 text-sm text-ink">
            {paragraph}
          </p>
        ))}
        <p className="mt-2 text-sm">
          <Link to="/policies/shipping" className="text-info underline">
            Full shipping policy
          </Link>
        </p>
      </details>
      <details className={detailsClass}>
        <summary className={summaryClass}>Returns</summary>
        {returns.sections[0]!.paragraphs.map((paragraph) => (
          <p key={paragraph} className="mt-2 text-sm text-ink">
            {paragraph}
          </p>
        ))}
        <p className="mt-2 text-sm">
          <Link to="/policies/returns" className="text-info underline">
            Full returns policy
          </Link>
        </p>
      </details>
    </div>
  );
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @doge-buddy/storefront test app/components/product/__tests__/trust-and-policies.test.tsx && pnpm --filter @doge-buddy/storefront typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/storefront/app/components/product/TrustBadges.tsx apps/storefront/app/components/product/ShippingReturnsAccordion.tsx apps/storefront/app/components/product/__tests__/trust-and-policies.test.tsx
git commit -m "feat(storefront): trust badges + shipping/returns accordion from POLICY_COPY"
```

---

### Task 14: `SupplierReviews` section

**Files:**
- Create: `apps/storefront/app/components/product/SupplierReviews.tsx`
- Test: `apps/storefront/app/components/product/__tests__/supplier-reviews.test.tsx`
- Modify: `apps/storefront/app/lib/__tests__/seo.test.ts` (JSON-LD regression assert)

**Interfaces:**
- Consumes: `SupplierReviews` type from `@doge-buddy/core` (Task 1).
- Produces: `SupplierReviews(props: {data: SupplierReviewsType | null}): JSX.Element | null` (import the type aliased, the component keeps the name `SupplierReviews`).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/storefront/app/components/product/__tests__/supplier-reviews.test.tsx
import {render, screen} from '@testing-library/react';
import {SupplierReviews} from '../SupplierReviews';

const data = {
  average: 4.6,
  count: 1238,
  reviews: [
    {rating: 5, text: 'Great toy, my dog loves it', date: '2026-06-01', country: 'US'},
    {rating: 4, text: 'Sturdy and washable'},
  ],
  fetchedAt: '2026-09-01T12:00:00.000Z',
};

it('renders nothing without the metafield', () => {
  expect(render(<SupplierReviews data={null} />).container).toBeEmptyDOMElement();
});

it('renders the heading and the FIXED disclosure line verbatim (FTC — Decision 4)', () => {
  render(<SupplierReviews data={data} />);
  expect(screen.getByRole('heading', {name: 'Marketplace reviews'})).toBeInTheDocument();
  // Hardcoded on purpose: this test pins the exact legal disclosure. Do not import it.
  expect(
    screen.getByText(
      "From the supplier's buyers on other marketplaces — not yet from Doge Buddy customers.",
    ),
  ).toBeInTheDocument();
});

it('renders the aggregate line with formatted count and as-of date', () => {
  render(<SupplierReviews data={data} />);
  expect(screen.getByText('★ 4.6 · 1,238 marketplace ratings · as of 2026-09-01')).toBeInTheDocument();
});

it('renders a card per review with stars, text, and date/country when present', () => {
  render(<SupplierReviews data={data} />);
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  expect(screen.getByText('Great toy, my dog loves it')).toBeInTheDocument();
  expect(screen.getByText('2026-06-01 · US')).toBeInTheDocument();
  expect(screen.getByLabelText('5 out of 5 stars')).toBeInTheDocument();
});

it('emits NO schema.org markup (Decision 6)', () => {
  const {container} = render(<SupplierReviews data={data} />);
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelector('[itemtype]')).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @doge-buddy/storefront test app/components/product/__tests__/supplier-reviews.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
// apps/storefront/app/components/product/SupplierReviews.tsx
import type {SupplierReviews as SupplierReviewsData} from '@doge-buddy/core';

/**
 * Labeled supplier marketplace reviews (product-page-v2 spec Decisions 3-6). The disclosure line
 * is FIXED VERBATIM — FTC 16 CFR Part 465: these reviewers are not this store's buyers, and the
 * label is what makes displaying them honest. NO schema.org review markup, ever (Decision 6):
 * imported reviews in JSON-LD invite a Google manual action. Judge.me replaces/demotes this
 * section once real orders exist (backlog #15).
 */
const DISCLOSURE =
  "From the supplier's buyers on other marketplaces — not yet from Doge Buddy customers.";

function Stars({rating}: {rating: number}) {
  return (
    <span aria-label={`${rating} out of 5 stars`} className="text-gold-dark">
      {'★'.repeat(rating)}
      <span aria-hidden="true" className="text-ink/20">
        {'★'.repeat(5 - rating)}
      </span>
    </span>
  );
}

export function SupplierReviews({data}: {data: SupplierReviewsData | null}) {
  if (!data || data.reviews.length === 0) return null;
  const asOf = data.fetchedAt.slice(0, 10);
  return (
    <section className="mt-12">
      <h2 className="font-display text-2xl text-ink">Marketplace reviews</h2>
      <p className="mt-1 text-sm text-ink/70">{DISCLOSURE}</p>
      <p className="mt-2 font-medium text-ink">
        ★ {data.average.toFixed(1)} · {data.count.toLocaleString('en-US')} marketplace ratings ·
        as of {asOf}
      </p>
      <ul className="mt-4 grid gap-3 md:grid-cols-2">
        {data.reviews.map((review, index) => (
          <li
            key={`${index}-${review.text.slice(0, 40)}`}
            className="rounded-2xl border-2 border-ink bg-surface-raised p-4"
          >
            <Stars rating={review.rating} />
            <p className="mt-2 text-sm text-ink">{review.text}</p>
            {review.date || review.country ? (
              <p className="mt-2 text-xs text-ink/60">
                {[review.date, review.country].filter(Boolean).join(' · ')}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

Also add to `apps/storefront/app/lib/__tests__/seo.test.ts`:

```ts
it('productJsonLd never carries review markup (product-page-v2 Decision 6)', () => {
  const jsonLd = productJsonLd({
    name: 'Rope Toy',
    description: 'A rope toy',
    url: 'https://dogebuddy.com/products/rope-toy',
    price: '19.99',
    currencyCode: 'USD',
    available: true,
  }) as Record<string, unknown>;
  expect(jsonLd).not.toHaveProperty('review');
  expect(jsonLd).not.toHaveProperty('aggregateRating');
});
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @doge-buddy/storefront test && pnpm --filter @doge-buddy/storefront typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/storefront/app/components/product/SupplierReviews.tsx apps/storefront/app/components/product/__tests__/supplier-reviews.test.tsx apps/storefront/app/lib/__tests__/seo.test.ts
git commit -m "feat(storefront): labeled marketplace-reviews section, no review JSON-LD"
```

---

### Task 15: Quantity stepper in `ProductForm`

**Files:**
- Modify: `apps/storefront/app/components/ProductForm.tsx` (`:104-123` and state at the top)
- Test: `apps/storefront/app/components/__tests__/product-form-quantity.test.tsx`

**Interfaces:**
- Consumes: `AddToCartButton`'s `lines: OptimisticCartLineInput[]` (already carries `quantity` — the component needs NO change; quantity must flow through the `lines` prop, a form input would not be submitted through `CartForm`).
- Produces: no API change — `ProductForm`'s props are unchanged.

- [ ] **Step 1: Write the failing test** — `ProductForm` pulls in `useAside` and `AddToCartButton` (which needs a CartForm/router context), so mock both:

```tsx
// apps/storefront/app/components/__tests__/product-form-quantity.test.tsx
import {fireEvent, render, screen} from '@testing-library/react';
import {vi} from 'vitest';

vi.mock('~/components/Aside', () => ({
  useAside: () => ({open: vi.fn()}),
}));

const captured: {lines?: Array<{quantity: number}>} = {};
vi.mock('~/components/AddToCartButton', () => ({
  AddToCartButton: ({lines, children}: {lines: Array<{quantity: number}>; children: React.ReactNode}) => {
    captured.lines = lines;
    return <button type="button">{children}</button>;
  },
}));

import {ProductForm} from '../ProductForm';

const selectedVariant = {
  id: 'gid://shopify/ProductVariant/1',
  availableForSale: true,
  title: 'Default Title',
  price: {amount: '19.99', currencyCode: 'USD'},
  selectedOptions: [],
} as any;

it('defaults to quantity 1 and passes it into the cart line', () => {
  render(<ProductForm productOptions={[]} selectedVariant={selectedVariant} />);
  expect(captured.lines?.[0]?.quantity).toBe(1);
});

it('increments/decrements within 1..99 and the line follows', () => {
  render(<ProductForm productOptions={[]} selectedVariant={selectedVariant} />);
  fireEvent.click(screen.getByRole('button', {name: 'Increase quantity'}));
  fireEvent.click(screen.getByRole('button', {name: 'Increase quantity'}));
  expect(screen.getByText('3')).toBeInTheDocument();
  expect(captured.lines?.[0]?.quantity).toBe(3);
  fireEvent.click(screen.getByRole('button', {name: 'Decrease quantity'}));
  expect(captured.lines?.[0]?.quantity).toBe(2);
});

it('cannot go below 1', () => {
  render(<ProductForm productOptions={[]} selectedVariant={selectedVariant} />);
  expect(screen.getByRole('button', {name: 'Decrease quantity'})).toBeDisabled();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @doge-buddy/storefront test app/components/__tests__/product-form-quantity.test.tsx`
Expected: FAIL (no stepper, quantity hardcoded 1 — first case may pass; the increment case fails).

- [ ] **Step 3: Implement** — in `ProductForm.tsx`: add `useState` to the react import, then inside the component:

```tsx
  const [quantity, setQuantity] = useState(1);
```

Insert the stepper between the options block and `AddToCartButton`:

```tsx
      <div className="mb-4 flex items-center gap-3">
        <span id="quantity-label" className="text-sm font-medium text-ink">
          Quantity
        </span>
        <div className="flex items-center rounded-2xl border-2 border-ink bg-surface-raised">
          <button
            type="button"
            aria-label="Decrease quantity"
            className="px-3 py-1 text-lg text-ink disabled:opacity-40"
            disabled={quantity <= 1}
            onClick={() => setQuantity((current) => Math.max(1, current - 1))}
          >
            −
          </button>
          <span aria-labelledby="quantity-label" className="min-w-8 text-center font-medium text-ink">
            {quantity}
          </span>
          <button
            type="button"
            aria-label="Increase quantity"
            className="px-3 py-1 text-lg text-ink disabled:opacity-40"
            disabled={quantity >= 99}
            onClick={() => setQuantity((current) => Math.min(99, current + 1))}
          >
            +
          </button>
        </div>
      </div>
```

and change the line at `:114` from `quantity: 1` to `quantity`.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @doge-buddy/storefront test && pnpm --filter @doge-buddy/storefront typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/storefront/app/components/ProductForm.tsx apps/storefront/app/components/__tests__/product-form-quantity.test.tsx
git commit -m "feat(storefront): quantity stepper wired into the add-to-cart line"
```

---

### Task 16: Page layout — wire everything into `products.$handle.tsx`

**Files:**
- Modify: `apps/storefront/app/routes/products.$handle.tsx:109-177` (the component)

**Interfaces:**
- Consumes: everything Tasks 10–15 produced. Layout order is spec §B3, verbatim.

- [ ] **Step 1: Implement** — replace the component body's return (`:130-176`) with (imports added at top: the six new components from `~/components/product/...`):

```tsx
  const {title, descriptionHtml} = product;
  const {content} = useLoaderData<typeof loader>(); // fold into the existing destructure at :110

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="grid gap-8 md:grid-cols-2">
        <ProductGallery
          media={product.media?.nodes ?? []}
          variantImage={selectedVariant?.image}
        />
        <div>
          <h1 className="font-display text-4xl text-ink">{title}</h1>
          <div className="mt-3 inline-block rounded border-2 border-ink bg-badge px-3 py-1 font-display text-xl text-ink">
            <ProductPrice
              price={selectedVariant?.price}
              compareAtPrice={selectedVariant?.compareAtPrice}
            />
          </div>
          <div className="mt-4">
            <DeliveryBadge
              shipsFrom={product.shipsFrom?.value}
              minDays={product.deliveryMinDays?.value}
              maxDays={product.deliveryMaxDays?.value}
            />
          </div>
          <div className="mt-6">
            <ProductForm
              productOptions={productOptions}
              selectedVariant={selectedVariant}
            />
          </div>
          <TrustBadges />
          <ProductHighlights highlights={content.highlights} />
          <h2 className="mt-10 font-display text-2xl text-ink">Description</h2>
          <div
            className="mt-2 leading-relaxed text-ink"
            dangerouslySetInnerHTML={{__html: descriptionHtml}}
          />
          <ProductSpecs
            specs={content.specs}
            variantWeight={selectedVariant?.weight}
            variantWeightUnit={selectedVariant?.weightUnit}
          />
          <WhatsInBox text={content.whatsInBox} />
          <ShippingReturnsAccordion
            shipsFrom={product.shipsFrom?.value}
            minDays={product.deliveryMinDays?.value}
            maxDays={product.deliveryMaxDays?.value}
          />
        </div>
      </div>
      <SupplierReviews data={content.supplierReviews} />
      <Analytics.ProductView
        data={{
          products: [
            {
              id: product.id,
              title: product.title,
              price: selectedVariant?.price.amount || '0',
              vendor: product.vendor,
              variantId: selectedVariant?.id || '',
              variantTitle: selectedVariant?.title || '',
              quantity: 1,
            },
          ],
        }}
      />
    </div>
  );
```

(The `ProductImage` import at `:12` becomes unused — remove it. `Analytics.ProductView` and the meta/JSON-LD block stay byte-identical.)

- [ ] **Step 2: Verify**

Run: `pnpm --filter @doge-buddy/storefront test && pnpm --filter @doge-buddy/storefront typecheck && pnpm --filter @doge-buddy/storefront build`
Expected: all PASS; the build proves the route compiles with codegen'd types.

- [ ] **Step 3: Eyeball it** — start the dev storefront and load a product page (any sample product renders today's page — all new sections null; a page with hand-set metafields shows the sections). If a dev store isn't reachable from this environment, note that the visual pass happens in the live tier and move on.

- [ ] **Step 4: Commit**

```bash
git add apps/storefront/app/routes/products.\$handle.tsx
git commit -m "feat(storefront): product page v2 layout — gallery, badges, content sections, reviews"
```

---

### Task 17: Whole-branch verification + docs

**Files:**
- Modify: `docs/LAUNCH-BACKLOG.md` (mark P1 #6 + #7 absorbed by this feature, pointer to the spec)
- Modify: `docs/OWNER-CHECKLIST.md` (footer pointer + live-check item, see below)
- Modify: `docs/cj-api-notes.md` — NO change yet (`product/productComments` stays "Still unverified" until the live backfill run; do not pre-claim it)

- [ ] **Step 1: Full suite from the worktree** (its own `node_modules` — `pnpm install` first if not done):

Run: `pnpm install && pnpm db:up && pnpm test && pnpm typecheck`
Expected: all green. Known pre-existing flake: support-ingest "seed-on-null" (~10%) — rerun that file once before treating it as a regression; the two known full-suite failures on a dirty dev DB have cleanup SQL on the owner checklist.

- [ ] **Step 2: Placeholder/consistency greps**

Run: `grep -rn "refund-policy" apps/storefront/app` (expect zero hits) and `grep -rn "TODO\|TBD" apps/storefront/app/components/product apps/ops/src/catalog/backfill-v2.ts apps/ops/src/proposals/supplier-reviews.ts` (expect zero).

- [ ] **Step 3: Update the docs** — LAUNCH-BACKLOG: annotate items #6 and #7 as built by this spec (leave #8 untouched). OWNER-CHECKLIST: add the live-check item and move the footer pointer:

Live tier (Robert + Claude, from the checklist):
1. `backfill-listings --dry-run` from the Railway shell (`/app/apps/ops`), then real — this run is the LIVE PROBE for `productCreateMedia`/`productVariantAppendMedia`/`metafieldsSet` AND the `product/productComments` wire shape (spec §Owner setup). Pass: live products show variant images + a reviews section; failure degrades to alerts, not broken pages.
2. One `run-sourcing --max-winners 2` end-to-end. Pass: proposal summary shows `N image(s)`; the listed product page shows gallery/highlights/specs/badges; variant switch changes the image. This run also live-verifies the per-variant `file` FIXTURE-ASSUMPTION — if Shopify rejects it, the error surfaces in the apply job; the recorded fallback is wiring the backfill media pair post-create (spec §Error handling).
3. Eyeball the page on the Fold (mobile-first).
4. After the probe: update `docs/cj-api-notes.md`'s "Still unverified" list with what the run proved.

- [ ] **Step 4: Commit**

```bash
git add docs/LAUNCH-BACKLOG.md docs/OWNER-CHECKLIST.md
git commit -m "docs: product page v2 built — live-check runbook, backlog #6/#7 absorbed"
```

---

## Self-Review (done at plan time)

- **Spec coverage:** A1→Task 2, A2→Task 3, A3→Tasks 4+5, A4→Task 7 (+6), A5→Task 9 (+8), B1→Task 10, B2→Tasks 11-15, B3→Task 16, Decisions 10 (summary count)→Task 4, 11→Task 13, 12/13→Tasks 8+9, error-handling table→Tasks 7/9/10 tests, seed definitions (storefront explorer finding)→Task 7. Non-goals respected: no per-variant copy, no related products, no Judge.me, no content synthesis in backfill, no review JSON-LD (regression-tested).
- **Known deviations from the spec, both deliberate:** `/policies/returns` replaces the nonexistent `/policies/refund-policy`; spec labels are scanned by the guards alongside values (strictly safer).
- **Resolved spec unknowns:** variant `weight`/`weightUnit` EXISTS on Storefront 2026-04 (checked against Hydrogen 2026.4.5's bundled schema) — the specs table uses it with the agent-spec fallback; `getProductReviews` already exists in the supplier adapter (all-optional mapping), so no adapter work.
- **Type consistency:** `buildSupplierReviews` name/signature identical in Tasks 6/7/9; Task 8's five op signatures repeated verbatim in Task 9's `BackfillV2Ops`; `ProductContent` fields in Tasks 10/16; `GalleryImage`/`GalleryMediaNode` in Tasks 11/16.
