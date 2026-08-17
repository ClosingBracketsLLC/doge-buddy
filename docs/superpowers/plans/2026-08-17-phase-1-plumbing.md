# Doge Buddy Phase 1 — Shopify + Supplier Plumbing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the two integration packages every later phase depends on — `packages/supplier` (SupplierAdapter interface, MockSupplierAdapter, shared contract test suite, CJ Dropshipping client + adapter) and `packages/shopify-admin` (client-credentials token manager, GraphQL client pinned 2026-07, typed operations, webhook HMAC) — plus the ops webhook receiver with at-least-once dedup, processor stubs, the daily webhook-subscription audit job, and live-verification scripts that run the moment Robert supplies credentials.

**Architecture:** Both integration packages are dependency-light and fully testable offline: HTTP goes through an injected `fetchImpl`, persistence through injected store interfaces, and time/sleep through injected clocks — so every behavior (token refresh, rate limiting, envelope errors, HMAC, idempotent order placement) is exercised by fast unit tests against fixtures. The ops service wires real implementations (Postgres-backed CJ token store, pg-boss enqueue) around them. No live credentials are required for any test in this plan; live checks are isolated in `verify-live.ts` (skips cleanly per-service when env is missing).

**Tech Stack:** TypeScript 5.9 strict (existing base config), Node 22+ global `fetch`/`Response`, `node:crypto`, Vitest, Drizzle (ops store impls only), pg-boss v10, Fastify v5. No new runtime dependencies in the two packages.

## Global Constraints

- Monorepo conventions from Phase 0: source-exported packages (`"exports": {".": "./src/index.ts"}`), explicit `.ts` import extensions, `tsc --noEmit` typecheck, tests in `test/`, commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- All money crossing our boundary is **integer cents**; CJ/Shopify speak USD decimals — convert at the adapter edge with `usdToCents` (Task 1). Never store or return floats.
- CJ API base: `https://developers.cjdropshipping.com/api2.0/v1`; auth header `CJ-Access-Token`; response envelope `{code, result, message, data, requestId}` with success `code === 200`; access token lives 15 days (refresh at ≥13 days), refresh token 180 days; free-tier 1 request/second; daily points budget 50,000 (product list calls cost 50 points, most others 10).
- CJ payment error code `1600100` = insufficient balance → normalized `failureReason: 'insufficient_balance'`.
- Shopify: Admin GraphQL pinned **2026-07** at `https://{shop}/admin/api/2026-07/graphql.json`; client-credentials grant `POST https://{shop}/admin/oauth/access_token` with `{client_id, client_secret, grant_type: "client_credentials"}` → `{access_token, expires_in≈86399}`; refresh 5 minutes early. Webhook HMAC: base64 HMAC-SHA256 of the **raw body** with the client secret, header `X-Shopify-Hmac-Sha256`, compare with `timingSafeEqual`.
- CJ webhook signature: base64 HMAC-SHA256 of the raw body keyed with the account `openId`.
- Webhook receiver contract (design doc): verify → insert `webhook_events` `ON CONFLICT (source, external_event_id) DO NOTHING` → enqueue → ack fast. Handlers never process inline.
- **Fixture caveat (applies to all CJ/Shopify fixtures):** request/response shapes come from the committed research digest (`docs/superpowers/specs/2026-08-09-doge-buddy-research-digest.md`), verified against docs 2026-08-09. Where a field name is best-effort (marked `FIXTURE-ASSUMPTION` in code comments), keep the mapping isolated so re-recording real fixtures (once Robert's credentials exist — see `docs/OWNER-CHECKLIST.md`) is a fixture-file swap, not a refactor. This is the sanctioned pattern; implementers must not invent additional untracked assumptions.
- The `@idempotent` GraphQL directive (mandatory on refund/inventory mutations since API 2026-04) is emitted by exactly one function (`withIdempotencyKey`, Task 8) so a syntax correction against live docs is a one-line change.
- Docker test DB `postgres://doge:doge@localhost:5433/doge_buddy` (run `pnpm db:up`; migrate with `DATABASE_URL=… pnpm --filter @doge-buddy/db migrate`). Suite baseline before this plan: 24 tests green.

---

### Task 1: `usdToCents` in `packages/core`

**Files:**
- Modify: `packages/core/src/money.ts`, `packages/core/src/index.ts` (no index change needed — money.ts already re-exported)
- Test: `packages/core/test/money.test.ts` (append)

**Interfaces:**
- Consumes: existing `assertCents`.
- Produces: `usdToCents(value: number | string): number` — `19.99 → 1999`, `"7.5" → 750`, `0 → 0`; rounds half-up at the 3rd decimal (`1.005 → 101`); throws `RangeError` on `NaN`/`Infinity`/negative/unparseable string. Used by every CJ mapping and verify-live.

- [ ] **Step 1: Append failing tests to `packages/core/test/money.test.ts`**

```ts
describe('usdToCents', () => {
  it('converts numbers and numeric strings to integer cents', () => {
    expect(usdToCents(19.99)).toBe(1999)
    expect(usdToCents('7.5')).toBe(750)
    expect(usdToCents(0)).toBe(0)
    expect(usdToCents('12')).toBe(1200)
    expect(usdToCents(1.005)).toBe(101) // rounds half-up despite float representation
  })
  it('rejects negatives, non-finite, and junk strings', () => {
    expect(() => usdToCents(-1)).toThrow(RangeError)
    expect(() => usdToCents(Number.NaN)).toThrow(RangeError)
    expect(() => usdToCents('12,50')).toThrow(RangeError)
    expect(() => usdToCents('')).toThrow(RangeError)
  })
})
```

(Add `usdToCents` to the existing import from `@doge-buddy/core`.)

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @doge-buddy/core test` → FAIL (`usdToCents` not exported).

- [ ] **Step 3: Implement in `packages/core/src/money.ts`**

```ts
export function usdToCents(value: number | string): number {
  const n = typeof value === 'string' ? Number(value.trim() === '' ? Number.NaN : value) : value
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`invalid USD amount: ${String(value)}`)
  const cents = Math.round(n * 100)
  assertCents(cents, 'usdToCents result')
  return cents
}
```

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @doge-buddy/core test && pnpm --filter @doge-buddy/core typecheck` → all green (14 core tests).

- [ ] **Step 5: Commit** — `git add packages/core && git commit -m "feat(core): usdToCents boundary conversion"` (+ trailer).

---

### Task 2: `packages/supplier` scaffold, domain types, `SupplierAdapter` interface

**Files:**
- Create: `packages/supplier/package.json`, `packages/supplier/tsconfig.json`, `packages/supplier/vitest.config.ts`, `packages/supplier/src/types.ts`, `packages/supplier/src/index.ts`

**Interfaces:**
- Consumes: nothing (types only; `@doge-buddy/core` dep declared for later tasks).
- Produces: every exported type below, verbatim — later tasks and packages import these exact names.

- [ ] **Step 1: Scaffold** — `package.json` (name `@doge-buddy/supplier`, deps: `"@doge-buddy/core": "workspace:*"`; devDeps: `typescript ^5.9.2`, `vitest ^3.2.0`), `tsconfig.json` (`extends ../../tsconfig.base.json`, include `["src","test"]`), `vitest.config.ts` (same shape as core's). Run `pnpm install`.

- [ ] **Step 2: Write `packages/supplier/src/types.ts`** — complete file:

```ts
export type SupplierKey = 'cj' | 'mock'

export interface Address {
  name: string
  phone?: string
  email?: string
  line1: string
  line2?: string
  city: string
  state: string
  zip: string
  country: string // ISO-3166 alpha-2, 'US' at launch
}

export interface SupplierProductSummary {
  supplierProductId: string
  title: string
  imageUrl?: string
  sellPriceCents: number
  listedCount?: number
  categoryName?: string
}

export interface SupplierVariantDetail {
  supplierVariantId: string
  sku?: string
  name?: string
  priceCents: number
  weightGrams?: number
  imageUrl?: string
}

export interface SupplierProductDetail {
  supplierProductId: string
  title: string
  descriptionHtml?: string
  imageUrls: string[]
  categoryName?: string
  variants: SupplierVariantDetail[]
}

export interface WarehouseStock {
  countryCode: string
  quantity: number
  verified: boolean
}

export interface ShippingOption {
  name: string
  priceCents: number
  minDays: number
  maxDays: number
}

export type SupplierOrderStatusValue =
  | 'created' | 'unpaid' | 'pending' | 'processing'
  | 'shipped' | 'delivered' | 'cancelled' | 'unknown'

export interface SupplierOrderStatus {
  value: SupplierOrderStatusValue
  raw: string
}

export interface TrackingInfo {
  trackingNumber: string
  carrier?: string
  lastMileTrackingNumber?: string
}

export interface DisputeOptions {
  disputable: boolean
  maxRefundCents?: number
  reasons: { id: string; label: string }[]
  allowedKinds: ('refund' | 'reissue')[]
}

export interface DisputeStatus {
  value: 'pending' | 'refunded' | 'reissued' | 'rejected' | 'unknown'
  raw?: string
}

export interface SupplierWebhookEvent {
  type: 'order' | 'logistics' | 'stock' | 'product' | 'other'
  externalEventId: string
  supplierOrderId?: string
  payload: unknown
}

export interface PlaceOrderRequest {
  idempotencyKey: string
  shippingAddress: Address
  items: { supplierVariantId: string; quantity: number }[]
  logisticName: string
  fromCountry: string
}

export interface PlaceOrderResult {
  supplierOrderId: string
  shipmentOrderId?: string
  productAmountCents: number
  postageAmountCents: number
  totalAmountCents: number
}

export interface SupplierAdapter {
  readonly key: SupplierKey

  searchProducts(q: {
    keyword?: string
    categoryId?: string
    countryCode?: string
    trending?: boolean
    page?: number
    pageSize?: number
    minPriceCents?: number
    maxPriceCents?: number
  }): Promise<SupplierProductSummary[]>
  getProduct(supplierProductId: string): Promise<SupplierProductDetail>

  getVariantStock(supplierVariantId: string): Promise<WarehouseStock[]>
  quoteShipping(q: {
    fromCountry: string
    toCountry: string
    toZip?: string
    items: { supplierVariantId: string; quantity: number }[]
  }): Promise<ShippingOption[]>

  /** MUST be idempotent on idempotencyKey: repeat call returns the existing order, never creates a second one. */
  placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult>
  confirmOrder(supplierOrderId: string): Promise<void>
  payOrder(shipmentOrderId: string): Promise<{ paid: boolean; failureReason?: 'insufficient_balance' | string }>
  getOrderStatus(supplierOrderId: string): Promise<SupplierOrderStatus>
  getTracking(supplierOrderId: string): Promise<TrackingInfo | null>

  getBalance(): Promise<{ availableCents: number; frozenCents: number }>
  getDisputeOptions(supplierOrderId: string): Promise<DisputeOptions>
  openDispute(req: {
    supplierOrderId: string
    idempotencyKey: string
    reasonId: string
    kind: 'refund' | 'reissue'
    amountCents: number
    message: string
    evidenceUrls?: string[]
  }): Promise<{ disputeId: string }>
  getDispute(disputeId: string): Promise<DisputeStatus>

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean
  parseWebhook(rawBody: Buffer): SupplierWebhookEvent
}
```

`src/index.ts`: `export * from './types.ts'`

- [ ] **Step 3: Verify** — `pnpm --filter @doge-buddy/supplier typecheck` → clean. (Interface-only task; the behavioral gate is Task 3's contract suite.)

- [ ] **Step 4: Commit** — `git add packages/supplier pnpm-lock.yaml && git commit -m "feat(supplier): SupplierAdapter interface and domain types"` (+ trailer).

---

### Task 3: Adapter contract suite + `MockSupplierAdapter`

**Files:**
- Create: `packages/supplier/src/contract/adapter-contract.ts`, `packages/supplier/src/adapters/mock/mock-adapter.ts`
- Modify: `packages/supplier/src/index.ts`
- Test: `packages/supplier/test/mock-adapter.test.ts`

**Interfaces:**
- Consumes: Task 2's types verbatim.
- Produces:
  - `runAdapterContractTests(name: string, setup: () => Promise<AdapterContractContext>): void` with
    `interface AdapterContractContext { adapter: SupplierAdapter; knownVariantId: string; searchKeyword: string; address: Address; advanceToShipped?: (supplierOrderId: string) => Promise<void> }`
  - `class MockSupplierAdapter implements SupplierAdapter` with `constructor(opts?: MockAdapterOptions)` where
    `interface MockAdapterOptions { failPayInsufficientBalance?: boolean; balanceCents?: number; usStock?: Record<string, number>; priceMultiplier?: number }`
    plus test helpers `advanceOrder(supplierOrderId: string, status: SupplierOrderStatusValue): void` (auto-assigns `MOCK-TRACK-<orderId>` on `'shipped'`) and `readonly placedOrders: PlaceOrderResult[]`.
  - Mock catalog constants (used by ops tests later): products `mock-p1` "Tug Rope Toy" (variants `mock-v1` $6.20 cost, `mock-v2` $7.10), `mock-p2` "Slow Feeder Bowl" (`mock-v3` $4.80), `mock-p3` "Calming Dog Bed" (`mock-v4` $18.40); all with US stock 50 by default (override via `usStock`).

- [ ] **Step 1: Write the contract suite** (`src/contract/adapter-contract.ts`) — this IS the test spec; complete file:

```ts
import { describe, expect, it } from 'vitest'
import type { Address, SupplierAdapter } from '../types.ts'

export interface AdapterContractContext {
  adapter: SupplierAdapter
  knownVariantId: string
  searchKeyword: string
  address: Address
  advanceToShipped?: (supplierOrderId: string) => Promise<void>
}

/**
 * Behavioral contract every SupplierAdapter must satisfy.
 * Runs against MockSupplierAdapter always; against the CJ adapter in sandbox
 * mode when CJ_CONTRACT=1 (Task 6).
 */
export function runAdapterContractTests(name: string, setup: () => Promise<AdapterContractContext>): void {
  describe(`SupplierAdapter contract: ${name}`, () => {
    it('searches products and returns well-formed summaries', async () => {
      const { adapter, searchKeyword } = await setup()
      const results = await adapter.searchProducts({ keyword: searchKeyword, countryCode: 'US', pageSize: 10 })
      expect(results.length).toBeGreaterThan(0)
      for (const r of results) {
        expect(r.supplierProductId).toBeTruthy()
        expect(r.title).toBeTruthy()
        expect(Number.isSafeInteger(r.sellPriceCents)).toBe(true)
        expect(r.sellPriceCents).toBeGreaterThan(0)
      }
    })

    it('returns product detail with at least one variant', async () => {
      const { adapter, searchKeyword } = await setup()
      const [first] = await adapter.searchProducts({ keyword: searchKeyword, countryCode: 'US', pageSize: 1 })
      const detail = await adapter.getProduct(first!.supplierProductId)
      expect(detail.variants.length).toBeGreaterThan(0)
      expect(Number.isSafeInteger(detail.variants[0]!.priceCents)).toBe(true)
    })

    it('reports per-warehouse stock for a known variant', async () => {
      const { adapter, knownVariantId } = await setup()
      const stock = await adapter.getVariantStock(knownVariantId)
      expect(stock.length).toBeGreaterThan(0)
      for (const s of stock) {
        expect(s.countryCode).toMatch(/^[A-Z]{2}$/)
        expect(Number.isSafeInteger(s.quantity)).toBe(true)
      }
    })

    it('quotes shipping with integer cents and sane day ranges', async () => {
      const { adapter, knownVariantId } = await setup()
      const options = await adapter.quoteShipping({
        fromCountry: 'US', toCountry: 'US', toZip: '30301',
        items: [{ supplierVariantId: knownVariantId, quantity: 1 }],
      })
      expect(options.length).toBeGreaterThan(0)
      for (const o of options) {
        expect(Number.isSafeInteger(o.priceCents)).toBe(true)
        expect(o.priceCents).toBeGreaterThanOrEqual(0)
        expect(o.minDays).toBeGreaterThan(0)
        expect(o.minDays).toBeLessThanOrEqual(o.maxDays)
      }
    })

    it('placeOrder is idempotent on idempotencyKey', async () => {
      const { adapter, knownVariantId, address } = await setup()
      const req = {
        idempotencyKey: `contract-${name}-idem-1`,
        shippingAddress: address,
        items: [{ supplierVariantId: knownVariantId, quantity: 1 }],
        logisticName: 'Standard', fromCountry: 'US',
      }
      const first = await adapter.placeOrder(req)
      const second = await adapter.placeOrder(req)
      expect(second.supplierOrderId).toBe(first.supplierOrderId)
      expect(second.totalAmountCents).toBe(first.totalAmountCents)
      expect(Number.isSafeInteger(first.totalAmountCents)).toBe(true)
      expect(first.totalAmountCents).toBe(first.productAmountCents + first.postageAmountCents)
    })

    it('runs the confirm → pay → status lifecycle', async () => {
      const { adapter, knownVariantId, address } = await setup()
      const placed = await adapter.placeOrder({
        idempotencyKey: `contract-${name}-life-1`,
        shippingAddress: address,
        items: [{ supplierVariantId: knownVariantId, quantity: 1 }],
        logisticName: 'Standard', fromCountry: 'US',
      })
      await adapter.confirmOrder(placed.supplierOrderId)
      const pay = await adapter.payOrder(placed.shipmentOrderId ?? placed.supplierOrderId)
      expect(pay.paid).toBe(true)
      const status = await adapter.getOrderStatus(placed.supplierOrderId)
      expect(['created', 'unpaid', 'pending', 'processing', 'shipped', 'delivered']).toContain(status.value)
    })

    it('exposes tracking once shipped (when the harness can advance state)', async () => {
      const ctx = await setup()
      if (!ctx.advanceToShipped) return
      const placed = await ctx.adapter.placeOrder({
        idempotencyKey: `contract-${name}-track-1`,
        shippingAddress: ctx.address,
        items: [{ supplierVariantId: ctx.knownVariantId, quantity: 1 }],
        logisticName: 'Standard', fromCountry: 'US',
      })
      expect(await ctx.adapter.getTracking(placed.supplierOrderId)).toBeNull()
      await ctx.advanceToShipped(placed.supplierOrderId)
      const tracking = await ctx.adapter.getTracking(placed.supplierOrderId)
      expect(tracking?.trackingNumber).toBeTruthy()
    })

    it('reports balance in integer cents', async () => {
      const { adapter } = await setup()
      const b = await adapter.getBalance()
      expect(Number.isSafeInteger(b.availableCents)).toBe(true)
      expect(Number.isSafeInteger(b.frozenCents)).toBe(true)
    })

    it('offers dispute options for an order', async () => {
      const { adapter, knownVariantId, address } = await setup()
      const placed = await adapter.placeOrder({
        idempotencyKey: `contract-${name}-disp-1`,
        shippingAddress: address,
        items: [{ supplierVariantId: knownVariantId, quantity: 1 }],
        logisticName: 'Standard', fromCountry: 'US',
      })
      const options = await adapter.getDisputeOptions(placed.supplierOrderId)
      expect(typeof options.disputable).toBe('boolean')
      expect(Array.isArray(options.reasons)).toBe(true)
    })
  })
}
```

- [ ] **Step 2: Write the failing test file** (`test/mock-adapter.test.ts`):

```ts
import { describe, expect, it } from 'vitest'
import { MockSupplierAdapter, runAdapterContractTests } from '@doge-buddy/supplier'

runAdapterContractTests('mock', async () => {
  const adapter = new MockSupplierAdapter()
  return {
    adapter,
    knownVariantId: 'mock-v1',
    searchKeyword: 'rope',
    address: { name: 'Test Dog', line1: '1 Bark St', city: 'Atlanta', state: 'GA', zip: '30301', country: 'US' },
    advanceToShipped: async (id) => adapter.advanceOrder(id, 'shipped'),
  }
})

describe('MockSupplierAdapter specifics', () => {
  it('simulates insufficient balance', async () => {
    const adapter = new MockSupplierAdapter({ failPayInsufficientBalance: true })
    const placed = await adapter.placeOrder({
      idempotencyKey: 'mock-fail-pay', logisticName: 'Standard', fromCountry: 'US',
      shippingAddress: { name: 'T', line1: 'x', city: 'y', state: 'GA', zip: '1', country: 'US' },
      items: [{ supplierVariantId: 'mock-v1', quantity: 1 }],
    })
    const pay = await adapter.payOrder(placed.shipmentOrderId!)
    expect(pay).toEqual({ paid: false, failureReason: 'insufficient_balance' })
  })
  it('honors usStock overrides (0 stock)', async () => {
    const adapter = new MockSupplierAdapter({ usStock: { 'mock-v1': 0 } })
    const stock = await adapter.getVariantStock('mock-v1')
    expect(stock.find((s) => s.countryCode === 'US')?.quantity).toBe(0)
  })
  it('applies priceMultiplier to quotes and orders (price-drift simulation)', async () => {
    const base = new MockSupplierAdapter()
    const drifted = new MockSupplierAdapter({ priceMultiplier: 1.5 })
    const [b] = await base.searchProducts({ keyword: 'rope' })
    const [d] = await drifted.searchProducts({ keyword: 'rope' })
    expect(d!.sellPriceCents).toBe(Math.round(b!.sellPriceCents * 1.5))
  })
  it('throws on unknown variant in placeOrder', async () => {
    const adapter = new MockSupplierAdapter()
    await expect(adapter.placeOrder({
      idempotencyKey: 'mock-bad-variant', logisticName: 'Standard', fromCountry: 'US',
      shippingAddress: { name: 'T', line1: 'x', city: 'y', state: 'GA', zip: '1', country: 'US' },
      items: [{ supplierVariantId: 'nope', quantity: 1 }],
    })).rejects.toThrow(/unknown variant/i)
  })
})
```

- [ ] **Step 3: Run to verify failure** — `pnpm --filter @doge-buddy/supplier test` → FAIL (`MockSupplierAdapter` not exported).

- [ ] **Step 4: Implement `MockSupplierAdapter`** (`src/adapters/mock/mock-adapter.ts`). Requirements the code must satisfy (write straightforward in-memory code; no I/O, no timers):
  - Catalog exactly as the Interfaces block defines (4 variants across 3 products; costs are the *sell* prices of the mock supplier). `searchProducts` filters by keyword substring against title (case-insensitive), returns summaries with `sellPriceCents = round(basePriceCents * priceMultiplier)` (`priceMultiplier` default 1).
  - `getVariantStock` returns `[{ countryCode: 'US', quantity: usStock[vid] ?? 50, verified: true }, { countryCode: 'CN', quantity: 500, verified: false }]`.
  - `quoteShipping` returns two options: `{ name: 'Standard', priceCents: round(499 * priceMultiplier), minDays: 3, maxDays: 7 }` and `{ name: 'Express', priceCents: round(1299 * priceMultiplier), minDays: 1, maxDays: 3 }`; throws on unknown variant.
  - `placeOrder`: unknown variant → `Error('unknown variant: <id>')`; idempotency via a `Map<idempotencyKey, PlaceOrderResult>` — repeat key returns the stored result object; otherwise compute `productAmountCents` = Σ variant price × qty (× multiplier), `postageAmountCents` = Standard option price, ids `mock-order-<n>` / `mock-ship-<n>` (monotonic counter), push onto `placedOrders`, initial status `'created'`.
  - `confirmOrder` → status `'pending'`; unknown id throws. `payOrder`: `failPayInsufficientBalance` → `{ paid: false, failureReason: 'insufficient_balance' }`; else status `'processing'`, `{ paid: true }` (accepts shipment id or order id). `getOrderStatus` returns `{ value, raw: value }`. `advanceOrder(id, status)` sets status; on `'shipped'` stores tracking `MOCK-TRACK-<orderId>`. `getTracking` returns `{ trackingNumber }` only when tracking assigned, else `null`.
  - `getBalance` → `{ availableCents: balanceCents ?? 100_000, frozenCents: 0 }`.
  - `getDisputeOptions` → `{ disputable: true, maxRefundCents: <order total>, reasons: [{ id: 'mock-damaged', label: 'Damaged' }, { id: 'mock-not-delivered', label: 'Not delivered' }], allowedKinds: ['refund', 'reissue'] }` (unknown order throws). `openDispute` idempotent by `idempotencyKey` → `{ disputeId: 'mock-dispute-<n>' }`; `getDispute` → `{ value: 'pending' }` for known ids, `{ value: 'unknown' }` otherwise.
  - `verifyWebhook` → `true`; `parseWebhook` → `JSON.parse(rawBody)`, mapping `{ type: body.type if in the union else 'other', externalEventId: body.id ?? sha256hex(rawBody), supplierOrderId: body.orderId, payload: body }` (use `createHash('sha256')` from `node:crypto`).
  - Add to `src/index.ts`: `export * from './contract/adapter-contract.ts'` and `export * from './adapters/mock/mock-adapter.ts'`.

- [ ] **Step 5: Run to verify pass** — `pnpm --filter @doge-buddy/supplier test && pnpm --filter @doge-buddy/supplier typecheck` → 9 contract tests + 4 specifics green.

- [ ] **Step 6: Commit** — `git add packages/supplier && git commit -m "feat(supplier): adapter contract suite and MockSupplierAdapter"` (+ trailer).

---

### Task 4: CJ HTTP client — token lifecycle, rate limit, points budget, envelope

**Files:**
- Create: `packages/supplier/src/adapters/cj/http.ts`, `packages/supplier/src/adapters/cj/errors.ts`
- Modify: `packages/supplier/src/index.ts`
- Test: `packages/supplier/test/cj-http.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Tasks 5–6 and ops Task 12):
  - `interface StoredCjTokens { accessToken: string; accessExpiresAt: string; refreshToken: string; refreshExpiresAt: string }` (ISO strings)
  - `interface CjTokenStore { load(): Promise<StoredCjTokens | null>; save(tokens: StoredCjTokens): Promise<void> }`
  - `class InMemoryCjTokenStore implements CjTokenStore` (for tests/dev)
  - `type FetchLike = (url: string, init?: RequestInit) => Promise<Response>`
  - `class CjApiError extends Error { code: number; requestId?: string }`
  - `class CjPointsBudgetExceededError extends Error {}`
  - `class CjHttpClient` with
    `constructor(opts: { apiKey: string; tokenStore: CjTokenStore; fetchImpl?: FetchLike; now?: () => Date; sleep?: (ms: number) => Promise<void>; rps?: number; dailyPointsBudget?: number; baseUrl?: string })`
    and `request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, opts?: { query?: Record<string, string | number | undefined>; body?: unknown; points?: number; priority?: boolean }): Promise<T>`
    plus `pointsSpentToday(): number`.
  - Sandbox helpers (thin wrappers used by Task 6's harness): `simulatePay(orderId: string)`, `sandboxUpdateStatus(orderId: string, targetStatus: number)`, `sandboxUpdateTrackNumber(orderId: string, trackNumber: string)`.

- [ ] **Step 1: Write the failing tests** (`test/cj-http.test.ts`) — complete file; this pins the client's behavior:

```ts
import { describe, expect, it, vi } from 'vitest'
import { CjApiError, CjHttpClient, CjPointsBudgetExceededError, InMemoryCjTokenStore } from '@doge-buddy/supplier'

const BASE = 'https://developers.cjdropshipping.com/api2.0/v1'

function envelope(data: unknown, over: Partial<{ code: number; result: boolean; message: string; requestId: string }> = {}) {
  return JSON.stringify({ code: 200, result: true, message: 'success', data, requestId: 'req-1', ...over })
}
const ok = (data: unknown) => new Response(envelope(data), { status: 200 })

function makeClient(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, over: Record<string, unknown> = {}) {
  const calls: { url: string; init?: RequestInit }[] = []
  const client = new CjHttpClient({
    apiKey: '123@api@secret',
    tokenStore: new InMemoryCjTokenStore(),
    fetchImpl: async (url, init) => { calls.push({ url, init }); return handler(url, init) },
    sleep: async () => {},
    now: () => new Date('2026-08-17T00:00:00Z'),
    ...over,
  })
  return { client, calls }
}

const TOKENS = {
  accessToken: 'AT-1', accessExpiresAt: '2026-09-01T00:00:00Z',
  refreshToken: 'RT-1', refreshExpiresAt: '2027-02-01T00:00:00Z',
}

describe('CjHttpClient auth', () => {
  it('fetches an access token on first request and persists it', async () => {
    const { client, calls } = makeClient((url) => {
      if (url.endsWith('/authentication/getAccessToken')) return ok({
        accessToken: 'AT-1', accessTokenExpiryDate: '2026-09-01T00:00:00Z',
        refreshToken: 'RT-1', refreshTokenExpiryDate: '2027-02-01T00:00:00Z',
      })
      return ok({ pong: true })
    })
    await client.request('GET', '/product/ping', { points: 0 })
    expect(calls[0]!.url).toBe(`${BASE}/authentication/getAccessToken`)
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ apiKey: '123@api@secret' })
    // auth call carries no token header; the data call does
    expect((calls[1]!.init!.headers as Record<string, string>)['CJ-Access-Token']).toBe('AT-1')
  })

  it('reuses a stored, unexpired token without re-authenticating', async () => {
    const store = new InMemoryCjTokenStore()
    await store.save(TOKENS)
    const { client, calls } = makeClient(() => ok({}), { tokenStore: store })
    await client.request('GET', '/x', { points: 0 })
    expect(calls).toHaveLength(1) // no auth round-trip
  })

  it('refreshes when the access token is within 2 days of expiry', async () => {
    const store = new InMemoryCjTokenStore()
    await store.save({ ...TOKENS, accessExpiresAt: '2026-08-18T00:00:00Z' }) // expires tomorrow
    const { client, calls } = makeClient((url) => {
      if (url.endsWith('/authentication/refreshAccessToken')) return ok({
        accessToken: 'AT-2', accessTokenExpiryDate: '2026-09-15T00:00:00Z',
        refreshToken: 'RT-2', refreshTokenExpiryDate: '2027-03-01T00:00:00Z',
      })
      return ok({})
    }, { tokenStore: store })
    await client.request('GET', '/x', { points: 0 })
    expect(calls[0]!.url).toContain('refreshAccessToken')
    expect((await store.load())!.accessToken).toBe('AT-2')
  })
})

describe('CjHttpClient envelope + errors', () => {
  it('unwraps data on success and passes query params', async () => {
    const store = new InMemoryCjTokenStore(); await store.save(TOKENS)
    const { client, calls } = makeClient(() => ok({ hello: 'dog' }), { tokenStore: store })
    const data = await client.request<{ hello: string }>('GET', '/product/query', { query: { pid: 'p1', size: 5 }, points: 10 })
    expect(data).toEqual({ hello: 'dog' })
    expect(calls[0]!.url).toBe(`${BASE}/product/query?pid=p1&size=5`)
  })

  it('throws CjApiError with code and requestId on envelope failure', async () => {
    const store = new InMemoryCjTokenStore(); await store.save(TOKENS)
    const { client } = makeClient(() => new Response(envelope(null, { code: 1600100, result: false, message: 'insufficient balance' }), { status: 200 }), { tokenStore: store })
    const err = await client.request('POST', '/shopping/pay/payBalanceV2', { body: {}, points: 10, priority: true }).catch((e) => e)
    expect(err).toBeInstanceOf(CjApiError)
    expect(err.code).toBe(1600100)
    expect(err.requestId).toBe('req-1')
  })

  it('retries on HTTP 429 with backoff, then succeeds', async () => {
    const store = new InMemoryCjTokenStore(); await store.save(TOKENS)
    let n = 0
    const sleeps: number[] = []
    const { client } = makeClient(() => (++n < 3 ? new Response('{}', { status: 429 }) : ok({ done: true })), {
      tokenStore: store, sleep: async (ms: number) => { sleeps.push(ms) },
    })
    const data = await client.request<{ done: boolean }>('GET', '/x', { points: 0 })
    expect(data).toEqual({ done: true })
    expect(sleeps.length).toBe(2)
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!)
  })
})

describe('CjHttpClient rate limit + points', () => {
  it('spaces consecutive requests to 1 rps via sleep', async () => {
    const store = new InMemoryCjTokenStore(); await store.save(TOKENS)
    const sleeps: number[] = []
    const { client } = makeClient(() => ok({}), { tokenStore: store, sleep: async (ms: number) => { sleeps.push(ms) } })
    await client.request('GET', '/a', { points: 0 })
    await client.request('GET', '/b', { points: 0 })
    expect(sleeps.some((ms) => ms > 0)).toBe(true) // second call waited
  })

  it('tracks points and blocks non-priority calls over budget, allows priority', async () => {
    const store = new InMemoryCjTokenStore(); await store.save(TOKENS)
    const { client } = makeClient(() => ok({}), { tokenStore: store, dailyPointsBudget: 60 })
    await client.request('GET', '/product/listV2', { points: 50 })
    expect(client.pointsSpentToday()).toBe(50)
    await expect(client.request('GET', '/product/listV2', { points: 50 })).rejects.toThrow(CjPointsBudgetExceededError)
    await expect(client.request('GET', '/shopping/order/getOrderDetail', { points: 50, priority: true })).resolves.toEqual({})
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @doge-buddy/supplier test cj-http` → FAIL (exports missing).

- [ ] **Step 3: Implement** `errors.ts` (two error classes, `CjApiError` carrying `code`/`requestId`) and `http.ts` satisfying every test above. Implementation notes (follow exactly):
  - Token flow on each `request`: `ensureToken()` → stored tokens from `tokenStore.load()`; if none → `getAccessToken`; else if `accessExpiresAt - now < 2 days` → `refreshAccessToken` (fall back to `getAccessToken` if refresh fails or refresh token expired); else reuse. Auth responses use CJ field names `accessToken`/`accessTokenExpiryDate`/`refreshToken`/`refreshTokenExpiryDate` (map to the store's ISO fields; CJ returns date strings — pass through `new Date(x).toISOString()`). Auth endpoints go through the same envelope handling but never carry the token header and never count points. Serialize concurrent `ensureToken` calls through a single in-flight promise.
  - Rate limit: simple token-bucket-of-one — remember `lastRequestAt` (from injected `now`, in ms); if `1000/rps` ms have not elapsed, `await sleep(remaining)`. Auth requests also count (they hit the same per-account QPS).
  - Points: `pointsSpentToday()` resets when the UTC date of `now()` changes; `request` with `points > 0` adds after a successful call; before the call, if `!priority && spent + points > dailyPointsBudget` (default 50_000) → throw `CjPointsBudgetExceededError`.
  - Envelope: HTTP 429 → backoff retry (sleep `500 * 2^attempt` ms, max 3 attempts) then give up with `CjApiError(429)`. Other non-2xx HTTP → `CjApiError(status)`. JSON envelope with `code !== 200 || result === false` → `CjApiError(code, message, requestId)`.
  - Query building: skip `undefined` values; `encodeURIComponent` both sides.
  - Sandbox helpers: `simulatePay(orderId)` → POST `/shopping/sandbox/simulatePay` `{orderId}`; `sandboxUpdateStatus(orderId, targetStatus)` → POST `/shopping/sandbox/updateStatus` `{orderId, targetStatus}`; `sandboxUpdateTrackNumber(orderId, trackNumber)` → POST `/shopping/sandbox/updateTrackNumber` `{orderId, trackNumber}` — all `points: 0, priority: true`.
  - Export from `src/index.ts`.

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @doge-buddy/supplier test && pnpm --filter @doge-buddy/supplier typecheck`.

- [ ] **Step 5: Commit** — `git add packages/supplier && git commit -m "feat(supplier): CJ HTTP client with token lifecycle, rate limit, points budget"` (+ trailer).

---

### Task 5: CJ adapter — discovery, stock, freight, balance

**Files:**
- Create: `packages/supplier/src/adapters/cj/adapter.ts`, `packages/supplier/src/adapters/cj/mapping.ts`, `packages/supplier/test/fixtures/cj/` (JSON fixtures)
- Modify: `packages/supplier/src/index.ts`
- Test: `packages/supplier/test/cj-adapter-read.test.ts`

**Interfaces:**
- Consumes: `CjHttpClient` (Task 4), types (Task 2), `usdToCents` (Task 1).
- Produces: `class CJSupplierAdapter implements SupplierAdapter` with `constructor(opts: { client: CjHttpClient; openId?: string; sandbox?: boolean })`; `mapping.ts` exports pure mappers (`mapProductSummary`, `mapProductDetail`, `mapStock`, `mapFreightOption`, `parseAgingDays(aging: string): { minDays: number; maxDays: number }`).

**Endpoint map for this task** (paths + points from the research digest; response field names inside fixtures are the committed shapes, `FIXTURE-ASSUMPTION`-commented where best-effort):

| Adapter method | CJ call | points |
|---|---|---|
| `searchProducts` | GET `/product/listV2` — `keyWord`, `categoryId`, `countryCode`, `page` (default 1), `size` (default 20, our `pageSize`), `productFlag: 0` when `trending`, `verifiedWarehouse: 1` when `countryCode` given, `startSellPrice`/`endSellPrice` from min/max cents ÷ 100 | 50 |
| `getProduct` | GET `/product/query` — `pid`, `features: 'enable_description'` | 10 |
| `getVariantStock` | GET `/product/stock/queryByVid` — `vid` | 10 |
| `quoteShipping` | POST `/logistic/freightCalculate` — `{ startCountryCode, endCountryCode, zip, products: [{ vid, quantity }] }` | 10 |
| `getBalance` | GET `/shopping/pay/getBalance` (priority) | 0 |

- [ ] **Step 1: Create fixtures** under `test/fixtures/cj/` — each file is the **envelope's `data` value** (tests wrap it in the envelope). Write exactly:

`product-listV2.json`:
```json
{
  "pageNum": 1, "pageSize": 20, "total": 2,
  "list": [
    { "pid": "cjp-1", "productNameEn": "Interactive Dog Rope Toy", "productImage": "https://cdn.cj.example/rope.jpg", "sellPrice": 6.20, "listedNum": 1200, "categoryName": "Pet Toys" },
    { "pid": "cjp-2", "productNameEn": "Slow Feeder Dog Bowl", "productImage": "https://cdn.cj.example/bowl.jpg", "sellPrice": "4.80", "listedNum": 800, "categoryName": "Pet Bowls" }
  ]
}
```

`product-query.json`:
```json
{
  "pid": "cjp-1", "productNameEn": "Interactive Dog Rope Toy",
  "description": "<p>Durable cotton rope toy.</p>",
  "productImageSet": ["https://cdn.cj.example/rope.jpg", "https://cdn.cj.example/rope2.jpg"],
  "categoryName": "Pet Toys",
  "variants": [
    { "vid": "cjv-1", "variantSku": "CJ-ROPE-S", "variantNameEn": "Small", "variantSellPrice": 6.20, "variantWeight": 120, "variantImage": "https://cdn.cj.example/rope-s.jpg" },
    { "vid": "cjv-2", "variantSku": "CJ-ROPE-L", "variantNameEn": "Large", "variantSellPrice": 7.10, "variantWeight": 200, "variantImage": null }
  ]
}
```

`stock-queryByVid.json`:
```json
[
  { "countryCode": "US", "storageNum": 42, "verifiedWarehouse": 1 },
  { "countryCode": "CN", "storageNum": 500, "verifiedWarehouse": 0 }
]
```

`freight-calculate.json`:
```json
[
  { "logisticName": "USPS+", "logisticPrice": 4.99, "logisticAging": "3-7" },
  { "logisticName": "CJPacket US", "logisticPrice": "12.50", "logisticAging": "2" }
]
```

`balance.json`:
```json
{ "amount": 153.20, "noWithdrawalAmount": 3.20, "freezeAmount": 10.00 }
```

- [ ] **Step 2: Write the failing tests** (`test/cj-adapter-read.test.ts`). Test harness: a `fixtureFetch` that records calls and returns `Response`s wrapping fixture JSON in the standard envelope; client built as in Task 4's tests with a pre-seeded `InMemoryCjTokenStore` (no auth round-trip). Assertions per method:
  - `searchProducts({ keyword: 'dog rope', countryCode: 'US', trending: true, pageSize: 10 })` → URL is `${BASE}/product/listV2?keyWord=dog%20rope&countryCode=US&page=1&size=10&productFlag=0&verifiedWarehouse=1`; result `[0]` equals `{ supplierProductId: 'cjp-1', title: 'Interactive Dog Rope Toy', imageUrl: 'https://cdn.cj.example/rope.jpg', sellPriceCents: 620, listedCount: 1200, categoryName: 'Pet Toys' }`; `[1].sellPriceCents === 480` (string input).
  - `getProduct('cjp-1')` → detail with `descriptionHtml`, both image URLs, 2 variants; variant `[1]` has `priceCents: 710`, `imageUrl: undefined` (null → undefined), `weightGrams: 200`.
  - `getVariantStock('cjv-1')` → `[{ countryCode: 'US', quantity: 42, verified: true }, { countryCode: 'CN', quantity: 500, verified: false }]`.
  - `quoteShipping({ fromCountry: 'US', toCountry: 'US', toZip: '30301', items: [{ supplierVariantId: 'cjv-1', quantity: 2 }] })` → POST body `{ startCountryCode: 'US', endCountryCode: 'US', zip: '30301', products: [{ vid: 'cjv-1', quantity: 2 }] }`; options `[{ name: 'USPS+', priceCents: 499, minDays: 3, maxDays: 7 }, { name: 'CJPacket US', priceCents: 1250, minDays: 2, maxDays: 2 }]`.
  - `getBalance()` → `{ availableCents: 15320, frozenCents: 1000 }`.
  - `parseAgingDays`: `'3-7'→{3,7}`, `'2'→{2,2}`, `'10-15 days'→{10,15}` (strip non-digit/non-dash), garbage → `{ minDays: 1, maxDays: 30 }` fallback (never throws).

Write these as real code — construct the harness inline (≈25 lines) mirroring Task 4's `makeClient`, loading fixtures with `JSON.parse(readFileSync(new URL('./fixtures/cj/<file>.json', import.meta.url), 'utf8'))`.

- [ ] **Step 3: Run to verify failure**, then **Step 4: Implement** `mapping.ts` (pure functions over the fixture field names, `usdToCents` at every money edge, `FIXTURE-ASSUMPTION` comments on `productNameEn`/`variantSellPrice`/`storageNum`/`verifiedWarehouse`/`logisticAging`) and `adapter.ts` (read methods only in this task; write methods land in Task 6 — declare them and `throw new Error('implemented in Task 6')` so the class satisfies the interface temporarily; contract suite does NOT run against CJ yet).

- [ ] **Step 5: Run to verify pass** — full supplier package test + typecheck.

- [ ] **Step 6: Commit** — `git add packages/supplier && git commit -m "feat(supplier): CJ adapter discovery/stock/freight/balance with fixtures"` (+ trailer).

---

### Task 6: CJ adapter — order lifecycle, payment, disputes, webhooks, sandbox harness

**Files:**
- Modify: `packages/supplier/src/adapters/cj/adapter.ts`, `packages/supplier/src/adapters/cj/mapping.ts`
- Create: fixtures `order-create.json`, `order-list-existing.json`, `order-detail.json`, `dispute-products.json`, `dispute-confirm-info.json`, `dispute-create.json`, `dispute-detail.json` under `test/fixtures/cj/`
- Test: `packages/supplier/test/cj-adapter-order.test.ts`, `packages/supplier/test/cj-contract-sandbox.test.ts`

**Interfaces:**
- Consumes: everything prior.
- Produces: complete `CJSupplierAdapter`; the CJ sandbox contract harness (env-gated).

**Endpoint map:**

| Adapter method | CJ call | points |
|---|---|---|
| `placeOrder` | pre-check GET `/shopping/order/list?orderNumbers=<idempotencyKey>` (priority); if a matching order exists, map it and return. Else POST `/shopping/order/createOrderV3` (priority) with `{ orderNumber: idempotencyKey, shippingCountryCode, fromCountryCode, logisticName, shopLogisticsType: 1, payType: 3, consigneeName, phone?, email?, addressLine1, addressLine2?, city, province, zip, products: [{ vid, quantity }], ...(sandbox ? { sandbox: true } : {}) }` | 10 |
| `confirmOrder` | PATCH `/shopping/order/confirmOrder` `{ orderId }` (priority) | 10 |
| `payOrder` | POST `/shopping/pay/payBalanceV2` `{ shipmentOrderId }` (priority); `CjApiError` code `1600100` → `{ paid: false, failureReason: 'insufficient_balance' }` (do NOT rethrow); other errors rethrow | 10 |
| `getOrderStatus`/`getTracking` | GET `/shopping/order/getOrderDetail?orderId=` (priority) | 10 |
| `getDisputeOptions` | GET `/disputes/disputeProducts?orderId=` then POST `/disputes/disputeConfirmInfo` | 10+10 |
| `openDispute` | POST `/disputes/create` `{ businessDisputeId: idempotencyKey, orderId, reasonId, expectResultOption: kind === 'refund' ? 1 : 2, refundAmount: amountCents/100, message, imageUrls }` | 10 |
| `getDispute` | GET `/disputes/getDisputeDetail?disputeId=` | 10 |

Status normalization (in `mapping.ts`, `mapCjOrderStatus(raw: string): SupplierOrderStatusValue`): `CREATED`/`IN_CART`→`created`; `UNPAID`→`unpaid`; `PENDING`→`pending`; `PROCESSING`→`processing`; `SHIPPED`→`shipped`; `DELIVERED`→`delivered`; `CANCELLED`→`cancelled`; anything else→`unknown` (case-insensitive).

Dispute status normalization: `pending`/`processing`→`pending`; `refunded`→`refunded`; `reissued`→`reissued`; `rejected`/`closed`→`rejected`; else `unknown`.

Webhooks: `verifyWebhook(rawBody, headers)` — compute `base64(hmacSHA256(openId, rawBody))`, compare via `timingSafeEqual` against the first present header among `cj-signature`, `x-cj-signature`, `signature` (case-insensitive lookup; `FIXTURE-ASSUMPTION` on header name); no `openId` configured or no header → `false`. `parseWebhook` — JSON parse; `type` from `body.type` lowercased mapped to the union (`ORDER`→`order`, `LOGISTICS`→`logistics`, `STOCK`→`stock`, `PRODUCT`→`product`, else `other`); `externalEventId: body.messageId ?? body.requestId ?? sha256hex(rawBody)`; `supplierOrderId: body.orderId`.

Fixture contents (envelope-`data` values):
- `order-create.json`: `{ "orderId": "cjo-1", "shipmentOrderId": "cjso-1", "productAmount": 13.30, "postageAmount": 4.99, "orderAmount": 18.29 }`
- `order-list-existing.json`: `{ "list": [ { "orderId": "cjo-1", "shipmentOrderId": "cjso-1", "orderNumber": "DB-abc", "productAmount": 13.30, "postageAmount": 4.99, "orderAmount": 18.29, "orderStatus": "CREATED" } ] }` (and tests also use an empty-list variant inline)
- `order-detail.json`: `{ "orderId": "cjo-1", "orderStatus": "SHIPPED", "trackNumber": "CJTRACK123", "logisticName": "USPS+", "lastMileTrackNumber": "9400111899560000000000" }`
- `dispute-products.json`: `{ "list": [ { "lineItemId": "li-1", "vid": "cjv-1", "maxRefundAmount": 18.29 } ] }`
- `dispute-confirm-info.json`: `{ "maxRefundAmount": 18.29, "expectResultOptions": [1, 2], "reasons": [ { "reasonId": "r-42", "reasonNameEn": "Damaged on arrival" }, { "reasonId": "r-43", "reasonNameEn": "Package lost" } ] }`
- `dispute-create.json`: `{ "disputeId": "cjd-1" }`
- `dispute-detail.json`: `{ "disputeId": "cjd-1", "disputeStatus": "processing" }`

- [ ] **Step 1: Write the failing tests** (`test/cj-adapter-order.test.ts`) with the Task 5 harness pattern. Cases (all with exact request-body assertions):
  1. `placeOrder` when order-list returns empty → POSTs createOrderV3 with the full body above (assert `orderNumber === idempotencyKey`, `payType: 3`, `shopLogisticsType: 1`) → returns `{ supplierOrderId: 'cjo-1', shipmentOrderId: 'cjso-1', productAmountCents: 1330, postageAmountCents: 499, totalAmountCents: 1829 }`.
  2. `placeOrder` when order-list returns the existing order → NO createOrderV3 call happens (assert calls array), same mapped result.
  3. `placeOrder` with `sandbox: true` constructor option → body contains `sandbox: true`.
  4. `payOrder` success → `{ paid: true }`; `payOrder` when fetch returns envelope code 1600100 → `{ paid: false, failureReason: 'insufficient_balance' }` (no throw); envelope code 500 → throws `CjApiError`.
  5. `getOrderStatus('cjo-1')` → `{ value: 'shipped', raw: 'SHIPPED' }`; `getTracking` → `{ trackingNumber: 'CJTRACK123', carrier: 'USPS+', lastMileTrackingNumber: '9400…' }`; tracking is `null` when detail has no `trackNumber` (inline fixture variant).
  6. `getDisputeOptions` → `{ disputable: true, maxRefundCents: 1829, reasons: [{ id: 'r-42', label: 'Damaged on arrival' }, { id: 'r-43', label: 'Package lost' }], allowedKinds: ['refund', 'reissue'] }`.
  7. `openDispute` → body has `businessDisputeId` = the idempotency key, `expectResultOption: 1` for `'refund'`, `refundAmount: 18.29` for `amountCents: 1829`; returns `{ disputeId: 'cjd-1' }`. `getDispute` → `{ value: 'pending', raw: 'processing' }`.
  8. `verifyWebhook`: correct signature under header `cj-signature` → true; tampered body → false; missing header → false. (Compute the expected signature in the test with `createHmac('sha256', openId)`.)
  9. `parseWebhook`: `{"type":"LOGISTICS","messageId":"m-1","orderId":"cjo-1"}` → `{ type: 'logistics', externalEventId: 'm-1', supplierOrderId: 'cjo-1', payload: {...} }`; body without ids → `externalEventId` is a 64-char hex string.
  10. `mapCjOrderStatus` table test for all normalized values + unknown.

- [ ] **Step 2: Run to verify failure**, **Step 3: Implement** (complete `adapter.ts`, extend `mapping.ts`).

- [ ] **Step 4: Sandbox contract harness** (`test/cj-contract-sandbox.test.ts`):

```ts
import { describe, it } from 'vitest'
import { CJSupplierAdapter, CjHttpClient, InMemoryCjTokenStore, runAdapterContractTests } from '@doge-buddy/supplier'

const enabled = process.env.CJ_CONTRACT === '1' && !!process.env.CJ_API_KEY
if (!enabled) {
  describe('SupplierAdapter contract: cj-sandbox', () => {
    it.skip('set CJ_CONTRACT=1 and CJ_API_KEY to run the live sandbox contract', () => {})
  })
} else {
  const client = new CjHttpClient({ apiKey: process.env.CJ_API_KEY!, tokenStore: new InMemoryCjTokenStore() })
  const adapter = new CJSupplierAdapter({ client, openId: process.env.CJ_OPEN_ID, sandbox: true })
  runAdapterContractTests('cj-sandbox', async () => ({
    adapter,
    knownVariantId: process.env.CJ_CONTRACT_VID ?? '',
    searchKeyword: 'dog toy',
    address: { name: 'DB Sandbox', line1: '1 Test St', city: 'Atlanta', state: 'GA', zip: '30301', country: 'US' },
    advanceToShipped: async (orderId) => {
      for (const s of [400, 500, 600]) await client.sandboxUpdateStatus(orderId, s)
      await client.sandboxUpdateTrackNumber(orderId, `SANDBOX-${orderId}`)
    },
  }))
}
```

(Default CI/dev run shows 1 skipped test; the live path is exercised once Robert's CJ key exists — checklist item.)

- [ ] **Step 5: Run to verify pass** — full package suite + typecheck (sandbox file reports skipped).

- [ ] **Step 6: Commit** — `git add packages/supplier && git commit -m "feat(supplier): CJ order lifecycle, payments, disputes, webhooks; sandbox contract harness"` (+ trailer).

---

### Task 7: `packages/shopify-admin` scaffold + client-credentials token manager

**Files:**
- Create: `packages/shopify-admin/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/token.ts`, `src/index.ts`
- Test: `packages/shopify-admin/test/token.test.ts`

**Interfaces:**
- Consumes: nothing (standalone package; devDeps `typescript`, `vitest`; dep `@doge-buddy/core workspace:*`).
- Produces: `class ShopifyTokenManager { constructor(opts: { shopDomain: string; clientId: string; clientSecret: string; fetchImpl?: FetchLike; now?: () => Date }); getToken(): Promise<string>; invalidate(): void }` and re-exported `type FetchLike` (define locally — do not import from supplier).

- [ ] **Step 1: Scaffold** (same package shape as supplier; name `@doge-buddy/shopify-admin`). `pnpm install`.

- [ ] **Step 2: Write the failing tests** (`test/token.test.ts`):

```ts
import { describe, expect, it } from 'vitest'
import { ShopifyTokenManager } from '@doge-buddy/shopify-admin'

function makeManager(handler: (url: string, init?: RequestInit) => Response, nowRef: { t: number }) {
  const calls: { url: string; init?: RequestInit }[] = []
  const mgr = new ShopifyTokenManager({
    shopDomain: 'doge-test.myshopify.com', clientId: 'cid', clientSecret: 'csec',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return handler(url, init) },
    now: () => new Date(nowRef.t),
  })
  return { mgr, calls }
}
const tokenResponse = (token: string, expiresIn = 86399) =>
  new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), { status: 200 })

describe('ShopifyTokenManager', () => {
  it('requests a client-credentials token on first use', async () => {
    const nowRef = { t: Date.parse('2026-08-17T00:00:00Z') }
    const { mgr, calls } = makeManager(() => tokenResponse('tok-1'), nowRef)
    expect(await mgr.getToken()).toBe('tok-1')
    expect(calls[0]!.url).toBe('https://doge-test.myshopify.com/admin/oauth/access_token')
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ client_id: 'cid', client_secret: 'csec', grant_type: 'client_credentials' })
    expect(await mgr.getToken()).toBe('tok-1')
    expect(calls).toHaveLength(1) // cached
  })
  it('refreshes 5 minutes before expiry', async () => {
    const nowRef = { t: Date.parse('2026-08-17T00:00:00Z') }
    let n = 0
    const { mgr, calls } = makeManager(() => tokenResponse(`tok-${++n}`), nowRef)
    await mgr.getToken()
    nowRef.t += (86399 - 240) * 1000 // 4 minutes before expiry → within refresh window
    expect(await mgr.getToken()).toBe('tok-2')
    expect(calls).toHaveLength(2)
  })
  it('invalidate() forces a new token on next call', async () => {
    const nowRef = { t: 0 }
    let n = 0
    const { mgr } = makeManager(() => tokenResponse(`tok-${++n}`), nowRef)
    await mgr.getToken()
    mgr.invalidate()
    expect(await mgr.getToken()).toBe('tok-2')
  })
  it('throws a readable error on non-2xx', async () => {
    const nowRef = { t: 0 }
    const { mgr } = makeManager(() => new Response('{"errors":"invalid client"}', { status: 401 }), nowRef)
    await expect(mgr.getToken()).rejects.toThrow(/401/)
  })
})
```

- [ ] **Step 3: Run to verify failure**, **Step 4: Implement** `src/token.ts` (single in-flight fetch promise so concurrent `getToken()`s share one request; cache `{ token, expiresAtMs }`; refresh when `now >= expiresAtMs - 300_000`).

- [ ] **Step 5: Run to verify pass**, **Step 6: Commit** — `feat(shopify-admin): client-credentials token manager` (+ trailer).

---

### Task 8: Shopify GraphQL client, error/throttle handling, idempotency directive, webhook HMAC

**Files:**
- Create: `packages/shopify-admin/src/client.ts`, `src/errors.ts`, `src/webhooks.ts`
- Modify: `src/index.ts`
- Test: `packages/shopify-admin/test/client.test.ts`, `test/webhooks.test.ts`

**Interfaces:**
- Consumes: `ShopifyTokenManager` (Task 7).
- Produces:
  - `class ShopifyGraphqlError extends Error { errors: unknown[] }`, `class ShopifyUserError extends Error { userErrors: { field?: string[] | null; message: string }[] }`, `class ShopifyHttpError extends Error { status: number }`
  - `class ShopifyAdminClient { constructor(opts: { shopDomain: string; tokenManager: ShopifyTokenManager; apiVersion?: string; fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void> }); graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> }` — endpoint `https://{shopDomain}/admin/api/{apiVersion ?? '2026-07'}/graphql.json`, header `X-Shopify-Access-Token`.
  - `assertNoUserErrors(payload: unknown, mutationField: string): void` — reads `payload[mutationField].userErrors`; throws `ShopifyUserError` when non-empty.
  - `withIdempotencyKey(document: string, key: string): string` — validates `/^[A-Za-z0-9_-]{1,64}$/` (throws otherwise), inserts ` @idempotent(key: "<key>")` after the operation header (before its `{`). **The only place the directive syntax lives** — carries a comment: `// Directive per Admin API 2026-04 requirement; verify exact syntax against live 2026-07 docs on first real call (isolated here on purpose).`
  - `verifyShopifyWebhookHmac(rawBody: Buffer, hmacHeader: string | undefined, secret: string): boolean` (base64 HMAC-SHA256, `timingSafeEqual`, length-mismatch-safe, `false` on undefined header).

- [ ] **Step 1: Write the failing tests.** `test/client.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  ShopifyAdminClient, ShopifyGraphqlError, ShopifyHttpError, ShopifyTokenManager,
  ShopifyUserError, assertNoUserErrors, withIdempotencyKey,
} from '@doge-buddy/shopify-admin'

const tokenOk = () => new Response(JSON.stringify({ access_token: 'tok', expires_in: 86399 }), { status: 200 })
const gql = (data: unknown, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ data, ...extra }), { status: 200 })

function makeClient(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = []
  const route = (url: string, init?: RequestInit) =>
    url.endsWith('/admin/oauth/access_token') ? tokenOk() : handler(url, init)
  const fetchImpl = async (url: string, init?: RequestInit) => { calls.push({ url, init }); return route(url, init) }
  const tokenManager = new ShopifyTokenManager({ shopDomain: 's.myshopify.com', clientId: 'a', clientSecret: 'b', fetchImpl })
  const client = new ShopifyAdminClient({ shopDomain: 's.myshopify.com', tokenManager, fetchImpl, sleep: async () => {} })
  return { client, calls }
}

describe('ShopifyAdminClient', () => {
  it('POSTs to the pinned 2026-07 endpoint with the token header', async () => {
    const { client, calls } = makeClient(() => gql({ shop: { name: 'Doge' } }))
    const data = await client.graphql<{ shop: { name: string } }>('query { shop { name } }')
    expect(data.shop.name).toBe('Doge')
    const call = calls.find((c) => c.url.includes('/graphql.json'))!
    expect(call.url).toBe('https://s.myshopify.com/admin/api/2026-07/graphql.json')
    expect((call.init!.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('tok')
  })
  it('throws ShopifyGraphqlError on top-level errors', async () => {
    const { client } = makeClient(() => gql(null, { errors: [{ message: 'syntax' }] }))
    await expect(client.graphql('query { x }')).rejects.toThrow(ShopifyGraphqlError)
  })
  it('retries THROTTLED responses with backoff then succeeds', async () => {
    let n = 0
    const { client } = makeClient(() =>
      ++n < 3 ? gql(null, { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }) : gql({ ok: true }))
    await expect(client.graphql('query { x }')).resolves.toEqual({ ok: true })
  })
  it('retries once on HTTP 401 after invalidating the token, then errors', async () => {
    const { client } = makeClient(() => new Response('unauthorized', { status: 401 }))
    await expect(client.graphql('query { x }')).rejects.toThrow(ShopifyHttpError)
  })
})

describe('helpers', () => {
  it('assertNoUserErrors throws with messages', () => {
    expect(() => assertNoUserErrors({ productSet: { userErrors: [{ message: 'bad title' }] } }, 'productSet'))
      .toThrow(ShopifyUserError)
    expect(() => assertNoUserErrors({ productSet: { userErrors: [] } }, 'productSet')).not.toThrow()
  })
  it('withIdempotencyKey injects the directive after the operation header', () => {
    const doc = withIdempotencyKey('mutation RefundCreate($input: RefundInput!) { refundCreate(input: $input) { userErrors { message } } }', 'prop-123')
    expect(doc).toContain('mutation RefundCreate($input: RefundInput!) @idempotent(key: "prop-123") {')
    expect(() => withIdempotencyKey('mutation X { y }', 'bad key!')).toThrow(RangeError)
  })
})
```

`test/webhooks.test.ts`:

```ts
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyShopifyWebhookHmac } from '@doge-buddy/shopify-admin'

describe('verifyShopifyWebhookHmac', () => {
  const secret = 'shhh'
  const body = Buffer.from('{"id":123}')
  const good = createHmac('sha256', secret).update(body).digest('base64')
  it('accepts a valid signature', () => expect(verifyShopifyWebhookHmac(body, good, secret)).toBe(true))
  it('rejects a tampered body', () => expect(verifyShopifyWebhookHmac(Buffer.from('{"id":124}'), good, secret)).toBe(false))
  it('rejects missing/garbage headers without throwing', () => {
    expect(verifyShopifyWebhookHmac(body, undefined, secret)).toBe(false)
    expect(verifyShopifyWebhookHmac(body, 'not-base64-of-right-length', secret)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**, **Step 3: Implement.** Client behavior: HTTP 401 → `tokenManager.invalidate()` + one retry, second 401 → `ShopifyHttpError(401)`; other non-2xx → `ShopifyHttpError(status)`; `errors` array where every error has `extensions.code === 'THROTTLED'` → backoff (`sleep(500 * 2^attempt)`, max 3 attempts) then `ShopifyGraphqlError`; any other `errors` → `ShopifyGraphqlError` immediately; return `json.data`.

- [ ] **Step 4: Run to verify pass**, **Step 5: Commit** — `feat(shopify-admin): GraphQL client, throttle/401 handling, idempotency directive, webhook HMAC` (+ trailer).

---

### Task 9: Shopify typed operations

**Files:**
- Create: `packages/shopify-admin/src/operations.ts`
- Modify: `src/index.ts`
- Test: `packages/shopify-admin/test/operations.test.ts`

**Interfaces:**
- Consumes: `ShopifyAdminClient`, `assertNoUserErrors`, `withIdempotencyKey`.
- Produces (each takes `client: ShopifyAdminClient` first):
  - `listPublications(client): Promise<{ id: string; name: string }[]>`
  - `productSet(client, input: ProductSetInput): Promise<{ productId: string; variants: { id: string; sku?: string }[] }>` where `type ProductSetInput = Record<string, unknown>` (payload validated upstream by `@doge-buddy/core` schemas in later phases; the operation is transport, not policy)
  - `publishablePublish(client, publishableId: string, publicationId: string): Promise<void>`
  - `inventorySetQuantities(client, input: Record<string, unknown>, idempotencyKey: string): Promise<void>`
  - `refundCreate(client, input: Record<string, unknown>, idempotencyKey: string): Promise<{ refundId: string }>`
  - `orderFulfillmentOrders(client, orderGid: string): Promise<{ id: string; status: string }[]>`
  - `fulfillmentCreate(client, args: { fulfillmentOrderId: string; trackingNumber?: string; trackingCompany?: string; notifyCustomer: boolean }): Promise<{ fulfillmentId: string }>`
  - `fulfillmentTrackingInfoUpdate(client, fulfillmentGid: string, tracking: { number: string; company?: string }): Promise<void>`
  - `listWebhookSubscriptions(client): Promise<{ id: string; topic: string; callbackUrl?: string }[]>`
  - `webhookSubscriptionCreate(client, topic: string, callbackUrl: string): Promise<{ id: string }>`
  - `productDelete(client, productGid: string): Promise<void>`

- [ ] **Step 1: Write the failing tests** (`test/operations.test.ts`). Harness: fake fetch capturing the GraphQL POST body (`{ query, variables }`) per call, returning canned `data` per operation. For every operation assert: (a) `query` contains the mutation/query field name (e.g. `/mutation .*productSet/`), (b) `variables` equal the exact expected object, (c) mapped return value, (d) userErrors in the canned response → throws `ShopifyUserError`, (e) for the two idempotent ops: `query` contains `@idempotent(key: "prop-1")`. Canned data shapes to use:
  - publications: `{ publications: { nodes: [{ id: 'gid://shopify/Publication/1', name: 'Hydrogen' }] } }`
  - productSet: `{ productSet: { product: { id: 'gid://shopify/Product/9', variants: { nodes: [{ id: 'gid://shopify/ProductVariant/91', sku: 'DB-1' }] } }, userErrors: [] } }`
  - publishablePublish / inventorySetQuantities / fulfillmentTrackingInfoUpdate / productDelete: `{ <field>: { userErrors: [] } }`
  - refundCreate: `{ refundCreate: { refund: { id: 'gid://shopify/Refund/5' }, userErrors: [] } }`
  - orderFulfillmentOrders: `{ order: { fulfillmentOrders: { nodes: [{ id: 'gid://shopify/FulfillmentOrder/3', status: 'OPEN' }] } } }`
  - fulfillmentCreate: `{ fulfillmentCreate: { fulfillment: { id: 'gid://shopify/Fulfillment/7' }, userErrors: [] } }`
  - webhookSubscriptions: `{ webhookSubscriptions: { nodes: [{ id: 'gid://shopify/WebhookSubscription/2', topic: 'ORDERS_PAID', endpoint: { callbackUrl: 'https://ops.example/webhooks/shopify' } }] } }`
  - webhookSubscriptionCreate: `{ webhookSubscriptionCreate: { webhookSubscription: { id: 'gid://shopify/WebhookSubscription/4' }, userErrors: [] } }`

  `fulfillmentCreate` variables must be `{ fulfillment: { lineItemsByFulfillmentOrder: [{ fulfillmentOrderId }], trackingInfo: { number, company }, notifyCustomer } }` (omit `trackingInfo` when no number). `webhookSubscriptionCreate` variables: `{ topic, webhookSubscription: { uri: callbackUrl } }` (2026-07 uses `uri`; comment `FIXTURE-ASSUMPTION` vs legacy `callbackUrl`).

- [ ] **Step 2: Run to verify failure**, **Step 3: Implement `operations.ts`** — one exported async function per operation, each: build document (template literal, `#graphql` comment prefix), call `client.graphql`, `assertNoUserErrors` where applicable, map result. GraphQL documents request only the fields the return types need.

- [ ] **Step 4: Run to verify pass** — package suite + typecheck. **Step 5: Commit** — `feat(shopify-admin): typed operations for products, publishing, inventory, refunds, fulfillment, webhooks` (+ trailer).

---

### Task 10: ops config extension (Shopify/CJ/supplier settings, all optional)

**Files:**
- Modify: `apps/ops/src/config.ts`, `apps/ops/.env.example`, `apps/ops/package.json` (add deps `@doge-buddy/supplier`, `@doge-buddy/shopify-admin` as `workspace:*`)
- Test: `apps/ops/test/config.test.ts` (extend)

**Interfaces:**
- Consumes: existing `loadConfig`.
- Produces — extended `Config`:
  ```ts
  export interface Config {
    databaseUrl: string
    port: number
    host: string
    supplier: 'mock' | 'cj'
    adminBaseUrl?: string
    shopify?: { shopDomain: string; clientId: string; clientSecret: string; webhookSecret: string }
    cj?: { apiKey: string; openId: string }
  }
  ```
  Rules: `SUPPLIER` env ∈ {mock, cj}, default `mock`; `ADMIN_BASE_URL` optional (must be http(s) URL when set); the 4 `SHOPIFY_*` vars are all-or-none (partial set → throw naming the missing ones); `CJ_API_KEY`/`CJ_OPEN_ID` all-or-none; `SUPPLIER=cj` without the CJ pair → throw.

- [ ] **Step 1: Extend the tests** — new cases: defaults (`supplier: 'mock'`, no shopify/cj blocks); full shopify set → block present; partial shopify (`SHOPIFY_SHOP_DOMAIN` only) → throws `/SHOPIFY_CLIENT_ID/`; cj pair → block present; `SUPPLIER=cj` without pair → throws `/CJ_API_KEY/`; `SUPPLIER=bogus` → throws; `ADMIN_BASE_URL=notaurl` → throws.
- [ ] **Step 2: Verify failure → Step 3: Implement** (zod: optional fields + `superRefine` for the all-or-none rules) → **Step 4: Verify pass** (all existing config tests must stay green; update `.env.example` with commented-out new vars) → **Step 5: Commit** — `feat(ops): config for shopify/cj credentials and supplier selection` (+ trailer).

---

### Task 11: ops webhook receiver — raw body, HMAC, dedup, enqueue

**Files:**
- Create: `apps/ops/src/http/webhooks.ts`
- Modify: `apps/ops/src/server.ts` (accept + register the plugin), `apps/ops/src/index.ts` (wire deps)
- Test: `apps/ops/test/webhooks.test.ts`

**Interfaces:**
- Consumes: `verifyShopifyWebhookHmac` (Task 8), drizzle `webhookEvents` (`@doge-buddy/db`), a boss-like `{ send(name: string, data: object): Promise<unknown> }`.
- Produces:
  - `webhookRoutes(deps: WebhookDeps): FastifyPluginAsync` with
    ```ts
    export interface WebhookDeps {
      db: NodePgDatabase<typeof schema> // ReturnType<typeof createDb>['db']
      enqueue: (name: 'webhook.shopify.process' | 'webhook.cj.process', data: { webhookEventId: string }) => Promise<void>
      shopifyWebhookSecret?: string
      cjVerify?: (rawBody: Buffer, headers: Record<string, string | string[] | undefined>) => boolean
      cjParse?: (rawBody: Buffer) => { externalEventId: string; type: string }
    }
    ```
  - `buildServer` signature grows an optional `webhooks?: WebhookDeps` field on its deps: when present, registers the plugin under prefix `/webhooks`.
  - Route behavior (both routes): raw-buffer content parser scoped to the plugin (`fastify.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))`); unconfigured service (no secret / no cjVerify) → 503 `{ error: 'not configured' }`; failed verification → 401; verified → insert `webhookEvents` with `onConflictDoNothing({ target: [source, externalEventId] }).returning({ id })`; empty returning → 200 `{ ok: true, duplicate: true }` (no enqueue); else `enqueue(...)` → 200 `{ ok: true, duplicate: false }`. Shopify identifiers: `x-shopify-webhook-id` header (fallback `sha256hex(rawBody)`), topic `x-shopify-topic`. CJ: from `cjParse` (fallback id `sha256hex(rawBody)`), topic = parsed `type`. `payload` column stores `JSON.parse(rawBody)` (or `{ raw: rawBody.toString('base64') }` if unparseable).

- [ ] **Step 1: Write the failing tests** (`test/webhooks.test.ts`) — integration against the real test DB, fake enqueue. Harness: build server with `webhooks: { db, enqueue: recorded, shopifyWebhookSecret: 'testsecret', cjVerify: (raw) => raw.toString().includes('valid'), cjParse: (raw) => ({ externalEventId: JSON.parse(raw.toString()).id ?? 'cj-x', type: 'order' }) }`; sign shopify payloads in-test with `createHmac('sha256','testsecret')`. Cases:
  1. Valid Shopify HMAC + fresh `x-shopify-webhook-id` → 200 `{ ok: true, duplicate: false }`, one `webhook_events` row (source `shopify`, topic from header, `processed_at` null), `enqueue` called once with the row id.
  2. Same delivery replayed (same webhook id) → 200 `{ ok: true, duplicate: true }`, still exactly one row, `enqueue` NOT called again.
  3. Bad HMAC → 401, zero rows, no enqueue.
  4. No `shopifyWebhookSecret` configured → 503.
  5. CJ valid body → 200 + row with source `cj`; CJ invalid → 401.
  6. Missing `x-shopify-webhook-id` header → still 200; row's `external_event_id` is a 64-hex string.
  (Use unique webhook ids per test run — suffix `Date.now()` — since the dev DB persists between runs.)

- [ ] **Step 2: Verify failure → Step 3: Implement** plugin + `buildServer`/`index.ts` wiring: in `index.ts`, construct `WebhookDeps` only from available config (shopify secret when `config.shopify`; CJ verify/parse from a `CJSupplierAdapter` instance when `config.cj`; both absent → routes return 503, service still boots). `enqueue` wraps `queue.boss.send`; ensure queues `webhook.shopify.process` / `webhook.cj.process` are created in `startQueue` (Task 12 adds the workers — creating queues here is fine and keeps enqueue safe).

- [ ] **Step 4: Verify pass** — ops suite + typecheck (healthz/queue/config tests untouched and green). **Step 5: Commit** — `feat(ops): webhook receiver with HMAC verification, dedup, enqueue-then-ack` (+ trailer).

---

### Task 12: processor stubs, webhook-audit job, Drizzle CJ token store

**Files:**
- Create: `apps/ops/src/jobs/webhook-process.ts`, `apps/ops/src/jobs/shopify-webhook-audit.ts`, `apps/ops/src/stores/cj-token-store.ts`
- Modify: `apps/ops/src/queue.ts` (register the two processor workers; export a `registerCron` helper), `apps/ops/src/index.ts` (schedule audit cron when configured)
- Test: `apps/ops/test/webhook-process.test.ts`, `apps/ops/test/shopify-webhook-audit.test.ts`, `apps/ops/test/cj-token-store.test.ts`

**Interfaces:**
- Consumes: Tasks 4 (CjTokenStore), 9 (operations), 11 (queues), db tables `webhookEvents`, `auditLog`, `cjAuth`.
- Produces:
  - `webhookProcessHandler(db, source: 'shopify' | 'cj')` → pg-boss batch handler: for each job `{ webhookEventId }`, set `processed_at = now()` on the event row and insert `audit_log` (`actor: 'system'`, `action: 'webhook.processed'`, `entity_type: 'webhook_event'`, `entity_id: webhookEventId`, `detail: { source, topic }`). Real routing semantics arrive in Phase 3 — this task only proves the pipeline end-to-end.
  - `shopifyWebhookAudit(deps: { client: ShopifyAdminClient; adminBaseUrl: string }): Promise<{ created: string[] }>` — required topics `['ORDERS_PAID', 'ORDERS_CANCELLED', 'REFUNDS_CREATE']`; list existing subscriptions; for each required topic with no subscription pointing at `${adminBaseUrl}/webhooks/shopify` → `webhookSubscriptionCreate`; returns created topic names. Registered as cron `shopify.webhook-audit` @ `0 6 * * *` only when `config.shopify && config.adminBaseUrl`.
  - `class DrizzleCjTokenStore implements CjTokenStore` — single-row upsert on `cj_auth` (`id = 1`, `onConflictDoUpdate`), ISO strings ↔ timestamptz.
- Tests: (a) processor — insert a webhook_events row, run handler with a synthetic job, assert `processed_at` set + audit row (real DB); (b) audit job — fake client capturing `graphql` calls via injected fetch is overkill: instead pass a stub `client` object `{ graphql: vi.fn() }`… **no** — call it through the real operations against a fake-fetch client (reuse Task 9's harness pattern): first response lists only `ORDERS_PAID` correctly subscribed → expect exactly 2 creates (`ORDERS_CANCELLED`, `REFUNDS_CREATE`) with `uri: 'https://ops.example/webhooks/shopify'`; second scenario all present → `{ created: [] }`; (c) token store — save → load round-trip on real DB, second save overwrites (single row, `select count(*)` = 1).

- [ ] Steps: failing tests → verify RED → implement → verify GREEN (`pnpm test` whole repo; expect prior suites still green) → commit `feat(ops): webhook processors, shopify webhook-audit job, CJ token store` (+ trailer).

---

### Task 13: verify-live + replay-webhook scripts, docs, full-suite gate

**Files:**
- Create: `apps/ops/scripts/verify-live.ts`, `apps/ops/scripts/replay-webhook.ts`
- Modify: `apps/ops/package.json` (scripts: `"verify-live": "tsx scripts/verify-live.ts"`, `"replay-webhook": "tsx scripts/replay-webhook.ts"`), `README.md` (Phase 1 section), `docs/OWNER-CHECKLIST.md` (point the two 🟡 credential items at `pnpm --filter @doge-buddy/ops verify-live`)
- Test: none new (scripts are operational tools; the full-suite gate is the verification)

**Interfaces:**
- Consumes: everything.
- Produces:
  - `verify-live.ts`: loads env via `loadConfig(process.env)` semantics (import `loadConfig`); sections run independently and print `SKIPPED (missing …)` when unconfigured — exit code 1 only if an *attempted* section fails:
    - **Shopify:** token round-trip → `listPublications` (print names) → `productSet` DRAFT product `DB-VERIFY <ISO timestamp>` with one variant (price $1.00) → print product id + admin URL → `productDelete` it (leave nothing behind) → print `SHOPIFY OK`.
    - **CJ:** `CjHttpClient` with `DrizzleCjTokenStore` (falls back to `InMemoryCjTokenStore` when `DATABASE_URL` missing) → `getBalance` → print cents + `CJ OK`.
  - `replay-webhook.ts`: requires `SHOPIFY_WEBHOOK_SECRET` env + running local ops (`PORT` default 3001); builds a sample `orders/paid` payload `{ id: 820982911946154500, test: true, total_price: '11.50' }`, signs it, POSTs twice with the same generated `x-shopify-webhook-id`; prints both JSON responses and exits 0 only if first is `duplicate: false` and second `duplicate: true` — a one-command manual proof of the dedup path.

- [ ] Steps: write both scripts → run `pnpm --filter @doge-buddy/ops verify-live` with no creds (expect two SKIPPED lines, exit 0) → boot ops locally + run `SHOPIFY_WEBHOOK_SECRET=testsecret pnpm --filter @doge-buddy/ops replay-webhook` against a server started with the same secret (expect the duplicate proof; document the two-terminal invocation in the README section) → full gate: `pnpm typecheck && DATABASE_URL=… pnpm test && pnpm db:check` all green → update README + checklist → commit `feat(ops): live verification and webhook replay scripts; Phase 1 docs` (+ trailer).

---

## Phase 1 exit checklist

- [ ] Whole-repo `pnpm typecheck`, `pnpm test`, `pnpm db:check` green (expect ≈70+ tests: 24 baseline + contract suite + CJ/Shopify/ops additions)
- [ ] Mock adapter passes the shared contract suite (Task 3)
- [ ] CJ adapter fully fixture-tested incl. idempotent placeOrder pre-check and 1600100 normalization (Tasks 5–6); sandbox contract harness in place, env-gated
- [ ] Shopify client + 11 typed operations fixture-tested; `@idempotent` isolated in `withIdempotencyKey` (Tasks 7–9)
- [ ] Webhook receiver proves: verify → dedup insert → enqueue → ack, with replay demonstrating duplicate suppression (Tasks 11, 13)
- [ ] **Deferred to Robert's credentials (🟡 in `docs/OWNER-CHECKLIST.md`, NOT build blockers):** live `verify-live` Shopify + CJ sections; CJ sandbox contract run (`CJ_CONTRACT=1`); re-recording best-effort fixtures against real responses; Railway deploy for public webhook URL
