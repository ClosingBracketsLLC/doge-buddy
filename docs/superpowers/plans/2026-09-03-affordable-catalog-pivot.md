# Affordable-Catalog Pivot Implementation Plan (part 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the store list cheap CN-warehouse products honestly — every product carries its own true delivery window, nothing over $100 lists, and the policy tells the truth about slow shipping including the legally-required cancel-if-late right.

**Architecture:** Three coordinated changes. `@doge-buddy/core` stops hard-coding `shipsFrom: 'US'` and rewrites the shipping/returns policy copy. The sourcing pipeline gains an origin dimension (harvest both warehouses, gate stock and freight against each product's *own* origin, derive the delivery window from the real freight quote instead of an agent guess) plus a `$100` price cap. The storefront deletes every blanket "3–7 day" claim and shows each product's own window before the click.

**Tech Stack:** TypeScript monorepo (pnpm), zod v4, drizzle/pg, vitest; Hydrogen/React Router storefront with `#graphql` queries + codegen; CJ supplier adapter.

**Spec:** `docs/superpowers/specs/2026-09-03-affordable-catalog-pivot-design.md`

**Scope note:** the spec's §5 post-purchase comfort system (lifecycle emails, coupons) is a separate subsystem with its own infrastructure and gets **its own plan** after this one lands. This plan delivers a store that can *list* CN products honestly; that plan delivers the reassurance around the wait.

## Global Constraints

- Commands: `pnpm --filter @doge-buddy/<pkg> test` (vitest), `pnpm -r typecheck`. Storefront needs `pnpm --filter @doge-buddy/storefront codegen` after any `#graphql` change, before typecheck.
- **Never state a delivery time the data doesn't support.** Windows come from the chosen freight option's real `minDays`/`maxDays`, never from a constant or the agent's proposal.
- **No blanket site-wide delivery promise survives.** Every claim is per-product or it is deleted.
- Money is integer cents; ratio math is integer bps, floored. Gates reject, never rewrite.
- Policy copy is single-sourced in `POLICY_COPY` — the storefront renders it and the support agent quotes it verbatim. Change it there or nowhere.
- Existing gates are unchanged in strictness: 1.3× Amazon/market ceiling, 40% margin floor, claims scrubber, US-stock rule becomes origin-stock rule (not weaker — same rule, applied to the right warehouse).
- Known-benign local test failures (dev-DB state): `admin-dashboard` 8/13, `scoring-weekly-digest` freshness. Everything else must pass.
- **This plan does not make CN products purchasable.** The spec's §6 duty/DDP verification is Robert's, and gates the first CN listing — not this build.

---

### Task 1: Core — `shipsFrom` becomes an origin enum, policy copy tells the truth

**Files:**
- Modify: `packages/core/src/proposals.ts` (`shipsFrom: z.literal('US')`, line ~45)
- Modify: `packages/core/src/policies.ts` (shipping section; returns section gains the late-order right)
- Test: `packages/core/test/proposals.test.ts`, `packages/core/test/policies.test.ts`

**Interfaces:**
- Produces: `NewListingPayloadSchema.shipsFrom` accepts `'US' | 'CN'`; `ProductOrigin` type exported as `export type ProductOrigin = 'US' | 'CN'`. Tasks 3–5 rely on both.

- [ ] **Step 1: Write the failing tests**

In `packages/core/test/proposals.test.ts`:

```ts
it('accepts CN as a product origin (affordable-catalog pivot 2026-09-03)', () => {
  const cn = { ...validNewListingPayload, shipsFrom: 'CN' }
  expect(NewListingPayloadSchema.safeParse(cn).success).toBe(true)
})
it('still accepts US and still rejects anything else', () => {
  expect(NewListingPayloadSchema.safeParse({ ...validNewListingPayload, shipsFrom: 'US' }).success).toBe(true)
  expect(NewListingPayloadSchema.safeParse({ ...validNewListingPayload, shipsFrom: 'GB' }).success).toBe(false)
})
```

(`validNewListingPayload` = whatever valid fixture that file already uses; reuse it rather than writing a new one.)

In `packages/core/test/policies.test.ts`:

```ts
it('shipping policy no longer promises a blanket 3–7 day window', () => {
  const shipping = POLICY_COPY.find((p) => p.handle === 'shipping')!
  const text = shipping.sections.flatMap((s) => s.paragraphs).join(' ')
  expect(text).not.toMatch(/3[–-]7/)
  expect(text).toMatch(/delivery window/i)
})
it('returns policy carries the late-order cancel right (FTC mail-order rule)', () => {
  const returns = POLICY_COPY.find((p) => p.handle === 'returns')!
  const text = returns.sections.flatMap((s) => s.paragraphs).join(' ')
  expect(text).toMatch(/cancel/i)
  expect(text).toMatch(/refund/i)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @doge-buddy/core test`
Expected: the CN case fails (literal 'US'), and both policy assertions fail.

- [ ] **Step 3: Implement**

`proposals.ts`:

```ts
/** Where a product ships from. 'US' = CJ US warehouse (fast, dearer goods); 'CN' = CJ China
 *  warehouse (slow, far cheaper goods — the affordable-catalog pivot, spec 2026-09-03). The
 *  delivery window is derived per product from the real freight quote, never from this value. */
export type ProductOrigin = 'US' | 'CN'
```

and in the payload schema replace `shipsFrom: z.literal('US'),` with:

```ts
    shipsFrom: z.enum(['US', 'CN']),
```

`policies.ts` — replace the shipping section's paragraphs with:

```ts
        paragraphs: [
          "Every product page shows that item's own delivery window before you buy — most orders arrive in 7 to 14 days, and some US-warehouse items arrive in 3 to 7. The window is on the product page, in your cart, and in your order confirmation.",
          "Some of our gear ships from our overseas partner warehouse. That's the honest trade: it takes a little longer, and it's why the price is what it is. There are no customs charges or extra fees on delivery — the price you pay at checkout is the price.",
          'Tracking is emailed as soon as your order ships and appears in your account. First tracking scans can take a few days to show up, which is normal.',
          'We ship within the United States only.',
          "If an order runs past its window we'll email you with an updated estimate and you can choose to keep waiting or cancel for a full refund. If it never arrives, we reship at no charge — and refund you if we can't.",
        ],
```

`policies.ts` — in the returns section's **"All sales are final"** block, append this paragraph (the narrow, deliberate exception Robert approved 2026-09-03):

```ts
          "One exception, and we'll tell you about it rather than wait to be asked: if your order hasn't shipped within the delivery window shown when you bought it, you can cancel it for a full refund. We'll email you first with the new estimate so you can decide.",
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @doge-buddy/core test` → PASS. Then `pnpm -r typecheck` — expect errors ONLY where `shipsFrom` was assumed to be the literal `'US'` (seed fixtures, ops tests). Fix each by using `'US' as const` / the `ProductOrigin` type; do not weaken any gate.

- [ ] **Step 5: Commit**

```bash
git add packages/core apps/ops/src/seed
git commit -m "feat(core): shipsFrom accepts CN; shipping policy states per-product windows and the late-order cancel right"
```

---

### Task 2: `$100` price cap knob + Stage 6 gate

**Files:**
- Modify: `apps/ops/src/settings.ts` (`SETTINGS_DEFAULTS` + `SettingKey`)
- Modify: `apps/ops/src/sourcing/knobs.ts` (`SOURCING_KNOB_RANGES`, `SourcingKnobs`, `resolveSourcingKnobs`, `describeSourcingKnobs`)
- Modify: `apps/ops/src/sourcing/submit-winners.ts` (new gate step)
- Test: `apps/ops/test/sourcing-knobs.test.ts`, `apps/ops/test/sourcing-submit-winners.test.ts`

**Interfaces:**
- Produces: setting `sourcing.max_price_cents` (default `10000`); `SourcingKnobs.maxPriceCents: number`; `ValidateAndSubmitWinnersInput.maxPriceCents: number`; drop reason `sourcing_winner_price_above_cap`. Task 5's prompt quotes the same number.

- [ ] **Step 1: Write the failing tests**

`sourcing-knobs.test.ts`:

```ts
it('maxPriceCents defaults to $100 and range-checks', async () => {
  const knobs = await resolveSourcingKnobs(settingsStub({}))
  expect(knobs.maxPriceCents).toBe(10_000)
  expect(SETTINGS_DEFAULTS['sourcing.max_price_cents']).toBe(10_000)
  await expect(resolveSourcingKnobs(settingsStub({ 'sourcing.max_price_cents': 400 }))).rejects.toThrow(/sourcing\.max_price_cents/)
  await expect(resolveSourcingKnobs(settingsStub({ 'sourcing.max_price_cents': 100_001 }))).rejects.toThrow(/sourcing\.max_price_cents/)
})
```

(Use the settings stub idiom already in that file.)

`sourcing-submit-winners.test.ts`:

```ts
it('drops a winner whose cheapest variant exceeds the price cap (owner rule: nothing over $100)', async () => {
  const alert = vi.fn(async () => {})
  const submit = vi.fn(async () => ({ id: 'p', status: 'pending' as const }))
  const deps = makeDeps({ alert, submit })
  const { candidateIds, candidatesByPid } = candidateSet(['cjp-1'])
  const outcomes = await validateAndSubmitWinners(deps, {
    runId: RUN_ID, candidateIds, candidatesByPid, maxPriceToMarketBps: 50_000, maxPriceCents: 10_000,
    winners: [winnerFor('cjp-1', { payload: { variants: [{ sku: 'A', priceCents: 10_100, supplierCostCents: 1000, supplier: 'cj', supplierProductId: 'cjp-1', supplierVariantId: 'cjp-1-v1' }] } })],
  })
  expect(outcomes).toEqual([{ supplierProductId: 'cjp-1', outcome: 'dropped', reason: 'sourcing_winner_price_above_cap' }])
  expect(submit).not.toHaveBeenCalled()
})
it('allows a winner exactly at the cap', async () => {
  // same shape, priceCents: 10_000 -> outcome 'submitted'
})
```

Every existing call in that file needs `maxPriceCents: 10_000` added to its input — do that in the same edit so the suite compiles.

- [ ] **Step 2: Run to verify they fail** — `cd apps/ops && npx vitest run test/sourcing-knobs.test.ts test/sourcing-submit-winners.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`settings.ts`: add `'sourcing.max_price_cents': 10_000,` to `SETTINGS_DEFAULTS` and `| 'sourcing.max_price_cents'` to the `SettingKey` union.

`knobs.ts`: add to `SOURCING_KNOB_RANGES`:

```ts
  // Owner rule 2026-09-03: nothing over $100 lists — cheap impulse-priced goods only. Floor of
  // $5 stops a typo emptying the catalog.
  maxPriceCents: { min: 500, max: 100_000, integer: true },
```

add `maxPriceCents: number` to `SourcingKnobs`, read `settings.get('sourcing.max_price_cents')` in the `Promise.all`, resolve with
`maxPriceCents: checkRange('maxPriceCents', maxPriceCents, 'setting sourcing.max_price_cents')`, and append `maxPriceCents=${knobs.maxPriceCents}` to `describeSourcingKnobs`.

`submit-winners.ts`: add `maxPriceCents: number` to `ValidateAndSubmitWinnersInput`, and insert this gate immediately **after** step 2b's content check and **before** step 3's HTML check (it is free and should run before anything that spends):

```ts
  // Step 2c: owner price cap (spec 2026-09-03 §3). Nothing over $100 lists — the store sells
  // impulse-priced goods, and expensive items neither convert nor survive the Amazon ceiling.
  const dearest = Math.max(...payload.variants.map((v) => v.priceCents))
  if (dearest > input.maxPriceCents) {
    return drop('sourcing_winner_price_above_cap', { dearestCents: dearest, maxPriceCents: input.maxPriceCents })
  }
```

`pipeline.ts`: pass `maxPriceCents: knobs.maxPriceCents` in the `validateAndSubmitWinners` input.

- [ ] **Step 4: Run to verify pass** — same two files + `npx vitest run test/sourcing-pipeline.test.ts`; then `pnpm --filter @doge-buddy/ops typecheck`.

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/settings.ts apps/ops/src/sourcing/knobs.ts apps/ops/src/sourcing/submit-winners.ts apps/ops/src/sourcing/pipeline.ts apps/ops/test
git commit -m "feat(sourcing): \$100 price cap gate (sourcing.max_price_cents) — owner rule, impulse pricing only"
```

---

### Task 3: Harvest both origins; every candidate carries its own

**Files:**
- Modify: `apps/ops/src/sourcing/harvest.ts` (`HarvestCandidate`, the search call ~line 94, candidate shaping)
- Test: `apps/ops/test/sourcing-harvest.test.ts`

**Interfaces:**
- Consumes: `ProductOrigin` (Task 1).
- Produces: `HarvestCandidate.shipsFrom: ProductOrigin`; `HarvestDeps.origins?: readonly ProductOrigin[]` (default `['US', 'CN']`). Tasks 4–5 read `candidate.shipsFrom`.

- [ ] **Step 1: Write the failing test**

```ts
it('searches both origins and tags each candidate with the warehouse that produced it', async () => {
  const calls: Array<{ keyword?: string; countryCode?: string }> = []
  const adapter = { searchProducts: vi.fn(async (q) => { calls.push(q); return q.countryCode === 'CN' ? [summary('cn-1')] : [summary('us-1')] }) }
  const { candidates } = await runHarvest({ db, adapter, alert: vi.fn(async () => {}), keywords: ['dog toy'], candidateTarget: 10, maxPages: 4 })
  expect(new Set(calls.map((c) => c.countryCode))).toEqual(new Set(['US', 'CN']))
  expect(candidates.find((c) => c.supplierProductId === 'cn-1')!.shipsFrom).toBe('CN')
  expect(candidates.find((c) => c.supplierProductId === 'us-1')!.shipsFrom).toBe('US')
})
```

(`summary()` = the file's existing fake-summary helper; `db` = its existing harness.)

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/sourcing-harvest.test.ts` → FAIL (only US searched; no `shipsFrom`).

- [ ] **Step 3: Implement**

Add to `HarvestCandidate`: `shipsFrom: ProductOrigin`.
Add to `HarvestDeps`:

```ts
  /** Warehouses to search, round-robin alongside keywords. Default BOTH (spec 2026-09-03): CN
   *  goods are 6-40x cheaper and are what make impulse pricing possible; US goods keep the fast
   *  windows. Each candidate remembers which warehouse produced it — every later gate uses that
   *  origin, never a global assumption. */
  origins?: readonly ProductOrigin[]
```

Widen `PassState` to `{ keyword, origin, page, ended }` and build `order` as the cross-product of keywords × origins. Pass `countryCode: pass.origin` to `searchProducts`. Carry the origin into `fetchedByPid` alongside the keyword, and set `shipsFrom` on each survivor. Keep every existing filter unchanged.

Note for the implementer: `maxPages` is a total across all passes, so doubling the passes halves pages-per-pass unless the caller raises it — that is intended and the run script's `--pages` flag already exists to compensate.

- [ ] **Step 4: Run to verify pass** — that file + `npx vitest run test/sourcing-pipeline.test.ts`; typecheck.

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/sourcing/harvest.ts apps/ops/test/sourcing-harvest.test.ts
git commit -m "feat(sourcing): harvest both US and CN warehouses; candidates carry their origin"
```

---

### Task 4: Origin-aware stock gate, freight quote, and an honest delivery window

**Files:**
- Modify: `apps/ops/src/sourcing/submit-winners.ts` (step 7 stock check ~line 273, step 8 freight quote ~line 292)
- Test: `apps/ops/test/sourcing-submit-winners.test.ts`

**Interfaces:**
- Consumes: `HarvestCandidate.shipsFrom` (Task 3).
- Produces: submitted payloads whose `shipsFrom` and `deliveryMinDays`/`deliveryMaxDays` come from the candidate's origin and the chosen freight option — Task 6/7 render exactly these.

- [ ] **Step 1: Write the failing tests**

```ts
it('CN winner: stock checked in CN, freight quoted from CN, window taken from the chosen option', async () => {
  const quoteShipping = vi.fn(async () => [{ name: 'CJPacket', priceCents: 494, minDays: 7, maxDays: 14 }])
  const getVariantStock = vi.fn(async () => [{ countryCode: 'CN', quantity: 40, verified: true }])
  const submit = vi.fn(async () => ({ id: 'p', status: 'pending' as const }))
  const deps = makeDeps({ submit, adapter: { ...baseAdapter, quoteShipping, getVariantStock } })
  const candidatesByPid = new Map([['cjp-1', candidate('cjp-1', { shipsFrom: 'CN' })]])
  await validateAndSubmitWinners(deps, {
    runId: RUN_ID, candidateIds: new Set(['cjp-1']), candidatesByPid,
    maxPriceToMarketBps: 50_000, maxPriceCents: 10_000,
    winners: [winnerFor('cjp-1', { payload: { shipsFrom: 'CN', deliveryMinDays: 2, deliveryMaxDays: 4 } })],
  })
  expect(quoteShipping).toHaveBeenCalledWith(expect.objectContaining({ fromCountry: 'CN' }))
  const [, input] = submit.mock.calls[0]!
  // the AGENT proposed 2-4 days; the real quote says 7-14 and the quote wins
  expect(input.payload.deliveryMinDays).toBe(7)
  expect(input.payload.deliveryMaxDays).toBe(14)
  expect(input.payload.shipsFrom).toBe('CN')
})

it('CN winner with only US stock is dropped (origin stock is what matters)', async () => {
  const getVariantStock = vi.fn(async () => [{ countryCode: 'US', quantity: 10, verified: true }])
  // ... candidate shipsFrom 'CN' -> outcome dropped, reason 'sourcing_winner_unverifiable'
})

it('US winner still quotes from US and keeps the US behaviour', async () => {
  // quoteShipping called with fromCountry 'US'; window from the US option
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/sourcing-submit-winners.test.ts` → FAIL.

- [ ] **Step 3: Implement**

Near the top of `processWinner`, after the candidate lookup exists:

```ts
  // The candidate's warehouse decides every origin-sensitive gate below. Falling back to 'US'
  // keeps pre-pivot callers (and any candidate harvested before this field existed) on exactly
  // their old behaviour.
  const origin = input.candidatesByPid.get(pid)?.shipsFrom ?? 'US'
```

Step 7 stock check becomes:

```ts
    const hasOriginStock = stock.some((s) => s.countryCode === origin && s.quantity >= 1)
    if (!hasOriginStock) {
      throw new Error(`no verified ${origin} stock (qty >= 1) for ${firstVid}`)
    }
```

Step 8's quote becomes `fromCountry: origin` (update the FIX C5 comment to say the origin decides, not a hard-coded US), and after the cheapest eligible option is chosen, overwrite the payload's promise with the truth:

```ts
    // Honesty rule (spec 2026-09-03 §3): the delivery window the customer sees is the one the
    // carrier actually quoted, never the agent's proposal. Also stamp the real origin.
    payload = { ...payload, shipsFrom: origin, deliveryMinDays: chosen.minDays, deliveryMaxDays: chosen.maxDays }
```

**Careful:** the eligible-options filter currently drops anything slower than `payload.deliveryMaxDays`, which would reject every CN option against an agent-proposed 3–7 day window. Replace that filter with a hard ceiling constant so slow-but-real options survive:

```ts
/** No listing promises a window longer than this — beyond it, the product isn't worth selling. */
export const MAX_DELIVERY_DAYS = 20
...
    const eligible = options.filter((o) => o.maxDays <= MAX_DELIVERY_DAYS)
```

- [ ] **Step 4: Run to verify pass** — that file + `npx vitest run test/sourcing-pipeline.test.ts`; typecheck.

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/sourcing/submit-winners.ts apps/ops/test/sourcing-submit-winners.test.ts
git commit -m "feat(sourcing): origin-aware stock+freight gates; delivery window comes from the real quote"
```

---

### Task 5: Prompt — origin awareness, the price cap, no invented windows

**Files:**
- Modify: `apps/ops/src/agents/sourcing-run.ts` (store-context + task sections)
- Test: `apps/ops/test/agents-sourcing-run.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('prompt states the price cap and that delivery windows come from freight quotes', () => {
  // build the prompt with knobs including maxPriceCents: 10_000 (existing helper)
  expect(prompt).toContain('$100')
  expect(prompt).toContain('quote_freight')
  expect(prompt).toMatch(/never invent|plain code replaces/i)
  expect(prompt).toContain('CN')
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/agents-sourcing-run.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in `buildPrompt`'s store-context block, replace the `Ships from US only` line with:

```ts
    `Products ship from either our US or our CN warehouse — the candidate's own \`shipsFrom\` says which.`,
    `CN items are far cheaper and take longer; both are fine. Quote freight for the candidate's OWN origin.`,
    `Delivery days: propose your best estimate, but plain code REPLACES it with the real quoted window —`,
    `never invent a fast window to make a product look better; it will simply be overwritten.`,
    `HARD CAP: no variant may be priced above $${(maxPriceCents / 100).toFixed(0)}. This store sells impulse-priced`,
    `gear — an expensive item is dropped no matter how good its margin looks.`,
```

Thread `maxPriceCents` in via `input.knobs?.maxPriceCents ?? 10_000` next to the existing knob reads.

- [ ] **Step 4: Run to verify pass** — that file; typecheck.

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/agents/sourcing-run.ts apps/ops/test/agents-sourcing-run.test.ts
git commit -m "feat(agents): prompt states origin awareness, the \$100 cap, and that windows come from quotes"
```

---

### Task 6: Storefront — delete every blanket delivery promise

**Files:**
- Modify: `apps/storefront/app/components/brand/TrustStrip.tsx`, `app/components/product/TrustBadges.tsx`, `app/components/brand/ValueProps.tsx`, `app/routes/_index.tsx` (meta description), `app/components/brand/DeliveryBadge.tsx`
- Modify: `apps/storefront/e2e/smoke.spec.ts` (asserts the old string)
- Test: `apps/storefront/app/components/brand/__tests__/delivery-badge.test.tsx`, plus the existing trust/policy component tests

**Interfaces:**
- Produces: `DeliveryBadge` renders origin-aware copy from per-product values only.

- [ ] **Step 1: Write the failing tests**

```tsx
it('renders the product’s own window and names the origin honestly', () => {
  render(<DeliveryBadge shipsFrom="CN" minDays="7" maxDays="14" />)
  expect(screen.getByText(/7–14 days/)).toBeInTheDocument()
  expect(screen.getByText(/partner warehouse/i)).toBeInTheDocument()
})
it('US products say US warehouse', () => {
  render(<DeliveryBadge shipsFrom="US" minDays="3" maxDays="7" />)
  expect(screen.getByText(/US warehouse/)).toBeInTheDocument()
})
it('renders nothing without a window (never a default promise)', () => {
  expect(render(<DeliveryBadge shipsFrom="CN" />).container).toBeEmptyDOMElement()
})
```

Plus a guard test in the same file:

```tsx
it('no component hard-codes a site-wide delivery promise', () => {
  render(<><TrustStrip /><ValueProps /></>)  // wrap in the router stub idiom used by home-sections.test.tsx
  expect(screen.queryByText(/3–7 day delivery/)).not.toBeInTheDocument()
})
```

- [ ] **Step 2: Run to verify they fail** — `cd apps/storefront && npx vitest run app/components` → FAIL.

- [ ] **Step 3: Implement**

`DeliveryBadge.tsx`:

```tsx
export function DeliveryBadge({shipsFrom, minDays, maxDays}: {shipsFrom?: string | null; minDays?: string | null; maxDays?: string | null}) {
  if (!shipsFrom || !minDays || !maxDays) return null;
  const origin = shipsFrom === 'CN' ? 'our partner warehouse' : 'our US warehouse';
  return (
    <p className="inline-block -rotate-2 rounded border-2 border-dashed border-info bg-badge px-4 py-2 text-sm font-medium text-ink">
      Arrives in {minDays}–{maxDays} days · ships from {origin}
    </p>
  );
}
```

`TrustStrip.tsx`: `Ships from US warehouses · 3–7 day delivery` → `Free US shipping · every item shows its delivery window`.

`TrustBadges.tsx`: replace the two badges `US warehouses` and `3–7 day delivery` with one — `Delivery window shown on every item` (keep the truck icon; drop the warehouse badge).

`ValueProps.tsx`: replace the `3–7 day delivery` item with `Delivery window shown before you buy`.

`_index.tsx` meta description: `…shipped fast from US warehouses with 3–7 day delivery.` → `…with the delivery window shown on every product before you buy.`

`e2e/smoke.spec.ts`: update the asserted string to the new TrustStrip copy.

- [ ] **Step 4: Run to verify pass** — `npx vitest run app/components` and `pnpm --filter @doge-buddy/storefront typecheck`. Then grep to prove the claim is gone:
`grep -rn "3–7\|3-7 day" apps/storefront/app packages/core/src` → only unrelated hits (e.g. `support/ingest.ts`'s "Steps 3–7" comment).

- [ ] **Step 5: Commit**

```bash
git add apps/storefront/app apps/storefront/e2e
git commit -m "feat(storefront): per-product delivery windows replace the blanket 3–7 day promise"
```

---

### Task 7: Delivery window on product cards (before the click)

**Files:**
- Modify: `apps/storefront/app/routes/collections.$handle.tsx` (`ProductItem` fragment), `app/routes/search.tsx` (its product fragment), `app/components/ProductItem.tsx`
- Test: `apps/storefront/app/components/__tests__/product-item-delivery.test.tsx`

**Interfaces:**
- Consumes: the `dogebuddy` metafields already written at listing time (`ships_from`, `delivery_max_days`).

- [ ] **Step 1: Write the failing test**

```tsx
it('shows the delivery window on the card when the metafields are present', () => {
  renderWithRouter(<ProductItem product={{...baseProduct, shipsFrom: {value: 'CN'}, deliveryMaxDays: {value: '14'}} as never} />)
  expect(screen.getByText(/14 days/)).toBeInTheDocument()
})
it('renders no delivery line when the metafields are absent', () => {
  renderWithRouter(<ProductItem product={baseProduct as never} />)
  expect(screen.queryByText(/days/)).not.toBeInTheDocument()
})
```

(`renderWithRouter` = the `createRoutesStub` helper used by `related-products.test.tsx`.)

- [ ] **Step 2: Run to verify it fails** → FAIL.

- [ ] **Step 3: Implement** — add to the `ProductItem` fragment in `collections.$handle.tsx` and the equivalent fragment in `search.tsx`:

```graphql
    shipsFrom: metafield(namespace: "dogebuddy", key: "ships_from") { value }
    deliveryMaxDays: metafield(namespace: "dogebuddy", key: "delivery_max_days") { value }
```

In `ProductItem.tsx`, after the price line:

```tsx
      {product.deliveryMaxDays?.value ? (
        <p className="mt-1 text-xs text-muted">
          Arrives in ~{product.deliveryMaxDays.value} days
        </p>
      ) : null}
```

(Widen the component's prop type to include the two optional metafield fields; run `pnpm --filter @doge-buddy/storefront codegen` before typecheck.)

- [ ] **Step 4: Run to verify pass** — `npx vitest run app/components` + codegen + typecheck.

- [ ] **Step 5: Commit**

```bash
git add apps/storefront/app apps/storefront/storefrontapi.generated.d.ts
git commit -m "feat(storefront): product cards show the delivery window before the click"
```

---

### Task 8: Full verification + docs

**Files:**
- Modify: `docs/ROADMAP.md` (Phase A), `docs/OWNER-CHECKLIST.md` (new owner item)

- [ ] **Step 1: Full suites** — `pnpm --filter @doge-buddy/core test`, `pnpm --filter @doge-buddy/ops test`, `pnpm --filter @doge-buddy/storefront test`, `pnpm -r typecheck`. Expected: green except the two known dev-DB failures.

- [ ] **Step 2: Docs** —
  - `OWNER-CHECKLIST.md`: add the blocking owner item — *"Before any CN product goes on sale: get CJ's written answers on (1) is the line DDP so the customer is never billed on delivery, (2) does the quoted freight include duty, (3) who is the declared Importer of Record — then confirm empirically on the canary order (place it through a CN product)."*
  - `ROADMAP.md` Phase A: note the pivot is built and gated on that verification; link the spec.

- [ ] **Step 3: Commit**

```bash
git add docs/
git commit -m "docs: affordable-catalog pivot built — CN listings gated on the CJ duty/DDP/IOR verification"
```

---

## Self-Review Notes

- **Spec coverage:** §1 economics → Tasks 3–4 · §2 honesty → Tasks 1, 4, 6 · §3 lanes/cap/windows → Tasks 2–5 · §4 storefront → Tasks 6–7 · §5 comfort system → **deliberately out of scope, separate plan** · §6 duty → Task 8 owner item (verification is Robert's, not code) · §7 risks → covered by the gates retained.
- **Type consistency:** `ProductOrigin` (Task 1) used by Tasks 3–5; `maxPriceCents` identical in settings/knobs/input/prompt; `shipsFrom` metafield key `ships_from` matches `apply-new-listing.ts`.
- **Ordering:** 1 → 2 → 3 → 4 → 5 (ops chain), 6 → 7 (storefront, independent of ops), 8 last.
