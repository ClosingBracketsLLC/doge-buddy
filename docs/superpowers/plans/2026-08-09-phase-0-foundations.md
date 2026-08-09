# Doge Buddy Phase 0 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the pnpm monorepo rails for Doge Buddy — core domain package, full Postgres schema with migrations, a running ops service (Fastify `/healthz` + pg-boss queue), CI, and the committed design docs — so every later phase has tested foundations to build on.

**Architecture:** pnpm workspace with two apps (`storefront` comes in Phase 2; `ops` starts now) and internal source-exported packages (no build step — apps run TS directly via `tsx`, packages export `./src/index.ts`). Postgres is the single datastore: Drizzle ORM for schema/migrations, pg-boss for queue+cron in the same database. Tests run against a Dockerized Postgres 17 on port 5433.

**Tech Stack:** Node 24 (installed: v24.18.0), pnpm 10 via corepack, TypeScript 5.9 strict, Drizzle ORM + drizzle-kit, pg-boss v10, Fastify v5, zod v4, Vitest, Docker (postgres:17-alpine).

## Global Constraints

- Node `>=22` (Hydrogen skeleton requires ^22||^24; dev machine has v24.18.0). Set `"engines": {"node": ">=22"}` in root package.json.
- Package manager: pnpm 10 via corepack (`corepack enable && corepack use pnpm@10`). pnpm is NOT preinstalled on this machine.
- TypeScript `strict: true`, `moduleResolution: "nodenext"`, `verbatimModuleSyntax: true` everywhere.
- All money columns are **integer cents** with `_cents` suffix. Never floats.
- Every table gets `created_at`/`updated_at` timestamptz with defaults; PKs are `uuid` `gen_random_uuid()` unless the design doc says otherwise.
- Package names are scoped `@doge-buddy/*` (`core`, `db`, `ops`).
- Internal packages export TypeScript source directly: `"exports": {".": "./src/index.ts"}` — no `tsc` emit anywhere in Phase 0; `typecheck` scripts run `tsc --noEmit`.
- Test DB: `postgres://doge:doge@localhost:5433/doge_buddy` (Docker, port 5433 to avoid the host's Postgres 16 on 5432). Tests that need a DB must read `DATABASE_URL` env with this as default.
- Commit after every task, on branch `feat/phase-0-foundations`. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Design source of truth: `/home/robert/.claude/plans/lets-build-an-ai-vectorized-river.md` (copied into repo by Task 2). Table/column shapes in Task 5 come from its "Data model" section — do not improvise different names.

---

### Task 1: Workspace scaffolding + test database

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json` (root), `tsconfig.base.json`, `.gitignore`, `compose.yaml`
- Modify: none

**Interfaces:**
- Consumes: nothing (first task)
- Produces: workspace layout `apps/*` + `packages/*`; root scripts `pnpm typecheck` / `pnpm test` (recursive); Docker service `db` reachable at `postgres://doge:doge@localhost:5433/doge_buddy`; `tsconfig.base.json` that every package's tsconfig extends.

- [ ] **Step 1: Create the working branch**

```bash
cd /home/robert/Desktop/code/closing-brackets/doge-buddy
git checkout -b feat/phase-0-foundations
```

- [ ] **Step 2: Activate pnpm via corepack**

```bash
corepack enable && corepack use pnpm@10
```

This creates a minimal `package.json` with the pinned `"packageManager"` field if none exists (one exists? no — repo has no package.json yet, corepack creates it; we overwrite next step but KEEP the exact `packageManager` value it pinned).

- [ ] **Step 3: Write root `package.json`** (preserve the `packageManager` value corepack pinned in Step 2)

```json
{
  "name": "doge-buddy",
  "private": true,
  "packageManager": "pnpm@10.x.y",
  "engines": { "node": ">=22" },
  "scripts": {
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "db:up": "docker compose up -d db --wait",
    "db:down": "docker compose down -v"
  }
}
```

- [ ] **Step 4: Write `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 5: Write `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["ES2023"],
    "strict": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true,
    "declaration": false,
    "noEmit": true
  }
}
```

- [ ] **Step 6: Write `.gitignore`**

```
node_modules/
dist/
.env
.env.*
!.env.example
*.log
.DS_Store
```

- [ ] **Step 7: Write `compose.yaml`** (test/dev database)

```yaml
services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: doge
      POSTGRES_PASSWORD: doge
      POSTGRES_DB: doge_buddy
    ports:
      - "5433:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U doge -d doge_buddy"]
      interval: 2s
      timeout: 3s
      retries: 15
```

- [ ] **Step 8: Verify the workspace installs and the DB comes up**

```bash
pnpm install
pnpm db:up
psql postgres://doge:doge@localhost:5433/doge_buddy -c "select 1"
```

Expected: `pnpm install` completes (empty workspace is fine); `select 1` returns one row.

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json .gitignore compose.yaml
git commit -m "chore: scaffold pnpm workspace, base tsconfig, test database

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Commit the design documents

**Files:**
- Create: `docs/superpowers/specs/2026-08-09-doge-buddy-design.md` (copy of `/home/robert/.claude/plans/lets-build-an-ai-vectorized-river.md`)
- Create: `docs/superpowers/specs/2026-08-09-doge-buddy-research-digest.md`, `docs/superpowers/specs/2026-08-09-doge-buddy-architecture.md`, `docs/superpowers/specs/2026-08-09-doge-buddy-risks.md` (copies of `digest.md`, `architecture.md`, `risks.md` from `/tmp/claude-1000/-home-robert-Desktop-code-closing-brackets-doge-buddy/d05c3c7b-98b8-4c95-9865-18d104c36bfb/scratchpad/`)

**Interfaces:**
- Consumes: the scratchpad files listed above (session-temporary — this task makes them durable; if the scratchpad is gone, the executor must say so rather than fabricate content).
- Produces: durable in-repo specs later phases cite.

- [ ] **Step 1: Copy the four documents**

```bash
mkdir -p docs/superpowers/specs
cp /home/robert/.claude/plans/lets-build-an-ai-vectorized-river.md docs/superpowers/specs/2026-08-09-doge-buddy-design.md
S=/tmp/claude-1000/-home-robert-Desktop-code-closing-brackets-doge-buddy/d05c3c7b-98b8-4c95-9865-18d104c36bfb/scratchpad
cp "$S/digest.md"       docs/superpowers/specs/2026-08-09-doge-buddy-research-digest.md
cp "$S/architecture.md" docs/superpowers/specs/2026-08-09-doge-buddy-architecture.md
cp "$S/risks.md"        docs/superpowers/specs/2026-08-09-doge-buddy-risks.md
```

- [ ] **Step 2: Verify all four files are non-empty**

```bash
wc -l docs/superpowers/specs/*.md
```

Expected: four files, each hundreds of lines (design ~180, digest ~250, architecture ~460, risks ~140).

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs
git commit -m "docs: commit Doge Buddy design, research digest, architecture, and risk review

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `packages/core` — Result type and money helpers

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/vitest.config.ts`, `packages/core/src/index.ts`, `packages/core/src/result.ts`, `packages/core/src/money.ts`
- Test: `packages/core/test/money.test.ts`, `packages/core/test/result.test.ts`

**Interfaces:**
- Consumes: Task 1's workspace + `tsconfig.base.json`.
- Produces (used by every later package):
  - `type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E }` with `ok<T>(value: T)`, `err<E>(error: E)`, `isOk(r)`, `isErr(r)` guards.
  - `formatCents(cents: number): string` → `"$12.34"` (throws `RangeError` on non-integer or negative-zero-safe; negative allowed → `"-$12.34"`).
  - `grossMarginBps(revenueCents: number, costCents: number): number` → basis points, e.g. revenue 2000, cost 800 → 6000; throws `RangeError` if `revenueCents <= 0` or either arg non-integer.
  - `assertCents(n: number, label?: string): void` — throws `RangeError` unless `Number.isSafeInteger(n)`.

- [ ] **Step 1: Write `packages/core/package.json`, `tsconfig.json`, `vitest.config.ts`**

```json
{
  "name": "@doge-buddy/core",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.9.2",
    "vitest": "^3.2.0"
  },
  "dependencies": {
    "zod": "^4.0.0"
  }
}
```

`packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`packages/core/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })
```

Then run `pnpm install` at repo root to link.

- [ ] **Step 2: Write the failing tests**

`packages/core/test/result.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { err, isErr, isOk, ok } from '@doge-buddy/core'

describe('Result', () => {
  it('ok wraps a value and narrows via isOk', () => {
    const r = ok(42)
    expect(isOk(r)).toBe(true)
    if (isOk(r)) expect(r.value).toBe(42)
  })
  it('err wraps an error and narrows via isErr', () => {
    const r = err(new Error('boom'))
    expect(isErr(r)).toBe(true)
    if (isErr(r)) expect(r.error.message).toBe('boom')
  })
})
```

`packages/core/test/money.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { assertCents, formatCents, grossMarginBps } from '@doge-buddy/core'

describe('formatCents', () => {
  it('formats integer cents as USD', () => {
    expect(formatCents(1234)).toBe('$12.34')
    expect(formatCents(0)).toBe('$0.00')
    expect(formatCents(5)).toBe('$0.05')
    expect(formatCents(-1234)).toBe('-$12.34')
  })
  it('rejects non-integers', () => {
    expect(() => formatCents(12.5)).toThrow(RangeError)
    expect(() => formatCents(Number.NaN)).toThrow(RangeError)
  })
})

describe('grossMarginBps', () => {
  it('computes margin in basis points', () => {
    expect(grossMarginBps(2000, 800)).toBe(6000) // 60.00%
    expect(grossMarginBps(1000, 1000)).toBe(0)
    expect(grossMarginBps(1000, 1500)).toBe(-5000)
  })
  it('rejects zero/negative revenue and non-integers', () => {
    expect(() => grossMarginBps(0, 100)).toThrow(RangeError)
    expect(() => grossMarginBps(100.5, 10)).toThrow(RangeError)
  })
})

describe('assertCents', () => {
  it('accepts safe integers, rejects everything else', () => {
    expect(() => assertCents(100)).not.toThrow()
    expect(() => assertCents(1.5)).toThrow(RangeError)
    expect(() => assertCents(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @doge-buddy/core test`
Expected: FAIL — cannot resolve imports (`formatCents` etc. not exported).

- [ ] **Step 4: Implement**

`packages/core/src/result.ts`:

```ts
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })
export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok
export const isErr = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok
```

`packages/core/src/money.ts`:

```ts
export function assertCents(n: number, label = 'amount'): void {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${label} must be integer cents, got ${n}`)
}

export function formatCents(cents: number): string {
  assertCents(cents)
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const dollars = Math.floor(abs / 100)
  const rem = (abs % 100).toString().padStart(2, '0')
  return `${sign}$${dollars}.${rem}`
}

export function grossMarginBps(revenueCents: number, costCents: number): number {
  assertCents(revenueCents, 'revenueCents')
  assertCents(costCents, 'costCents')
  if (revenueCents <= 0) throw new RangeError(`revenueCents must be > 0, got ${revenueCents}`)
  return Math.round(((revenueCents - costCents) / revenueCents) * 10_000)
}
```

`packages/core/src/index.ts`:

```ts
export * from './result.ts'
export * from './money.ts'
```

(`verbatimModuleSyntax` + nodenext: relative imports need explicit `.ts` extensions with `allowImportingTsExtensions`… which requires `noEmit` — already set in base config. If tsc still rejects `.ts` extensions, add `"allowImportingTsExtensions": true` to `tsconfig.base.json` compilerOptions.)

- [ ] **Step 5: Run tests + typecheck to verify pass**

Run: `pnpm --filter @doge-buddy/core test && pnpm --filter @doge-buddy/core typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core pnpm-lock.yaml
git commit -m "feat(core): Result type and integer-cents money helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `packages/core` — proposal payload zod schemas

**Files:**
- Create: `packages/core/src/proposals.ts`
- Modify: `packages/core/src/index.ts` (add `export * from './proposals.ts'`)
- Test: `packages/core/test/proposals.test.ts`

**Interfaces:**
- Consumes: zod v4 (dep added in Task 3), Task 3's index barrel.
- Produces (used by ops in Phase 4+ and by `packages/db` conceptually — payload column stays jsonb, validated at the edges):
  - `PROPOSAL_TYPES = ['new_listing', 'support_reply', 'refund', 'deprecate_product'] as const`; `type ProposalType`
  - `CATEGORY_TAGS = ['toys', 'walks', 'beds', 'grooming'] as const`; `type CategoryTag`
  - Zod schemas: `NewListingPayloadSchema`, `SupportReplyPayloadSchema`, `RefundPayloadSchema`, `DeprecateProductPayloadSchema`, and discriminated union `ProposalPayloadSchema` (discriminator field `type`).
  - Inferred types `NewListingPayload`, `SupportReplyPayload`, `RefundPayload`, `DeprecateProductPayload`, `ProposalPayload`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/proposals.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ProposalPayloadSchema, NewListingPayloadSchema, RefundPayloadSchema } from '@doge-buddy/core'

const validListing = {
  type: 'new_listing',
  title: 'Tug-O-War Rope Toy',
  descriptionHtml: '<p>Durable rope toy for medium dogs.</p>',
  categoryTag: 'toys',
  imageUrls: ['https://cdn.example.com/rope.jpg'],
  shipsFrom: 'US',
  deliveryMinDays: 3,
  deliveryMaxDays: 7,
  variants: [
    {
      sku: 'DB-ROPE-01',
      priceCents: 1999,
      compareAtCents: 2499,
      supplierCostCents: 620,
      supplier: 'cj',
      supplierProductId: 'pid123',
      supplierVariantId: 'vid456',
    },
  ],
} as const

describe('NewListingPayloadSchema', () => {
  it('accepts a complete listing draft', () => {
    expect(NewListingPayloadSchema.parse(validListing)).toMatchObject({ title: 'Tug-O-War Rope Toy' })
  })
  it('rejects empty variants, bad category, non-integer cents, min>max delivery', () => {
    expect(NewListingPayloadSchema.safeParse({ ...validListing, variants: [] }).success).toBe(false)
    expect(NewListingPayloadSchema.safeParse({ ...validListing, categoryTag: 'cats' }).success).toBe(false)
    expect(
      NewListingPayloadSchema.safeParse({
        ...validListing,
        variants: [{ ...validListing.variants[0], priceCents: 19.99 }],
      }).success,
    ).toBe(false)
    expect(
      NewListingPayloadSchema.safeParse({ ...validListing, deliveryMinDays: 9, deliveryMaxDays: 7 }).success,
    ).toBe(false)
  })
})

describe('RefundPayloadSchema', () => {
  const validRefund = {
    type: 'refund',
    orderId: '4b4e6ac8-3e37-4f6e-9e0a-0a4bbf9a4a11',
    shopifyOrderGid: 'gid://shopify/Order/123',
    amountCents: 1999,
    reason: 'Item arrived damaged',
    openCjDispute: true,
    cjDisputeReasonId: 'r42',
  }
  it('accepts a refund with a CJ dispute + reason id', () => {
    expect(RefundPayloadSchema.parse(validRefund).amountCents).toBe(1999)
  })
  it('requires cjDisputeReasonId when openCjDispute is true', () => {
    expect(RefundPayloadSchema.safeParse({ ...validRefund, cjDisputeReasonId: undefined }).success).toBe(false)
    expect(
      RefundPayloadSchema.safeParse({ ...validRefund, openCjDispute: false, cjDisputeReasonId: undefined }).success,
    ).toBe(true)
  })
})

describe('ProposalPayloadSchema union', () => {
  it('discriminates on type', () => {
    const parsed = ProposalPayloadSchema.parse(validListing)
    expect(parsed.type).toBe('new_listing')
    expect(ProposalPayloadSchema.safeParse({ type: 'bogus' }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @doge-buddy/core test`
Expected: FAIL — `ProposalPayloadSchema` not exported.

- [ ] **Step 3: Implement `packages/core/src/proposals.ts`**

```ts
import { z } from 'zod'

export const PROPOSAL_TYPES = ['new_listing', 'support_reply', 'refund', 'deprecate_product'] as const
export type ProposalType = (typeof PROPOSAL_TYPES)[number]

export const CATEGORY_TAGS = ['toys', 'walks', 'beds', 'grooming'] as const
export type CategoryTag = (typeof CATEGORY_TAGS)[number]

export const SUPPLIER_KEYS = ['cj', 'mock'] as const
export type SupplierKey = (typeof SUPPLIER_KEYS)[number]

const cents = z.number().int('must be integer cents')

const listingVariant = z.object({
  sku: z.string().min(1),
  priceCents: cents.positive(),
  compareAtCents: cents.positive().optional(),
  supplierCostCents: cents.positive(),
  supplier: z.enum(SUPPLIER_KEYS),
  supplierProductId: z.string().min(1),
  supplierVariantId: z.string().min(1),
})

export const NewListingPayloadSchema = z
  .object({
    type: z.literal('new_listing'),
    title: z.string().min(1).max(255),
    descriptionHtml: z.string().min(1),
    categoryTag: z.enum(CATEGORY_TAGS),
    imageUrls: z.array(z.url()).min(1),
    shipsFrom: z.literal('US'),
    deliveryMinDays: z.number().int().min(1),
    deliveryMaxDays: z.number().int().min(1),
    variants: z.array(listingVariant).min(1),
  })
  .refine((p) => p.deliveryMinDays <= p.deliveryMaxDays, {
    message: 'deliveryMinDays must be <= deliveryMaxDays',
    path: ['deliveryMinDays'],
  })
export type NewListingPayload = z.infer<typeof NewListingPayloadSchema>

export const SupportReplyPayloadSchema = z.object({
  type: z.literal('support_reply'),
  ticketId: z.uuid(),
  body: z.string().min(1),
})
export type SupportReplyPayload = z.infer<typeof SupportReplyPayloadSchema>

export const RefundPayloadSchema = z
  .object({
    type: z.literal('refund'),
    orderId: z.uuid(),
    shopifyOrderGid: z.string().startsWith('gid://shopify/Order/'),
    amountCents: cents.positive(),
    reason: z.string().min(1),
    openCjDispute: z.boolean(),
    cjDisputeReasonId: z.string().min(1).optional(),
  })
  .refine((p) => !p.openCjDispute || p.cjDisputeReasonId !== undefined, {
    message: 'cjDisputeReasonId is required when openCjDispute is true',
    path: ['cjDisputeReasonId'],
  })
export type RefundPayload = z.infer<typeof RefundPayloadSchema>

export const DeprecateProductPayloadSchema = z.object({
  type: z.literal('deprecate_product'),
  productId: z.uuid(),
  evidence: z.object({
    unitsSold28d: z.number().int().min(0),
    refundCount28d: z.number().int().min(0),
    ticketCount28d: z.number().int().min(0),
    daysLive: z.number().int().min(0),
    reasoning: z.string().optional(),
  }),
})
export type DeprecateProductPayload = z.infer<typeof DeprecateProductPayloadSchema>

// NOTE: z.discriminatedUnion cannot contain .refine()-wrapped members in zod v4 —
// use a plain union; the `type` literals still discriminate correctly on parse.
export const ProposalPayloadSchema = z.union([
  NewListingPayloadSchema,
  SupportReplyPayloadSchema,
  RefundPayloadSchema,
  DeprecateProductPayloadSchema,
])
export type ProposalPayload = z.infer<typeof ProposalPayloadSchema>
```

Add to `packages/core/src/index.ts`:

```ts
export * from './proposals.ts'
```

- [ ] **Step 4: Run tests + typecheck to verify pass**

Run: `pnpm --filter @doge-buddy/core test && pnpm --filter @doge-buddy/core typecheck`
Expected: PASS. (If `z.url()` / `z.uuid()` top-level helpers are unavailable in the installed zod v4 minor, use `z.string().url()` / `z.string().uuid()` — assert whichever compiles, behavior is identical.)

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): proposal payload schemas (new_listing, support_reply, refund, deprecate_product)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `packages/db` — full Drizzle schema + initial migration

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/vitest.config.ts`, `packages/db/drizzle.config.ts`, `packages/db/src/schema.ts`, `packages/db/src/client.ts`, `packages/db/src/index.ts`, `packages/db/migrations/` (generated)
- Test: `packages/db/test/migrations.test.ts`

**Interfaces:**
- Consumes: Task 1's Docker DB; design doc "Data model" section (authoritative for names).
- Produces:
  - Drizzle table objects for all 19 tables (exact export names: `products`, `productVariants`, `supplierVariantMappings`, `orders`, `supplierOrders`, `webhookEvents`, `supportTickets`, `supportMessages`, `gmailSyncState`, `proposals`, `productScores`, `sourcingSignals`, `agentRuns`, `agentRunEvents`, `auditLog`, `settings`, `cjAuth`, `adminSessions`, `agentSessions`).
  - `createDb(connectionString: string): { db: NodePgDatabase<typeof schema>; pool: pg.Pool }` from `client.ts`.
  - `runMigrations(connectionString: string): Promise<void>` — applies `packages/db/migrations` via drizzle's node-postgres migrator.
  - Scripts: `pnpm --filter @doge-buddy/db generate` (drizzle-kit generate), `pnpm --filter @doge-buddy/db migrate` (runs `runMigrations` against `DATABASE_URL`).

- [ ] **Step 1: Write `packages/db/package.json`, `tsconfig.json`, `vitest.config.ts`, `drizzle.config.ts`**

```json
{
  "name": "@doge-buddy/db",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "generate": "drizzle-kit generate",
    "migrate": "tsx scripts/migrate.ts"
  },
  "dependencies": {
    "drizzle-orm": "^0.44.0",
    "pg": "^8.16.0"
  },
  "devDependencies": {
    "@types/pg": "^8.15.0",
    "drizzle-kit": "^0.31.0",
    "tsx": "^4.20.0",
    "typescript": "^5.9.2",
    "vitest": "^3.2.0"
  }
}
```

`tsconfig.json` and `vitest.config.ts`: same shape as Task 3's (extends base; include `src`, `test`, `scripts`).

`packages/db/drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
})
```

- [ ] **Step 2: Write the failing migration test**

`packages/db/test/migrations.test.ts`:

```ts
import { Client } from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '@doge-buddy/db'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'
// Isolated database per run so the test always starts fresh.
const testDbName = `migration_test_${Date.now()}`
const adminUrl = url
const testUrl = url.replace(/\/[^/]+$/, `/${testDbName}`)

const EXPECTED_TABLES = [
  'products', 'product_variants', 'supplier_variant_mappings',
  'orders', 'supplier_orders', 'webhook_events',
  'support_tickets', 'support_messages', 'gmail_sync_state',
  'proposals', 'product_scores', 'sourcing_signals',
  'agent_runs', 'agent_run_events', 'audit_log',
  'settings', 'cj_auth', 'admin_sessions', 'agent_sessions',
].sort()

describe('migrations', () => {
  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl })
    await admin.connect()
    await admin.query(`CREATE DATABASE ${testDbName}`)
    await admin.end()
  })

  it('applies cleanly to a fresh database and creates all 19 tables', async () => {
    await runMigrations(testUrl)
    const c = new Client({ connectionString: testUrl })
    await c.connect()
    const res = await c.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       AND table_name NOT LIKE '\\_\\_drizzle%' ESCAPE '\\'
       ORDER BY table_name`,
    )
    await c.end()
    expect(res.rows.map((r) => r.table_name)).toEqual(EXPECTED_TABLES)
  })

  it('is idempotent (running twice is a no-op)', async () => {
    await expect(runMigrations(testUrl)).resolves.not.toThrow()
  })

  it('enforces the supplier_orders idempotency uniques', async () => {
    const c = new Client({ connectionString: testUrl })
    await c.connect()
    const { rows: orderRows } = await c.query(
      `INSERT INTO orders (shopify_order_gid, is_test, email) VALUES ('gid://shopify/Order/1', false, 'x@y.z') RETURNING id`,
    )
    const orderId = orderRows[0].id
    await c.query(
      `INSERT INTO supplier_orders (order_id, supplier, idempotency_key, status) VALUES ($1, 'cj', 'DB-1', 'pending')`,
      [orderId],
    )
    await expect(
      c.query(
        `INSERT INTO supplier_orders (order_id, supplier, idempotency_key, status) VALUES ($1, 'cj', 'DB-other', 'pending')`,
        [orderId],
      ),
    ).rejects.toThrow(/unique|duplicate/i)
    await c.end()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm db:up && pnpm --filter @doge-buddy/db test`
Expected: FAIL — `runMigrations` not exported / no migrations exist.

- [ ] **Step 4: Write `packages/db/src/schema.ts`** — complete, from the design doc's data model:

```ts
import { sql } from 'drizzle-orm'
import {
  bigint, bigserial, boolean, date, index, integer, jsonb, numeric,
  pgEnum, pgTable, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core'

const id = () => uuid('id').primaryKey().defaultRandom()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()

export const productStatus = pgEnum('product_status', ['draft', 'active', 'deprecated'])
export const supplierKey = pgEnum('supplier_key', ['cj', 'mock'])
export const supplierOrderStatus = pgEnum('supplier_order_status', [
  'pending', 'created', 'confirmed', 'paid', 'shipped', 'delivered', 'cancelled', 'failed', 'needs_attention',
])
export const webhookSource = pgEnum('webhook_source', ['shopify', 'cj'])
export const ticketStatus = pgEnum('ticket_status', [
  'new', 'triaged', 'awaiting_approval', 'waiting_on_customer', 'resolved', 'escalated',
])
export const messageDirection = pgEnum('message_direction', ['inbound', 'outbound'])
export const proposalType = pgEnum('proposal_type', ['new_listing', 'support_reply', 'refund', 'deprecate_product'])
export const proposalStatus = pgEnum('proposal_status', [
  'pending', 'approved', 'rejected', 'expired', 'applying', 'applied', 'failed',
])
export const scoreVerdict = pgEnum('score_verdict', ['keep', 'watch', 'deprecate'])
export const agentRunStatus = pgEnum('agent_run_status', ['running', 'succeeded', 'failed', 'aborted'])
export const signalSource = pgEnum('signal_source', ['cj_trending', 'web_search', 'google_trends', 'owner_manual'])

// -- Catalog --
export const products = pgTable('products', {
  id: id(),
  shopifyProductGid: text('shopify_product_gid').unique(),
  handle: text('handle'),
  title: text('title'),
  status: productStatus('status').notNull().default('draft'),
  categoryTag: text('category_tag'),
  createdFromProposalId: uuid('created_from_proposal_id'),
  deprecatedAt: timestamp('deprecated_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const productVariants = pgTable('product_variants', {
  id: id(),
  productId: uuid('product_id').notNull().references(() => products.id),
  shopifyVariantGid: text('shopify_variant_gid').unique(),
  shopifyInventoryItemGid: text('shopify_inventory_item_gid'),
  sku: text('sku').notNull().unique(),
  priceCents: integer('price_cents').notNull(),
  compareAtCents: integer('compare_at_cents'),
  supplierCostCents: integer('supplier_cost_cents'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const supplierVariantMappings = pgTable('supplier_variant_mappings', {
  id: id(),
  variantId: uuid('variant_id').notNull().references(() => productVariants.id),
  supplier: supplierKey('supplier').notNull(),
  supplierProductId: text('supplier_product_id').notNull(),
  supplierVariantId: text('supplier_variant_id').notNull(),
  warehouseCountry: text('warehouse_country').notNull().default('US'),
  lastKnownStock: integer('last_known_stock'),
  stockCheckedAt: timestamp('stock_checked_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('svm_variant_supplier_uq').on(t.variantId, t.supplier)])

// -- Orders & fulfillment --
export const orders = pgTable('orders', {
  id: id(),
  shopifyOrderGid: text('shopify_order_gid').notNull().unique(),
  shopifyOrderNumber: text('shopify_order_number'),
  email: text('email'),
  customerName: text('customer_name'),
  isTest: boolean('is_test').notNull(),
  financialStatus: text('financial_status'),
  fulfillmentStatus: text('fulfillment_status'),
  totalCents: integer('total_cents'),
  shippingAddress: jsonb('shipping_address'),
  rawPayload: jsonb('raw_payload'),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const supplierOrders = pgTable('supplier_orders', {
  id: id(),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  supplier: supplierKey('supplier').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  status: supplierOrderStatus('status').notNull().default('pending'),
  supplierOrderId: text('supplier_order_id'),
  shipmentOrderId: text('shipment_order_id'),
  logisticName: text('logistic_name'),
  productAmountCents: integer('product_amount_cents'),
  postageAmountCents: integer('postage_amount_cents'),
  totalAmountCents: integer('total_amount_cents'),
  trackingNumber: text('tracking_number'),
  trackingSyncedToShopifyAt: timestamp('tracking_synced_to_shopify_at', { withTimezone: true }),
  shopifyFulfillmentGid: text('shopify_fulfillment_gid'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('supplier_orders_order_supplier_uq').on(t.orderId, t.supplier)])

export const webhookEvents = pgTable('webhook_events', {
  id: id(),
  source: webhookSource('source').notNull(),
  externalEventId: text('external_event_id').notNull(),
  topic: text('topic'),
  payload: jsonb('payload'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('webhook_events_source_event_uq').on(t.source, t.externalEventId)])

// -- Support --
export const supportTickets = pgTable('support_tickets', {
  id: id(),
  gmailThreadId: text('gmail_thread_id').notNull().unique(),
  customerEmail: text('customer_email'),
  subject: text('subject'),
  status: ticketStatus('status').notNull().default('new'),
  category: text('category'),
  orderId: uuid('order_id').references(() => orders.id),
  agentSessionId: text('agent_session_id'),
  lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const supportMessages = pgTable('support_messages', {
  id: id(),
  ticketId: uuid('ticket_id').notNull().references(() => supportTickets.id),
  gmailMessageId: text('gmail_message_id').notNull().unique(),
  direction: messageDirection('direction').notNull(),
  fromEmail: text('from_email'),
  bodyText: text('body_text'),
  rfcMessageId: text('rfc_message_id'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const gmailSyncState = pgTable('gmail_sync_state', {
  id: integer('id').primaryKey().default(1),
  lastHistoryId: bigint('last_history_id', { mode: 'bigint' }),
  updatedAt: updatedAt(),
})

// -- Approval gate --
export const proposals = pgTable('proposals', {
  id: id(),
  type: proposalType('type').notNull(),
  status: proposalStatus('status').notNull().default('pending'),
  summary: text('summary').notNull(),
  payload: jsonb('payload').notNull(),
  sourceWorkflow: text('source_workflow').notNull(),
  agentRunId: uuid('agent_run_id'),
  ticketId: uuid('ticket_id'),
  productId: uuid('product_id'),
  orderId: uuid('order_id'),
  autoApproved: boolean('auto_approved').notNull().default(false),
  decidedBy: text('decided_by'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  applyError: text('apply_error'),
  actionTokenHash: text('action_token_hash'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull().default(sql`now() + interval '7 days'`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('proposals_status_idx').on(t.status)])

// -- Scoring & signals --
export const productScores = pgTable('product_scores', {
  id: id(),
  productId: uuid('product_id').notNull().references(() => products.id),
  scoreDate: date('score_date').notNull(),
  unitsSold7d: integer('units_sold_7d').notNull().default(0),
  unitsSold28d: integer('units_sold_28d').notNull().default(0),
  revenue28dCents: integer('revenue_28d_cents').notNull().default(0),
  refundCount28d: integer('refund_count_28d').notNull().default(0),
  ticketCount28d: integer('ticket_count_28d').notNull().default(0),
  daysLive: integer('days_live').notNull().default(0),
  score: numeric('score'),
  verdict: scoreVerdict('verdict'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('product_scores_product_date_uq').on(t.productId, t.scoreDate)])

export const sourcingSignals = pgTable('sourcing_signals', {
  id: id(),
  source: signalSource('source').notNull(),
  keyword: text('keyword'),
  supplierProductId: text('supplier_product_id'),
  score: numeric('score'),
  evidenceUrl: text('evidence_url'),
  snapshot: jsonb('snapshot'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

// -- Agents, audit, config --
export const agentRuns = pgTable('agent_runs', {
  id: id(),
  workflow: text('workflow').notNull(),
  triggerRef: text('trigger_ref'),
  model: text('model'),
  sessionId: text('session_id'),
  status: agentRunStatus('status').notNull().default('running'),
  totalCostUsd: numeric('total_cost_usd'),
  modelUsage: jsonb('model_usage'),
  numTurns: integer('num_turns'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const agentRunEvents = pgTable('agent_run_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  runId: uuid('run_id').notNull().references(() => agentRuns.id),
  seq: integer('seq').notNull(),
  message: jsonb('message').notNull(),
  createdAt: createdAt(),
})

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  detail: jsonb('detail'),
  createdAt: createdAt(),
}, (t) => [index('audit_log_action_idx').on(t.action), index('audit_log_entity_idx').on(t.entityType, t.entityId)])

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
})

export const cjAuth = pgTable('cj_auth', {
  id: integer('id').primaryKey().default(1),
  accessToken: text('access_token'),
  accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }),
  refreshToken: text('refresh_token'),
  refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }),
  updatedAt: updatedAt(),
})

export const adminSessions = pgTable('admin_sessions', {
  id: id(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
})

export const agentSessions = pgTable('agent_sessions', {
  sessionId: text('session_id').primaryKey(),
  workflow: text('workflow'),
  transcript: jsonb('transcript'),
  updatedAt: updatedAt(),
})
```

- [ ] **Step 5: Write `client.ts`, `index.ts`, `scripts/migrate.ts`**

`packages/db/src/client.ts`:

```ts
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { fileURLToPath } from 'node:url'
import * as schema from './schema.ts'

export function createDb(connectionString: string): { db: NodePgDatabase<typeof schema>; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString })
  return { db: drizzle(pool, { schema }), pool }
}

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url))

export async function runMigrations(connectionString: string): Promise<void> {
  const { db, pool } = createDb(connectionString)
  try {
    await migrate(db, { migrationsFolder })
  } finally {
    await pool.end()
  }
}
```

`packages/db/src/index.ts`:

```ts
export * from './schema.ts'
export * from './client.ts'
```

`packages/db/scripts/migrate.ts`:

```ts
import { runMigrations } from '../src/index.ts'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}
await runMigrations(url)
console.log('migrations applied')
```

- [ ] **Step 6: Generate the initial migration**

```bash
pnpm install
pnpm --filter @doge-buddy/db generate
```

Expected: one new SQL file in `packages/db/migrations/` creating all 19 tables + enums. Read the generated SQL and sanity-check: 19 `CREATE TABLE`, the three critical uniques (`supplier_orders.idempotency_key`, `(order_id, supplier)`, `webhook_events (source, external_event_id)`).

- [ ] **Step 7: Run the migration test to verify pass**

Run: `pnpm --filter @doge-buddy/db test && pnpm --filter @doge-buddy/db typecheck`
Expected: all 3 tests PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/db pnpm-lock.yaml
git commit -m "feat(db): full Drizzle schema (19 tables) with initial migration and migration runner

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: `apps/ops` — config + Fastify server with `/healthz`

**Files:**
- Create: `apps/ops/package.json`, `apps/ops/tsconfig.json`, `apps/ops/vitest.config.ts`, `apps/ops/src/config.ts`, `apps/ops/src/server.ts`, `apps/ops/src/index.ts`, `apps/ops/.env.example`
- Test: `apps/ops/test/config.test.ts`, `apps/ops/test/healthz.test.ts`

**Interfaces:**
- Consumes: `createDb` from `@doge-buddy/db`.
- Produces:
  - `loadConfig(env: NodeJS.ProcessEnv): Config` — zod-validated `{ databaseUrl: string; port: number; host: string }` (`DATABASE_URL` required; `PORT` default 3001; `HOST` default `0.0.0.0`). Throws with a readable message listing missing vars.
  - `buildServer(deps: { pool: pg.Pool; isQueueReady: () => boolean }): FastifyInstance` — registers `GET /healthz` returning `200 {status:'ok', db:'ok', queue:'ok'|'stopped', uptimeSeconds}` (db checked via `SELECT 1`; 503 with `db:'error'` if the query fails).
  - `apps/ops/src/index.ts` — entrypoint used by `pnpm --filter @doge-buddy/ops start` (wired fully in Task 7).

- [ ] **Step 1: Write `apps/ops/package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`**

```json
{
  "name": "@doge-buddy/ops",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts"
  },
  "dependencies": {
    "@doge-buddy/core": "workspace:*",
    "@doge-buddy/db": "workspace:*",
    "fastify": "^5.4.0",
    "pg": "^8.16.0",
    "pg-boss": "^10.3.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/pg": "^8.15.0",
    "tsx": "^4.20.0",
    "typescript": "^5.9.2",
    "vitest": "^3.2.0"
  }
}
```

`tsconfig.json` / `vitest.config.ts`: same shape as Task 3's (extends base; include `src`, `test`).

`.env.example`:

```
DATABASE_URL=postgres://doge:doge@localhost:5433/doge_buddy
PORT=3001
```

- [ ] **Step 2: Write the failing tests**

`apps/ops/test/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

describe('loadConfig', () => {
  it('parses a valid environment with defaults', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d' })
    expect(c).toEqual({ databaseUrl: 'postgres://u:p@h:5432/d', port: 3001, host: '0.0.0.0' })
  })
  it('honors PORT override', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d', PORT: '8080' }).port).toBe(8080)
  })
  it('throws a readable error when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/)
  })
})
```

`apps/ops/test/healthz.test.ts`:

```ts
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { buildServer } from '../src/server.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

describe('GET /healthz', () => {
  const pool = new pg.Pool({ connectionString: url })
  afterAll(() => pool.end())

  it('returns 200 with db ok and queue status', async () => {
    const app = buildServer({ pool, isQueueReady: () => true })
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ok')
    expect(body.db).toBe('ok')
    expect(body.queue).toBe('ok')
    expect(typeof body.uptimeSeconds).toBe('number')
    await app.close()
  })

  it('returns 503 when the db is unreachable', async () => {
    const badPool = new pg.Pool({ connectionString: 'postgres://doge:doge@localhost:1/nope', connectionTimeoutMillis: 300 })
    const app = buildServer({ pool: badPool, isQueueReady: () => true })
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(503)
    expect(res.json().db).toBe('error')
    await app.close()
    await badPool.end()
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm install && pnpm --filter @doge-buddy/ops test`
Expected: FAIL — modules `../src/config.ts` / `../src/server.ts` don't exist.

- [ ] **Step 4: Implement**

`apps/ops/src/config.ts`:

```ts
import { z } from 'zod'

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
})

export interface Config {
  databaseUrl: string
  port: number
  host: string
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid environment: ${missing}`)
  }
  return { databaseUrl: parsed.data.DATABASE_URL, port: parsed.data.PORT, host: parsed.data.HOST }
}
```

`apps/ops/src/server.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify'
import type pg from 'pg'

export interface ServerDeps {
  pool: pg.Pool
  isQueueReady: () => boolean
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: true })
  const startedAt = Date.now()

  app.get('/healthz', async (_req, reply) => {
    let db: 'ok' | 'error' = 'ok'
    try {
      await deps.pool.query('SELECT 1')
    } catch {
      db = 'error'
    }
    const queue = deps.isQueueReady() ? 'ok' : 'stopped'
    const body = {
      status: db === 'ok' ? 'ok' : 'degraded',
      db,
      queue,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    }
    return reply.code(db === 'ok' ? 200 : 503).send(body)
  })

  return app
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter @doge-buddy/ops test && pnpm --filter @doge-buddy/ops typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/ops pnpm-lock.yaml
git commit -m "feat(ops): env config loader and Fastify /healthz endpoint

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: `apps/ops` — pg-boss queue wiring + `demo.ping` job + entrypoint

**Files:**
- Create: `apps/ops/src/queue.ts`, `apps/ops/src/jobs/demo-ping.ts`
- Modify: `apps/ops/src/index.ts` (create it now — full entrypoint)
- Test: `apps/ops/test/queue.test.ts`

**Interfaces:**
- Consumes: Task 6's `loadConfig`/`buildServer`; `@doge-buddy/db` `createDb`.
- Produces:
  - `startQueue(connectionString: string): Promise<Queue>` where `Queue = { boss: PgBoss; ready: () => boolean; stop: () => Promise<void> }`. Registers queue `demo.ping` and its worker.
  - `demoPingHandler(db: NodePgDatabase<typeof schema>): (jobs: PgBoss.Job<{ note: string }>[]) => Promise<void>` — inserts one `audit_log` row per job: `actor: 'system'`, `action: 'demo.ping'`, `detail: { note }`. (First real row in the audit trail; later phases follow this pattern.)
  - Entrypoint `src/index.ts`: loadConfig → createDb → startQueue → buildServer → listen; graceful shutdown on SIGINT/SIGTERM (server close → boss stop → pool end).

- [ ] **Step 1: Write the failing test**

`apps/ops/test/queue.test.ts`:

```ts
import { createDb, auditLog } from '@doge-buddy/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startQueue, type Queue } from '../src/queue.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

describe('queue', () => {
  let q: Queue
  const { db, pool } = createDb(url)

  beforeAll(async () => {
    q = await startQueue(url)
  })
  afterAll(async () => {
    await q.stop()
    await pool.end()
  })

  it('reports ready after start', () => {
    expect(q.ready()).toBe(true)
  })

  it('processes a demo.ping job into audit_log', async () => {
    const note = `test-${Date.now()}`
    await q.boss.send('demo.ping', { note })
    // poll audit_log up to 10s for the worker to process
    let rows: (typeof auditLog.$inferSelect)[] = []
    for (let i = 0; i < 50 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 200))
      rows = await db.select().from(auditLog).where(eq(auditLog.action, 'demo.ping'))
      rows = rows.filter((r) => (r.detail as { note?: string })?.note === note)
    }
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actor).toBe('system')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @doge-buddy/ops test`
Expected: FAIL — `../src/queue.ts` doesn't exist. (Migrations must have been applied to the dev DB first: `DATABASE_URL=postgres://doge:doge@localhost:5433/doge_buddy pnpm --filter @doge-buddy/db migrate`.)

- [ ] **Step 3: Implement**

`apps/ops/src/jobs/demo-ping.ts`:

```ts
import { auditLog, type createDb } from '@doge-buddy/db'
import type PgBoss from 'pg-boss'

type Db = ReturnType<typeof createDb>['db']

export function demoPingHandler(db: Db) {
  return async (jobs: PgBoss.Job<{ note: string }>[]): Promise<void> => {
    for (const job of jobs) {
      await db.insert(auditLog).values({
        actor: 'system',
        action: 'demo.ping',
        detail: { note: job.data.note },
      })
    }
  }
}
```

`apps/ops/src/queue.ts`:

```ts
import { createDb } from '@doge-buddy/db'
import PgBoss from 'pg-boss'
import { demoPingHandler } from './jobs/demo-ping.ts'

export interface Queue {
  boss: PgBoss
  ready: () => boolean
  stop: () => Promise<void>
}

export async function startQueue(connectionString: string): Promise<Queue> {
  const boss = new PgBoss(connectionString)
  const { db, pool } = createDb(connectionString)
  let running = false

  boss.on('error', (e) => console.error('[pg-boss]', e))
  await boss.start()
  running = true

  await boss.createQueue('demo.ping')
  await boss.work('demo.ping', demoPingHandler(db))

  return {
    boss,
    ready: () => running,
    stop: async () => {
      running = false
      await boss.stop({ graceful: true, wait: true })
      await pool.end()
    },
  }
}
```

`apps/ops/src/index.ts`:

```ts
import { createDb } from '@doge-buddy/db'
import { loadConfig } from './config.ts'
import { startQueue } from './queue.ts'
import { buildServer } from './server.ts'

const config = loadConfig(process.env)
const { pool } = createDb(config.databaseUrl)
const queue = await startQueue(config.databaseUrl)
const app = buildServer({ pool, isQueueReady: queue.ready })

await app.listen({ port: config.port, host: config.host })
app.log.info(`ops listening on :${config.port}`)

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  app.log.info(`${signal} received, shutting down`)
  await app.close()
  await queue.stop()
  await pool.end()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
```

- [ ] **Step 4: Run tests to verify pass**

Run: `DATABASE_URL=postgres://doge:doge@localhost:5433/doge_buddy pnpm --filter @doge-buddy/db migrate && pnpm --filter @doge-buddy/ops test && pnpm --filter @doge-buddy/ops typecheck`
Expected: PASS (pg-boss creates its own `pgboss` schema on first start).

- [ ] **Step 5: Smoke-run the entrypoint**

```bash
DATABASE_URL=postgres://doge:doge@localhost:5433/doge_buddy PORT=3001 timeout 8 pnpm --filter @doge-buddy/ops start &
sleep 5 && curl -s localhost:3001/healthz
```

Expected: `{"status":"ok","db":"ok","queue":"ok","uptimeSeconds":...}`; process exits cleanly when `timeout` sends SIGTERM.

- [ ] **Step 6: Commit**

```bash
git add apps/ops
git commit -m "feat(ops): pg-boss queue with demo.ping job, entrypoint with graceful shutdown

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: CI workflow + migration drift check

**Files:**
- Create: `.github/workflows/ci.yml`, `scripts/check-migration-drift.sh`

**Interfaces:**
- Consumes: all previous tasks' `typecheck`/`test` scripts; `packages/db` `generate` script.
- Produces: GitHub Actions CI running typecheck + tests (with a Postgres service) + drift check on every push/PR. Root script `pnpm db:check`.

- [ ] **Step 1: Write `scripts/check-migration-drift.sh`**

```bash
#!/usr/bin/env bash
# Fails if the Drizzle schema has changes not captured in a committed migration.
set -euo pipefail
pnpm --filter @doge-buddy/db generate
if [ -n "$(git status --porcelain packages/db/migrations)" ]; then
  echo "ERROR: schema drift — 'drizzle-kit generate' produced uncommitted migration changes:" >&2
  git status --porcelain packages/db/migrations >&2
  git checkout -- packages/db/migrations 2>/dev/null || true
  git clean -fd packages/db/migrations >/dev/null 2>&1 || true
  exit 1
fi
echo "migrations in sync with schema"
```

Then: `chmod +x scripts/check-migration-drift.sh` and add to root package.json scripts: `"db:check": "bash scripts/check-migration-drift.sh"`.

- [ ] **Step 2: Verify the drift check passes now and fails on drift**

```bash
pnpm db:check   # expect: "migrations in sync with schema"
```

Then temporarily add a column to `packages/db/src/schema.ts` (e.g. `tmp: text('tmp')` on `settings`), run `pnpm db:check` again — expect exit 1 with the drift message — then revert the schema edit and confirm `pnpm db:check` passes again.

- [ ] **Step 3: Write `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  ci:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17-alpine
        env:
          POSTGRES_USER: doge
          POSTGRES_PASSWORD: doge
          POSTGRES_DB: doge_buddy
        ports: ["5433:5432"]
        options: >-
          --health-cmd "pg_isready -U doge -d doge_buddy"
          --health-interval 2s --health-timeout 3s --health-retries 15
    env:
      DATABASE_URL: postgres://doge:doge@localhost:5433/doge_buddy
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm --filter @doge-buddy/db migrate
      - run: pnpm test
      - run: pnpm db:check
```

- [ ] **Step 4: Run the full local equivalent of CI**

```bash
pnpm install --frozen-lockfile && pnpm typecheck && DATABASE_URL=postgres://doge:doge@localhost:5433/doge_buddy pnpm --filter @doge-buddy/db migrate && DATABASE_URL=postgres://doge:doge@localhost:5433/doge_buddy pnpm test && pnpm db:check
```

Expected: everything green.

- [ ] **Step 5: Commit**

```bash
git add .github scripts package.json
git commit -m "ci: typecheck + tests with Postgres service + migration drift check

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: README + Railway deployment runbook (manual steps for Robert)

**Files:**
- Create: `docs/deploy-railway.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: documentation only. Deploying requires Robert's Railway account — this task documents the exact steps; actual deploy is deferred to Robert (open item in the design doc).

- [ ] **Step 1: Write `docs/deploy-railway.md`**

````markdown
# Deploying `apps/ops` to Railway

Requires: Robert's Railway account. One project, two services (ops + Postgres).

1. Create a Railway project `doge-buddy`.
2. Add a **PostgreSQL** database service. Copy its `DATABASE_URL` (private network URL preferred).
3. Add a service from this GitHub repo:
   - Root directory: `/` (monorepo — build from root so workspace deps resolve)
   - Build command: `corepack enable && pnpm install --frozen-lockfile`
   - Pre-deploy command: `pnpm --filter @doge-buddy/db migrate`
   - Start command: `pnpm --filter @doge-buddy/ops start`
   - Watch paths: `apps/ops/**`, `packages/**`
4. Service variables: `DATABASE_URL` (reference the Postgres service), `PORT=3001`.
   Set a healthcheck path of `/healthz` in service settings.
5. Deploy. Verify:
   - `curl https://<service-url>/healthz` → `{"status":"ok","db":"ok","queue":"ok",...}`
   - Send a demo job from a Railway shell:
     `pnpm --filter @doge-buddy/ops exec tsx -e "import PgBoss from 'pg-boss'; const b=new PgBoss(process.env.DATABASE_URL); await b.start(); await b.send('demo.ping',{note:'deploy-check'}); await b.stop();"`
   - Confirm the row: `SELECT * FROM audit_log WHERE action='demo.ping' ORDER BY created_at DESC LIMIT 1;`
6. Phase-0 exit criterion (design doc): the demo job executes on the deployed instance.
````

- [ ] **Step 2: Update `README.md`**

```markdown
# Doge Buddy

AI-managed dog supply dropshipping store. Hydrogen storefront + an autonomous
ops service (sourcing, fulfillment, support, scoring agents).

Design docs: `docs/superpowers/specs/`. Current phase: 0 (foundations).

## Development

Requires Node >= 22, Docker.

```bash
corepack enable
pnpm install
pnpm db:up                                  # Postgres 17 on :5433
DATABASE_URL=postgres://doge:doge@localhost:5433/doge_buddy pnpm --filter @doge-buddy/db migrate
pnpm test
pnpm --filter @doge-buddy/ops dev           # ops on :3001 (needs DATABASE_URL)
```

Layout: `apps/ops` (Fastify + pg-boss + agents) · `apps/storefront` (Hydrogen, Phase 2) ·
`packages/core|db|supplier|shopify-admin|gmail`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/deploy-railway.md
git commit -m "docs: README dev guide and Railway deployment runbook

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Phase 0 exit checklist

- [ ] `pnpm typecheck` and `pnpm test` green locally (all packages)
- [ ] Fresh-database migration applies all 19 tables (proven by `packages/db/test/migrations.test.ts`)
- [ ] `demo.ping` job processed into `audit_log` (proven by `apps/ops/test/queue.test.ts`)
- [ ] `/healthz` returns db+queue ok (proven by test + smoke run)
- [ ] CI workflow committed (runs on first push to GitHub)
- [ ] Design docs in `docs/superpowers/specs/`
- [ ] Railway deploy: **deferred to Robert** (runbook in `docs/deploy-railway.md`) — the "demo job runs on deployed instance" verification completes when he provisions the project
