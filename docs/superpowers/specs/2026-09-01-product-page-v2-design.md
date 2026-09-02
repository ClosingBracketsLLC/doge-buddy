# Product Page v2 + listing enrichment — Design

**Status: approved by Robert (2026-09-01, chat)** — brainstormed from his four asks (variant
switching should change more than price; a photo gallery under the main image; reviews from
somewhere; trust badges) and approved on the presented design, including the reviews decision:
**labeled CJ imports now** (explicitly disclosed as supplier-marketplace reviews), real reviews
via Judge.me post-launch. Absorbs `docs/LAUNCH-BACKLOG.md` P1 items **#6** (image gallery) and
**#7** (structured content); #8 (related products) stays separate.

**Parents:** `2026-08-24-phase-5-sourcing-agent-design.md` (Stage-6 trust model binds this spec) ·
`2026-08-31-catalog-p0-design.md` (listing worker + backfill patterns) · `docs/cj-api-notes.md`
(CJ wire truths; its "Still unverified" list includes `product/productComments`).

**Goal:** a product page where switching variants changes the image and specs, a real gallery,
honest structured content, clearly-labeled supplier reviews, and trust badges near the price —
with every new piece of data written once at listing time by plain code, degrading to exactly
today's page when absent.

## Decisions

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| 1 | Variant image source | Agent proposes `variants[].imageUrl` from CJ's `variantImage`; **Stage 6 overwrites with the live CJ value** during the existing re-verification (`getProduct` is already called — `mapping.ts:82` maps `variantImage` → `SupplierVariantDetail.imageUrl`) | Same trust pattern as supplier costs: the agent cannot invent an image URL that sticks. Zero extra CJ points |
| 2 | Per-variant text | **Not built.** The variant-aware "details" are: image, price (already), and the selected variant's weight row appended to the specs table | CJ variants carry only name/price/weight/image — no per-variant copy exists anywhere; Shopify has no native per-variant description. Anything else would be invented content |
| 3 | Reviews source | Plain code (the apply worker), NOT the agent, fetches `adapter.getProductReviews(pid)` at apply time; up to `SUPPLIER_REVIEWS_MAX = 10` kept | The agent's `get_reviews` output is untrusted free text; the worker's own fetch is the only version published. One extra CJ call (10 points) per listing |
| 4 | Reviews disclosure | Rendered under the heading **"Marketplace reviews"** with the fixed sub-line *"From the supplier's buyers on other marketplaces — not yet from Doge Buddy customers."* | FTC fake-review rule (16 CFR Part 465): these are not this store's buyers; presenting them as such misrepresents the reviewer's experience. Labeled display is the approved middle path; Judge.me replaces/demotes them once real orders exist (backlog #15) |
| 5 | Review scrubbing | A review whose text hits `findClaimViolations` (CLAIM_TERMS) is **dropped**, never rewritten; texts are plain-text-sanitized and length-capped | A supplier review saying "cured my dog's anxiety" becomes OUR publication on our page. Same reject-never-rewrite stance as every other guard |
| 6 | No review structured data | Product JSON-LD gains **no** `review`/`aggregateRating` | Google's review-snippet rules require reviews collected by the site about its product; imported ones invite a manual action. Revisit with Judge.me |
| 7 | Storage | Shopify **metafields on the product**, namespace `dogebuddy`, JSON strings: `highlights`, `specs`, `supplier_reviews` (see §Data shapes). Written in the same `productSet` as the listing | The storefront already reads `dogebuddy.*` metafields (`ships_from` etc. in `products.$handle.tsx`'s fragment) — same read path, no new tables, no storefront→ops coupling |
| 8 | Structured-content author | The agent writes `highlights` (3–5) and `specs` from CJ detail data in the payload; Stage 6 runs the claims scrub and exclusion re-check over them exactly like title/description | It already writes `descriptionHtml`; this is the same content pass, gated by the same guards |
| 9 | Gallery | New `ProductGallery`: main image + thumbnail row from product `media(first: 10)`; a thumb click swaps the main; a variant selection snaps the main to that variant's image | Backlog #6 verbatim; the Clipper already has 3 unused images |
| 10 | Image count | Agent prompt requires **≥3 images** per proposal; Stage 6 does NOT gate on it | An otherwise-good 2-image product should still list; the count shows on the run/proposal page for the human gate |
| 11 | Trust badges | `TrustBadges` row directly under the add-to-cart: US warehouses · 3–7 day delivery · Secure checkout by Shopify · All sales final ([policy](/policies/refund-policy)) | Backlog #7's "TrustStrip near the price", widened; the honesty badge links the load-bearing no-refund policy rather than hiding it |
| 12 | Live-product repair | `backfill-listings` gains the v2 pass: variant images (media create + variant attach) + the `supplier_reviews` metafield (fresh fetch). Content metafields (highlights/specs) are NOT synthesized — no agent ran for those products (§A5) | Same tool that repaired handles/tags/inventory — one repair surface, not another one-off script |
| 13 | Backfill media mutations | Existing products get images via `productCreateMedia` + `productVariantAppendMedia` — **never** a full `productSet` | `apply-new-listing.ts:126-132` documents why: re-sending `variants`/`files` on an existing product rewrites inventory the store moved on from and re-uploads media |

## Data shapes (the `dogebuddy` metafields, all JSON strings)

```ts
// packages/core/src/catalog.ts (or a new content.ts) — shared zod schemas, used by the payload,
// the apply worker, and (types only) the storefront:
export const ProductHighlightsSchema = z.array(z.string().min(3).max(120)).min(3).max(5)
export const ProductSpecsSchema = z.array(z.object({
  label: z.string().min(1).max(40),
  value: z.string().min(1).max(120),
})).min(1).max(10)
export const SupplierReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  text: z.string().min(1).max(500),      // plain text — sanitized, never HTML
  date: z.string().optional(),           // as CJ returns it, display-only
  country: z.string().length(2).optional(),
})
export const SupplierReviewsSchema = z.object({
  average: z.number().min(1).max(5),     // over ALL fetched reviews, not just the kept ones
  count: z.number().int().nonnegative(), // CJ's total where available, else fetched count
  reviews: z.array(SupplierReviewSchema).max(10),
  fetchedAt: z.string(),                 // ISO — the storefront shows "as of <date>"
})
```

Metafield keys: `dogebuddy.highlights`, `dogebuddy.specs`, `dogebuddy.supplier_reviews`, plus the
existing `ships_from` / `delivery_min_days` / `delivery_max_days`. `whats_in_box` is **one more
optional payload string** (`z.string().max(200).optional()`) stored as `dogebuddy.whats_in_box`.

## A. Listing side (ops)

### A1. Payload schema (`packages/core/src/proposals.ts`)

- `listingVariant` gains `imageUrl: z.url().refine(http(s)).optional()`.
- `NewListingPayloadSchema` gains `highlights` (ProductHighlightsSchema — **required** for new
  listings; the prompt demands it and CJ detail always supports 3 bullets), `specs`
  (ProductSpecsSchema, required), `whatsInBox` (optional). Reviews are NOT in the payload
  (Decision 3 — the worker fetches its own).
- Existing stored proposals predate these fields → the schema must keep parsing old payloads:
  `highlights`/`specs` use `.optional()` at the schema level with the REQUIREMENT enforced in the
  sourcing prompt + a Stage-6 drop (`sourcing_winner_missing_content`) — a support-side or legacy
  `new_listing` payload without them still applies (renders today's page, Decision on degrade).

### A2. Agent prompt (`agents/sourcing-run.ts`)

- Task step 3 extended: ≥3 `imageUrls` (Decision 10), per-variant `imageUrl` copied from the
  variant's `variantImage` in `get_product_detail`, `highlights` (3–5 factual bullets), `specs`
  from CJ data (size/material/weight), optional `whatsInBox`. All under the existing disallowed-
  claims HARD RULE (the scrub now covers them — say so in the prompt).

### A3. Stage 6 (`sourcing/submit-winners.ts`)

- Claims scrub (step 5) extends its inputs: `...payload.highlights ?? [], ...(payload.specs ?? []).map(s => s.value), payload.whatsInBox` — `findClaimViolations` is already variadic.
- Category-exclusion re-check (step 4) gains the same strings.
- New drop `sourcing_winner_missing_content` when `sourceWorkflow === 'sourcing.weekly'` and
  `highlights`/`specs` are absent (legacy/support payloads pass — see A1).
- CJ re-verification (step 7) additionally **overwrites each variant's `imageUrl` with the live
  `SupplierVariantDetail.imageUrl`** (undefined clears it — a variant CJ shows no image for gets
  none). No new CJ call; `getProduct` is already fetched.

### A4. Apply worker (`proposals/apply-new-listing.ts`)

On the CREATE path only (the DRAFT→ACTIVE flip resends merchandising scalars but never
variants/files — unchanged):

1. `productSet` variants gain `file: { originalSource: v.imageUrl, contentType: 'IMAGE' }` for
   variants that have one. **FIXTURE-ASSUMPTION (live-verify): per-variant `file` on
   `ProductVariantSetInput` in the store's 2026-07 schema** — the repo's `productSet` wrapper
   passes `input` through untyped, so no wrapper change; if the live schema rejects it, fallback
   is the backfill path's mutation pair (Decision 13) run post-create.
2. `productSet.input.metafields` gains the four `dogebuddy` JSON metafields (highlights/specs/
   whats_in_box when present). Hoisted with the merchandising scalars so the ACTIVE flip
   idempotently re-sends them (safe: same values).
3. **Review fetch** (new step, after the CJ stock reads, before `productSet`):
   `adapter.getProductReviews(pid)` (10 CJ points, spends from the listing's normal flow — this
   worker doesn't use `PointsAllowance`; it is not agent-driven). Pipeline: sanitize each review
   to plain text (strip tags via `htmlToText`, collapse whitespace, cap 500 chars), drop
   `findClaimViolations` hits, drop empty, sort rating-desc then date-desc, keep 10; compute
   `average` over all fetched, `count` from CJ's total field if the live shape has one else
   fetched length. Failure or zero reviews → **listing proceeds without the metafield**, one
   `info` alert `listing_reviews_unavailable`. Wire shape of `product/productComments` is on the
   cj-api-notes "Still unverified" list — the first live listing IS the probe; the mapping layer
   must treat every field as optional.

### A5. Backfill (`scripts/backfill-listings.ts`)

New v2 pass per live product (idempotent, dry-run aware like the rest of the script):
- Variant images: fetch CJ detail via `supplier_variant_mappings` → for each variant with a CJ
  image and no Shopify image, `productCreateMedia` (the image) + `productVariantAppendMedia`
  (link). Both mutations are new to `packages/shopify-admin/operations.ts` — wire shapes
  live-verified the way `productUpdate` was (Decision 13).
- Metafields: `highlights`/`specs` are NOT synthesized by backfill (no agent ran) — backfill only
  writes `supplier_reviews` (fresh fetch, same pipeline as A4.3) and leaves content fields for a
  future re-listing. The 2–3 live products get reviews + variant images + gallery, not bullets.
  (Robert can ask for a one-off content pass later; not this spec.)

## B. Storefront (`apps/storefront`)

### B1. Query (`routes/products.$handle.tsx`)

`PRODUCT_FRAGMENT` gains `media(first: 10) { nodes { ... on MediaImage { id image { url altText
width height } } } }` and the three new metafields (same `metafield(namespace:"dogebuddy", ...)`
pattern as `ships_from`). Metafield JSON is parsed in the loader with the shared zod schemas —
parse failure = field treated as absent (never a 500; log nothing user-facing).

### B2. Components (all new files under `components/product/`, each rendering `null` on absent data)

- **`ProductGallery`** — replaces the bare `<ProductImage>` slot. State: `selectedMediaId | null`.
  Main image = the explicitly clicked thumb, else `selectedVariant.image`, else first media, else
  the existing mascot placeholder (reuse `ProductImage` for the main frame). Thumbnail row under
  the main (small squares, current one ink-bordered); on variant change (`selectedVariant.image.id`
  changes) reset `selectedMediaId` to null so the variant's image wins. One image → no thumb row
  (today's rendering).
- **`ProductHighlights`** — `<ul>` of bullets under the price/badges.
- **`ProductSpecs`** — two-column table; appends a `Weight` row from the **selected variant** when
  the variant carries weight (needs `weight`/`weightUnit`? Storefront API exposes variant
  `weight` only via `unitPrice`/measurement fields on newer versions — if the field is not
  available on this API version, the row falls back to a `specs` entry the agent wrote; check at
  plan time, do not block the table on it).
- **`WhatsInBox`** — one-liner section.
- **`ShippingReturnsAccordion`** — `<details>` blocks built from `POLICY_COPY` (direct import from
  `@doge-buddy/core`, the exact pattern of `app/content/policies.tsx`): a "Shipping" summary from
  the shipping policy's lead paragraphs + the delivery metafields, and a "Returns" summary from
  the refund policy, each ending with a link to the full policy page. No new copy is authored.
- **`TrustBadges`** — Decision 11's four badges; compact icons + text, rendered under the
  add-to-cart. (The Footer's `TrustStrip` stays as-is.)
- **`SupplierReviews`** — heading "Marketplace reviews", the fixed disclosure sub-line (Decision
  4, verbatim), aggregate line (`★ 4.6 · 1,238 marketplace ratings · as of <fetchedAt date>`),
  then the review cards (stars, text, date/country when present). Renders nothing without the
  metafield. No schema.org markup (Decision 6).
- **Quantity selector** — in `ProductForm`, a stepper wired to the `AddToCartButton` line
  quantity (backlog #7's last item).

### B3. Page layout (top to bottom, right column on desktop)

Title → price → DeliveryBadge → ProductForm (options + qty + add-to-cart) → TrustBadges →
ProductHighlights → Description → ProductSpecs → WhatsInBox → ShippingReturnsAccordion.
Full-width below the grid: SupplierReviews. Gallery occupies the left column.

## Error handling

| Failure | Effect |
|---|---|
| Any metafield absent/unparseable | Section renders null; page = today's page |
| CJ reviews fetch fails at apply time | Listing proceeds, `info` `listing_reviews_unavailable` |
| Every review scrubbed away | No metafield written (an empty reviews section is worse than none) |
| Live schema rejects per-variant `file` | Fallback: post-create `productCreateMedia` + `productVariantAppendMedia` (the backfill pair); spec's only blocking unknown, resolved on the first live listing |
| Variant with no CJ image | No `file`; page falls back through the gallery chain (thumb → variant → first media) |
| Old payloads without highlights/specs | Parse + apply fine; sections absent (A1) |

## Testing

Mock tier: core schema tests (new fields, old-payload compat); submit-winners (scrub over
highlights/specs/whatsInBox, `sourcing_winner_missing_content` gating by sourceWorkflow, variant
imageUrl overwrite incl. clear-on-absent); apply-new-listing (variant `file` in productSet input,
metafields present, review pipeline: sanitize/scrub/sort/cap/aggregate, fetch-failure proceeds);
backfill (media+append calls, dry-run, idempotency — skip variants that already have an image);
storefront component tests (each component with and without data; gallery selection/variant-reset
logic; disclosure line verbatim). Live tier (Robert + Claude): `backfill-listings` on the live
products (checks the two new mutations + the productComments wire shape), then one
`run-sourcing --max-winners 2` listing end-to-end; eyeball a product page on the Fold.

## Owner setup / owner calls

- None new. CJ points cost rises by 10/listing (reviews). The `product/productComments` live probe
  happens via the backfill run.
- Explicit standing decision to revisit at Judge.me time (backlog #15): imported reviews demote
  below real ones or retire; JSON-LD reviews only then.

## Non-goals

Per-variant descriptions (Decision 2) · related products (#8) · review pagination or fetching
more than one CJ page · translating/curating review text beyond sanitize+scrub · reviews on
collection cards · Judge.me integration (#15) · re-generating content for already-live products
(A5 note) · home-page changes (#9).

## Risks (accepted)

- **Review authenticity optics.** Even labeled, marketplace reviews can read as astroturf to a
  careful shopper. The disclosure line is deliberately blunt; Robert owns the call (2026-09-01).
- **`productComments` wire shape unknown** — the mapping is written all-optional and the feature
  degrades to "no reviews section"; worst case is a fetch that never yields usable reviews until
  the mapping is corrected against the live shape.
- **Per-variant `file` on this API version** — explicit fallback path specified (§Error handling).

## Panel amendments (2026-09-01, adversarial 5-lens review of spec + plan — approved text above unchanged)

1. **Fail-safe ratings (supersedes part of Decision 3 / §Risks).** The CJ review mapper defaulted a
   missing/unparsable score to `rating: 5` — on the unverified `productComments` wire shape that
   could publish a wall of fabricated 5-star cards. `SupplierProductReview.rating` is now optional,
   never defaulted; rating-less reviews are never published or counted, and `average`/`count` run
   over rated reviews only. The §Risks worst case is thereby "no reviews section", as intended.
2. **No metafields on the DRAFT→ACTIVE flip (amends §A4.2).** Hoisting a partial metafields list
   onto the flip leaned on unverified omit-preservation semantics; the flip stays byte-identical
   to today (live products already prove stored metafields survive the metafield-less flip).
   Content metafields ride the CREATE `productSet` only.
3. **Metafield definitions on live (amends §Owner setup "None new").** The Storefront API serves a
   metafield only where a definition with storefront exposure exists; the backfill v2 pass gains a
   definitions-ensure step (list + create the four v2 definitions, `PUBLIC_READ`, same path the
   original three took via seed-store).
4. **Approval gate sees the copy (extends Decision 8).** The admin proposal preview renders
   highlights/specs/what's-in-box (escaped); the apply worker additionally re-scrubs v2 content as
   a plain-code backstop for payloads that never passed Stage 6 (`listing_content_claims_blocked`,
   degrade to the pre-v2 page).
5. **Mechanical corrections.** The returns-policy link is `/policies/returns` (Decision 11's
   `/policies/refund-policy` handle does not exist); spec-table labels are scrubbed alongside
   values; review dates are kept only as `YYYY-MM-DD`; backfill media work is grouped per unique
   image URL with created-media cleanup on failure (idempotent reruns); review text is scrubbed
   full-length before the display cap. Variant `weight`/`weightUnit` is confirmed available on
   Storefront 2026-04, resolving §B2's open check.
