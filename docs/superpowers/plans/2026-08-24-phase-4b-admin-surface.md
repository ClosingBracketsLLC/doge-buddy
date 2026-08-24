# Phase 4 Plan B — Admin Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner-facing admin surface: magic-link login over `admin_sessions`, the dashboard health strip, proposals queue/detail with session-authed Approve/Reject/Edit-then-approve, the orders view whose recovery buttons retire the runbook's raw SQL, the typed settings editor with the manual-signal paste box, and empty-state tickets/runs pages.

**Architecture:** One new `src/http/admin/` module: `html.ts` (auto-escaping tagged template + layout), `auth.ts` (domain-separated login/session tokens, cookie handling, rate-capped link sends via the existing `notifyOwner`), `routes.ts` (a Fastify plugin: public login routes + a nested authed scope holding every page and action). All rendering is typed template-literal functions — no template engine, no SPA, no new dependencies (cookies are parsed/serialized by hand; form bodies via `URLSearchParams`). Reuses Plan A verbatim: `applyProposalTransition`/`StaleProposalStatusError`, `enqueueProposalApply`, `hashActionToken`-style domain hashing, the audit conventions, and `FULFILLMENT_RETRY_OPTS` for the orders re-send. **Zero migrations.**

**Tech Stack:** TypeScript (ESM `.ts` imports), Fastify 5, drizzle-orm, zod v4, vitest vs real Postgres. No new packages.

**Spec:** `docs/superpowers/specs/2026-08-23-phase-4-proposals-design.md` §§4-5 + the Decisions table rows for admin decision route, login/session rows, login consume, expiry (admin-load lazy flips), audit actors (read first). Plan A (`2026-08-23-phase-4a-proposal-pipeline.md`) is merged; its modules are consumable facts.

## Global Constraints

- Branch: `feat/phase-4b-admin-surface`. Commit per task, conventional commits. TDD (RED evidence before implementation).
- **Form bodies are real here** (unlike Plan A's `/a/` routes): the admin plugin registers a scoped `application/x-www-form-urlencoded` parser that ACTUALLY parses — `Object.fromEntries(new URLSearchParams(body.toString()))` — because login/settings/edit forms carry fields. (Plan A's 415 lesson: browsers always send this content type.)
- Token domains, exactly: login rows store `sha256hex('login:' + token)` with **15-minute** expiry; session rows `sha256hex('session:' + token)` with **30-day** expiry; both in `admin_sessions`; the two lookups are disjoint by construction; expired rows are deleted opportunistically on any auth check. Never hash a bare token.
- Cookie: name `db_admin`, opaque session token value, `HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=2592000`. Parsed/serialized by hand — no @fastify/cookie.
- Login link sends are capped at **5 successful sends per hour**, counted via `audit_log` rows `action='admin.login_link_sent'` written only when `notifyOwner` returned true (the webhook-capture counting idiom). Failed sends never count.
- Unauthed requests to any authed `/admin` route → **303 redirect to `/admin/login`** (no state oracle about which routes exist).
- Session-authed decision route mirrors `/a/`'s guarded UPDATE minus the token check, **also nulls `action_token_hash`**, audits actor `'owner'` `detail.via='admin'`. Edit-then-approve re-validates the patched payload through the type's zod schema before the same guarded UPDATE (patch lands in the UPDATE itself).
- Lazy expiry on authed admin page loads: proposals list/detail flip `pending`-past-expiry rows to `expired` (audit actor `'system'`, `detail.via='admin-load'`) — GETs under auth may write; public GETs still never do.
- Orders recovery re-send, exactly: `enqueue('fulfillment.place-order', { orderGid }, { singletonKey: orderGid, ...FULFILLMENT_RETRY_OPTS })` — the `webhook-process.ts:167` shape; `FULFILLMENT_RETRY_OPTS` imported from `fulfillment/run-place-order.ts`. Recovery uses `fulfillment/transitions.ts`'s `applyTransition` (legal from `needs_attention`: pending/confirmed/cancelled only — reject anything else at the route).
- Every interpolated value in HTML flows through the auto-escaping `html` template; `raw()` is the only opt-out and only for fragments built by our own `html`. `audit_log.detail` and proposal payloads are attacker-influenced bytes.
- Audit actors: `'owner'` for every admin-triggered mutation (decisions, settings writes, signal pastes, order recoveries — action names: `proposal.approve|reject`, `setting.updated`, `signal.pasted`, `supplier_order.recovered`); `'system'` for machine flips.
- Settings editor derives input type at runtime from `SETTINGS_DEFAULTS`: `typeof default === 'boolean'` → checkbox; key ends with `.mode` → `<select>` manual/auto; else number field. Writes go through `settings.set` (one audit row per changed key, `detail: {key, from, to}`).
- The admin plugin registers only when `config.adminBaseUrl` is set (same gate as `actions`), and its deps thread through `buildServer` exactly like `actions` does.
- Tests: vitest + real Postgres + `app.inject`, one file per unit in `apps/ops/test/`, `createCaptureNotifier()` for login links, rerun-safe (unique ids; delete your own audit rows where a shared hourly cap could be affected — the login-cap idiom from `webhooks.test.ts`).
- No new dependencies. Integer cents. No real network in tests.

---

### Task 1: HTML helpers — auto-escaping tagged template + layout

**Files:**
- Create: `apps/ops/src/http/admin/html.ts`
- Test: `apps/ops/test/admin-html.test.ts`

**Interfaces:**
- Produces (every later task consumes):
  ```ts
  export class RawHtml { constructor(readonly value: string) {} }
  export function raw(value: string): RawHtml
  export function esc(input: unknown): string  // String(input) then & < > " ' entity-escaped, in that order
  /** Tagged template: every interpolation is esc()'d unless it is RawHtml (inserted verbatim)
   *  or an array (members joined with '', each escaped-or-raw by the same rule). */
  export function html(strings: TemplateStringsArray, ...values: unknown[]): RawHtml
  export function layout(title: string, body: RawHtml): string
  //   full document: <!doctype html>… <title>${esc(title)}</title> … nav bar linking
  //   /admin, /admin/proposals, /admin/orders, /admin/tickets, /admin/runs, /admin/settings … ${body}
  ```

- [ ] **Step 1: Write the failing tests** — `apps/ops/test/admin-html.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { esc, html, layout, raw } from '../src/http/admin/html.ts'

describe('admin html helpers', () => {
  it('esc escapes & < > " \' and stringifies non-strings', () => {
    expect(esc(`<a href="x">&'b`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;b')
    expect(esc(42)).toBe('42')
    expect(esc(null)).toBe('null')
  })

  it('html escapes every interpolation by default', () => {
    const out = html`<p>${'<script>alert(1)</script>'}</p>`
    expect(out.value).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
  })

  it('raw() passes through verbatim; nested html`` results are raw', () => {
    const inner = html`<b>${'x & y'}</b>`
    const out = html`<div>${inner}${raw('<hr>')}</div>`
    expect(out.value).toBe('<div><b>x &amp; y</b><hr></div>')
  })

  it('arrays are joined with each member escaped-or-raw by the same rule', () => {
    const out = html`<ul>${['<li>a', raw('<li>b')]}</ul>`
    expect(out.value).toBe('<ul>&lt;li&gt;a<li>b</ul>')
  })

  it('layout escapes the title and embeds the body verbatim, with the six nav links', () => {
    const doc = layout('P & Q', html`<p>body</p>`)
    expect(doc).toContain('<title>P &amp; Q</title>')
    expect(doc).toContain('<p>body</p>')
    for (const href of ['/admin', '/admin/proposals', '/admin/orders', '/admin/tickets', '/admin/runs', '/admin/settings']) {
      expect(doc).toContain(`href="${href}"`)
    }
  })
})
```

- [ ] **Step 2: RED.** `pnpm --filter @doge-buddy/ops test -- admin-html` — FAIL (module missing).

- [ ] **Step 3: Implement** `src/http/admin/html.ts`:

```ts
/** Marker for strings that are already safe HTML. The ONLY way html`` inserts verbatim. */
export class RawHtml {
  constructor(readonly value: string) {}
}

export function raw(value: string): RawHtml {
  return new RawHtml(value)
}

export function esc(input: unknown): string {
  return String(input)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function render(value: unknown): string {
  if (value instanceof RawHtml) return value.value
  if (Array.isArray(value)) return value.map(render).join('')
  return esc(value)
}

/**
 * Auto-escaping tagged template — the admin surface's ONLY way to build markup. Everything
 * interpolated is escaped unless explicitly RawHtml (which only our own html`` produces), so
 * attacker-influenced bytes (audit detail, proposal payloads, lastError strings) are inert by
 * default. Returns RawHtml so fragments compose without double-escaping.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): RawHtml {
  let out = strings[0]!
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + strings[i + 1]!
  }
  return new RawHtml(out)
}

const NAV = ['', 'proposals', 'orders', 'tickets', 'runs', 'settings'] as const

export function layout(title: string, body: RawHtml): string {
  const links = NAV.map((p) => {
    const href = p === '' ? '/admin' : `/admin/${p}`
    return html`<a href="${raw(href)}">${p === '' ? 'dashboard' : p}</a>`
  })
  return html`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>
    <nav>${links}</nav>
    <main>${body}</main>
  </body></html>`.value
}
```

- [ ] **Step 4: GREEN** + `pnpm --filter @doge-buddy/ops typecheck`.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(ops): auto-escaping html template + admin layout"`

---

### Task 2: Auth core — login/session tokens, cookies, rate cap

**Files:**
- Create: `apps/ops/src/http/admin/auth.ts`
- Test: `apps/ops/test/admin-auth.test.ts`

**Interfaces:**
- Consumes: `adminSessions`, `auditLog` from `@doge-buddy/db`; `NotifyOwner` (Plan A); `randomBytes`/`createHash` from node:crypto.
- Produces (Task 3 consumes):
  ```ts
  export function hashLoginToken(token: string): string    // sha256hex('login:' + token)
  export function hashSessionToken(token: string): string  // sha256hex('session:' + token)
  export const LOGIN_TOKEN_TTL_MS: number    // 15 * 60_000
  export const SESSION_TTL_MS: number        // 30 * 24 * 60 * 60_000
  export const LOGIN_SENDS_HOURLY_CAP: number // 5
  export const SESSION_COOKIE = 'db_admin'
  /** Creates a login row; returns the raw token for the link. */
  export async function createLoginToken(db: Db): Promise<string>
  /** Deletes the matching unexpired login row and mints a session; null when invalid/expired.
   *  Also opportunistically deletes all expired admin_sessions rows. */
  export async function consumeLoginToken(db: Db, token: string): Promise<{ sessionToken: string } | null>
  /** True when the cookie's session hash matches an unexpired session row. */
  export async function validateSession(db: Db, sessionToken: string | undefined): Promise<boolean>
  /** Counts audit rows admin.login_link_sent in the last hour. */
  export async function loginSendsLastHour(db: Db): Promise<number>
  export function serializeSessionCookie(token: string): string
  //   `db_admin=${token}; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=2592000`
  export function parseCookieHeader(header: string | undefined, name: string): string | undefined
  ```

- [ ] **Step 1: Write the failing tests** — `apps/ops/test/admin-auth.test.ts` (real db; `afterAll` pool.end):

```ts
it('login and session hashes are domain-separated — one token never satisfies the other space', async () => {
  const token = 'shared-raw-token'
  expect(hashLoginToken(token)).not.toBe(hashSessionToken(token))
  expect(hashLoginToken(token)).toMatch(/^[a-f0-9]{64}$/)
})

it('createLoginToken -> consumeLoginToken round-trip mints a session and burns the login row', async () => {
  const token = await createLoginToken(db)
  const result = await consumeLoginToken(db, token)
  expect(result).not.toBeNull()
  expect(await validateSession(db, result!.sessionToken)).toBe(true)
  // burned: second consume fails
  expect(await consumeLoginToken(db, token)).toBeNull()
})

it('an unconsumed login token is NOT a valid session cookie', async () => {
  const token = await createLoginToken(db)
  expect(await validateSession(db, token)).toBe(false)
})

it('expired login rows do not consume; expired session rows do not validate and are purged on check', async () => {
  const token = await createLoginToken(db)
  await db.update(adminSessions).set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(adminSessions.tokenHash, hashLoginToken(token)))
  expect(await consumeLoginToken(db, token)).toBeNull()

  const live = await createLoginToken(db)
  const { sessionToken } = (await consumeLoginToken(db, live))!
  await db.update(adminSessions).set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(adminSessions.tokenHash, hashSessionToken(sessionToken)))
  expect(await validateSession(db, sessionToken)).toBe(false)
  const [gone] = await db.select().from(adminSessions)
    .where(eq(adminSessions.tokenHash, hashSessionToken(sessionToken)))
  expect(gone).toBeUndefined() // opportunistic purge
})

it('cookie round-trip: serialize carries the flags; parse extracts among other cookies', () => {
  const c = serializeSessionCookie('tok123')
  expect(c).toBe('db_admin=tok123; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=2592000')
  expect(parseCookieHeader('a=1; db_admin=tok123; b=2', 'db_admin')).toBe('tok123')
  expect(parseCookieHeader(undefined, 'db_admin')).toBeUndefined()
  expect(parseCookieHeader('a=1', 'db_admin')).toBeUndefined()
})
```

- [ ] **Step 2: RED.**

- [ ] **Step 3: Implement** `src/http/admin/auth.ts`. Domain hashing mirrors `proposals/tokens.ts` (`createHash('sha256').update(\`login:${token}\`)`). `createLoginToken`: `randomBytes(32).toString('base64url')`, insert `{ tokenHash: hashLoginToken(token), expiresAt: new Date(Date.now() + LOGIN_TOKEN_TTL_MS) }`. `consumeLoginToken`: first `DELETE FROM admin_sessions WHERE expires_at < now()` (the opportunistic purge), then a single guarded consume — `db.delete(adminSessions).where(and(eq(tokenHash, hashLoginToken(token)), gt(expiresAt, new Date()))).returning()`; zero rows → null (delete-with-returning is the atomic single-use, same spirit as the guarded UPDATE); else insert the session row and return the fresh token. `validateSession`: purge expired, then select by `hashSessionToken`, `expiresAt > now()`. `loginSendsLastHour`: the `count()` + `gt(createdAt, sql\`now() - interval '1 hour'\`)` idiom from `http/webhooks.ts`'s capture cap, filtered on `action = 'admin.login_link_sent'`. `parseCookieHeader`: split on `'; '` → find `name=` prefix → slice.

- [ ] **Step 4: GREEN** + typecheck.

- [ ] **Step 5: Commit.** `git commit -m "feat(ops): admin auth core — domain-separated login/session tokens"`

---

### Task 3: Admin plugin skeleton — login routes, form parser, auth gate

**Files:**
- Create: `apps/ops/src/http/admin/routes.ts`
- Modify: `apps/ops/src/server.ts` (`ServerDeps` gains `admin?: AdminDeps`; register when present)
- Test: `apps/ops/test/admin-login.test.ts`

**Interfaces:**
- Consumes: Tasks 1-2; `NotifyOwner`; alert type; `SendOpts` enqueue shape (later tasks).
- Produces (Tasks 4-8 add routes INSIDE this plugin; they consume `AdminDeps` and the authed-scope pattern):
  ```ts
  export interface AdminDeps {
    db: Db
    settings: Settings            // from ../settings.ts
    notify: NotifyOwner
    enqueue: (name: string, data: object, opts?: SendOpts) => Promise<void>
    alert: Alert
    adminBaseUrl: string
    /** Optional: live CJ wallet read for the dashboard; absent → strip shows n/a. */
    getWalletBalance?: () => Promise<{ availableCents: number; frozenCents: number }>
  }
  export function adminRoutes(deps: AdminDeps): FastifyPluginAsync
  // Registered WITHOUT prefix; route paths carry /admin/... literally (matches actions.ts style).
  // Internal structure: plugin registers (a) the urlencoded FORM parser (real parsing:
  // Object.fromEntries(new URLSearchParams(buf.toString()))), (b) public login routes,
  // (c) a nested scope fastify.register(async (authed) => { authed.addHook('onRequest', gate);
  //     ...every authed route (Tasks 4-8 append here)... })
  // The gate: validateSession(db, parseCookieHeader(req.headers.cookie, SESSION_COOKIE));
  // invalid -> reply.code(303).header('location', '/admin/login').send() and DOES NOT continue.
  ```
- Login flow, exactly: `GET /admin/login` → layout page with one `<form method="post" action="/admin/login"><button>Send me a login link</button></form>`. `POST /admin/login` → if `loginSendsLastHour(db) >= LOGIN_SENDS_HOURLY_CAP` → 200 page "Try again later." (no send); else `createLoginToken`, `notify({title:'Doge Buddy admin login', body:'Tap to log in (link valid 15 minutes).', actions:[{label:'Log in', url:\`${adminBaseUrl}/admin/login/consume?t=${token}\`}]})`; on `true` insert audit `admin.login_link_sent` (actor `'system'`, entityType `'admin'`) then 200 "Link sent — check Telegram."; on `false` → 200 "Could not send the link — notifications unconfigured or failing." (alerting already happened inside notify). `GET /admin/login/consume?t=` → NEVER mutates: valid-looking `t` present → confirm page with `<form method="post" action="/admin/login/consume?t=...">` button; else friendly "link invalid or expired" (200). `POST /admin/login/consume?t=` → `consumeLoginToken`; null → same friendly page; else `reply.header('set-cookie', serializeSessionCookie(sessionToken)).code(303).header('location','/admin').send()`; audit `admin.login` actor `'owner'`.

- [ ] **Step 1: Write the failing tests** — `apps/ops/test/admin-login.test.ts` (buildServer with `admin: deps`, capture notifier). Cases:
1. `GET /admin` with no cookie → 303 to `/admin/login`; same for `/admin/settings` (the whole authed scope), and the redirect carries no body content that names routes.
2. `GET /admin/login` → 200 with the send-link form (no auth needed).
3. `POST /admin/login` (urlencoded, empty body) → 200 "Link sent"; exactly one captured notification whose single action URL matches `^http://ops\.test/admin/login/consume\?t=[A-Za-z0-9_-]{43}$`; an `admin.login_link_sent` audit row exists. **Cleanup: delete that audit row** (hourly-cap hygiene, the webhooks.test.ts idiom).
4. Rate cap: seed 5 `admin.login_link_sent` audit rows dated now → `POST /admin/login` → 200 "Try again later", no new notification, no new audit row. Cleanup: delete the seeded rows.
5. Notify returning false (deps.notify stubbed `async () => false`) → 200 "Could not send", NO `admin.login_link_sent` row (failed sends never count).
6. Full login: extract `t` from the captured URL → `GET consume` → 200 confirm form AND the login row still consumable after (GET never mutates: a following POST succeeds) → `POST consume` → 303 to `/admin` with a `set-cookie` starting `db_admin=` and containing `HttpOnly` — then `GET /admin` WITH that cookie → 200 (dashboard may be a stub until Task 6 — assert 200 + layout nav, not content).
7. Burned link: second `POST consume` with the same `t` → 200 friendly page, no new set-cookie.
8. Real browser content type on `POST /admin/login` (`content-type: application/x-www-form-urlencoded`, payload `''`) → 200, not 415 — the Plan A regression, asserted here on day one.

- [ ] **Step 2: RED.**

- [ ] **Step 3: Implement** `routes.ts` per the interface block (Task 6 will replace the `GET /admin` stub — for now the authed scope registers `GET /admin` returning `layout('Dashboard', html\`<p>coming in Task 6</p>\`)` so the auth tests have a target). `server.ts`: mirror the `actions` registration (`if (deps.admin) await app.register(adminRoutes(deps.admin))`).

- [ ] **Step 4: GREEN** + typecheck + full ops suite.

- [ ] **Step 5: Commit.** `git commit -m "feat(ops): magic-link admin login with session gate"`

---

### Task 4: Session-authed proposal decisions (+ edit-then-approve)

**Files:**
- Modify: `apps/ops/src/http/admin/routes.ts` (authed scope gains `POST /admin/proposals/:id/approve` and `POST /admin/proposals/:id/reject`)
- Modify: `apps/ops/src/proposals/submit.ts` (export the existing `PAYLOAD_SCHEMAS` map — one-word visibility change, no logic)
- Test: `apps/ops/test/admin-decisions.test.ts`

**Interfaces:**
- Consumes: `applyProposalTransition`, `StaleProposalStatusError` (`proposals/transitions.ts`), `enqueueProposalApply` (`proposals/submit.ts`), the per-type zod schemas from `@doge-buddy/core`, form parser from Task 3.
- Produces: route behavior only. Form field for edit-then-approve: `payload` (optional; JSON text from a textarea).

Behavior, exactly: load row; if `pending` and past `expiresAt` → lazy flip (`pending→expired`, audit `'system'`/`via:'admin-load'`... **no — decision POSTs use `via:'admin'` context but the expiry flip itself stays actor `'system'` with `detail.via:'lazy-expiry'`**, matching the `/a/` POST path) → 200 page "Already handled or expired". If not pending → same page. Approve with a `payload` field: `JSON.parse` (parse failure → 400 page with the error, escaped, form preserved is NOT required — a simple error page suffices) → validate through the row's type schema (`PAYLOAD_SCHEMAS[row.type]` — import the same map shape used in `submit.ts`; re-export it from `submit.ts` as `PAYLOAD_SCHEMAS` rather than duplicating) → zod failure → 400 page listing issues (escaped). Then the guarded UPDATE: `applyProposalTransition(db, id, 'pending', decision, { decidedBy: 'owner', decidedAt: new Date(), actionTokenHash: null, ...(patchedPayload ? { payload: patchedPayload } : {}) })`; `StaleProposalStatusError` → "Already handled". On approve → `enqueueProposalApply`; audit `proposal.approve|reject` actor `'owner'` `detail: { via: 'admin', edited: Boolean(patchedPayload) }` → 303 to `/admin/proposals/:id`.

- [ ] **Step 1: Write the failing tests.** Login helper (do the Task-3 flow once per test via a `loginAndGetCookie(app)` local helper — capture notifier + consume). Cases:
1. Unauthenticated `POST /admin/proposals/:id/approve` → 303 to login, row untouched.
2. Authed approve (no payload field) → 303; row `approved`, `decidedBy 'owner'`, `actionTokenHash` **null even though it had a token**; one enqueue with Plan A's exact opts; audit `via:'admin'`, `edited:false`.
3. Edit-then-approve: form `payload=<valid JSON with a changed title>` → row approved AND `payload.title` updated; audit `edited:true`.
4. Edit with schema-breaking JSON (`{"type":"new_listing"}` only) → 400, issues listed, row still `pending`, token hash still present, no enqueue.
5. Edit with unparseable JSON → 400, row untouched.
6. Reject → `rejected`, no enqueue.
7. Race: a `/a/` link POST and an admin POST fired via `Promise.all` on one pending row → exactly one wins (one enqueue max — winner may be either; assert final status ∈ {approved} and `enqueue` called ≤ once when the reject/approve mix guarantees... keep it simple: both are approve; assert exactly one enqueue).
8. Expired pending row → 200 "Already handled or expired", row flipped `expired` with the `'system'` audit.

- [ ] **Step 2: RED.**  - [ ] **Step 3: Implement** (incl. the `PAYLOAD_SCHEMAS` re-export from `submit.ts`).  - [ ] **Step 4: GREEN** + typecheck + full ops suite.  - [ ] **Step 5: Commit.** `git commit -m "feat(ops): session-authed proposal decisions with edit-then-approve"`

---

### Task 5: Proposals pages — queue + detail, typed rendering, lazy expiry on load

**Files:**
- Modify: `apps/ops/src/http/admin/routes.ts` (authed `GET /admin/proposals`, `GET /admin/proposals/:id`)
- Create: `apps/ops/src/http/admin/render-proposal.ts` (pure renderers)
- Test: `apps/ops/test/admin-proposals-pages.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // render-proposal.ts
  export function renderProposalRow(p: ProposalListRow): RawHtml   // <tr>: id-link, type, status, summary, created, expires
  export function renderProposalDetail(p: ProposalRow): RawHtml
  //   new_listing: title, price/cost per variant (formatCents), category, delivery window,
  //     <img> per imageUrl (src escaped), sku list — the "listing preview with images";
  //   every other type: <dl> of the payload's top-level keys with JSON.stringify'd values (escaped);
  //   pending rows append the Approve / Reject / Edit-then-approve forms
  //     (textarea name="payload" prefilled with JSON.stringify(payload, null, 2), escaped).
  ```
- List route: filters `?type=&status=` (validated against the enums; invalid values ignored), ordered `createdAt` desc, cap 100 rows. **Before rendering, both routes run the lazy sweep for what they show**: one bulk guarded UPDATE flipping `pending`-past-expiry rows (list: all such rows; detail: that row) with per-row audit `'system'`/`via:'admin-load'` — the sweep-shaped UPDATE from `proposal-expire-sweep.ts`, then render fresh reads.

- [ ] **Step 1: Write the failing tests.** Cases: unauth redirect; list shows a seeded pending row's summary ESCAPED (`<Widget> "X"` asserts `&lt;`); `?status=pending` filter excludes an applied row; a pending-past-expiry row renders as `expired` after load AND the DB row flipped with the `admin-load` audit; detail for a seeded `new_listing` shows title, `$29.99` (formatCents), an `<img src="...">` with the escaped URL, and the three decision forms; detail for an `applied` row shows no forms; detail for a hostile payload (`title: '<img onerror=x>'`) contains no unescaped `<img onerror` sequence.

- [ ] **Step 2: RED.**  - [ ] **Step 3: Implement** (import `formatCents` from `@doge-buddy/core`).  - [ ] **Step 4: GREEN** + typecheck.  - [ ] **Step 5: Commit.** `git commit -m "feat(ops): proposals queue + typed detail pages"`

---

### Task 6: Dashboard health strip + tickets/runs empty states

**Files:**
- Modify: `apps/ops/src/http/admin/routes.ts` (real `GET /admin`; `GET /admin/tickets`; `GET /admin/runs`)
- Create: `apps/ops/src/http/admin/health.ts`
- Test: `apps/ops/test/admin-dashboard.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // health.ts
  export interface HealthStrip {
    walletCents: number | null            // null => 'n/a' (no getWalletBalance dep, or it threw)
    queueDepth: number                    // pgboss.job rows in state IN ('created','retry','active')
    lastWebhookAt: Date | null            // max(webhook_events.received_at)
    killswitch: boolean; fulfillmentEnabled: boolean; pausedForFunds: boolean
    pendingProposals: number
  }
  export async function loadHealthStrip(deps: AdminDeps): Promise<HealthStrip>
  ```
- Queue depth via raw SQL over pg-boss's schema: `db.execute(sql\`SELECT count(*)::int AS n FROM pgboss.job WHERE state IN ('created','retry','active')\`)` — **node-postgres returns `{ rows }`**, read `result.rows[0].n` (the Plan A `db.execute` lesson); wrap in try/catch → `0` if the schema doesn't exist yet (fresh DB before any queue start). `walletCents`: `deps.getWalletBalance` absent or rejecting → null (never throws to the page). Settings via three `settings.get` calls. Tickets/runs pages: a `<table>` when rows exist (id, status/workflow, created), else "No tickets yet — Phase 6." / "No agent runs yet — Phase 5."

- [ ] **Step 1: Write the failing tests.** Cases: unauth redirects (all three routes); dashboard with a stubbed `getWalletBalance` shows the formatted balance and the pending count matches seeded rows; without the dep shows `n/a`; with a REJECTING stub still 200 + `n/a`; killswitch true renders visibly (assert the word `killswitch` + `ON`/`true` shape you implement); tickets and runs show their empty-state lines; runs shows a seeded `agent_runs` row's workflow name escaped.

- [ ] **Step 2: RED.**  - [ ] **Step 3: Implement.**  - [ ] **Step 4: GREEN** + typecheck.  - [ ] **Step 5: Commit.** `git commit -m "feat(ops): admin dashboard health strip; tickets/runs pages"`

---

### Task 7: Orders view + recovery actions (retires the runbook's SQL)

**Files:**
- Modify: `apps/ops/src/http/admin/routes.ts` (authed `GET /admin/orders`, `POST /admin/orders/:id/recover`)
- Create: `apps/ops/src/http/admin/render-orders.ts`
- Test: `apps/ops/test/admin-orders.test.ts`

**Interfaces:**
- Consumes: `orders`, `supplierOrders` tables; `applyTransition`, `IllegalTransitionError`, `StaleStatusError` from `fulfillment/transitions.ts`; `FULFILLMENT_RETRY_OPTS` from `fulfillment/run-place-order.ts`.
- Produces: `GET /admin/orders` — the parent-spec full `orders ⋈ supplier_orders` view, `needs_attention` rows **pinned on top** with their `lastError` (escaped — it embeds supplier strings) and a recovery form each (`<select name="target">` pending/confirmed/cancelled + button posting to `/admin/orders/:rowId/recover`); other rows below, `createdAt` desc, cap 100 each; hold-capable = the pinned-section renderer takes the pin-list as input (Phase 7 adds held rows to it — a comment marks the seam). `POST /admin/orders/:id/recover` (form field `target`): validate `target ∈ {pending, confirmed, cancelled}` (else 400); `applyTransition(db, id, 'needs_attention', target)` — `IllegalTransitionError`/`StaleStatusError` → 200 "Row was not recoverable (state changed?)"; on success audit `supplier_order.recovered` actor `'owner'` `detail {from:'needs_attention', to: target}`; **when target ≠ 'cancelled'**, ALWAYS re-send: join the order row for `shopifyOrderGid` then `enqueue('fulfillment.place-order', { orderGid }, { singletonKey: orderGid, ...FULFILLMENT_RETRY_OPTS })` (the runbook's mandatory re-send — this page replaces its raw SQL); 303 back to `/admin/orders`.

- [ ] **Step 1: Write the failing tests.** Seed via direct inserts (an `orders` row + `supplier_orders` rows in several statuses incl. one `needs_attention` with `lastError: 'stockout: <b>x</b>'`). Cases: unauth redirect; parked row renders in the pinned section with the lastError ESCAPED and the form; a `paid` row renders in the lower section without a form; recover→pending flips the row, audits `'owner'`, and enqueues place-order with the EXACT shape (singletonKey = the order's gid, the retry opts); recover→cancelled flips and does NOT enqueue; recover on an already-recovered row (status now pending) → 200 not-recoverable page, no second enqueue; `target=paid` → 400.

- [ ] **Step 2: RED.**  - [ ] **Step 3: Implement.**  - [ ] **Step 4: GREEN** + typecheck + full ops suite.  - [ ] **Step 5: Commit.** `git commit -m "feat(ops): admin orders view with needs_attention recovery"`

---

### Task 8: Settings editor + manual-signal paste box

**Files:**
- Modify: `apps/ops/src/http/admin/routes.ts` (authed `GET /admin/settings`, `POST /admin/settings`, `POST /admin/signals`)
- Test: `apps/ops/test/admin-settings.test.ts`

**Interfaces:**
- Consumes: `SETTINGS_DEFAULTS`, `Settings` (Task/Plan-A `settings.ts`); `sourcingSignals` table.
- Behavior: `GET /admin/settings` renders one form per key (runtime-typed per the Global Constraint: boolean → checkbox, `.mode` → select, else number input), each row showing current value (`settings.get`) and posting `key` + `value` to `/admin/settings`. POST: `key` must be in `SETTINGS_DEFAULTS` (else 400); coerce by that key's runtime type — checkbox: value `'on'`/absent → true/false; mode: must be `'manual'|'auto'` (else 400); number: `Number()`, must be a safe integer ≥ 0 (else 400); read the old value, `settings.set`, audit `setting.updated` actor `'owner'` `detail {key, from, to}`; 303 back. **The paste box** (parent §admin): a labeled `<textarea name="content">` + keyword field `<input name="keyword">` posting to `/admin/signals`; POST inserts `sourcingSignals` `{ source: 'owner_manual', keyword: keyword || null, snapshot: { content } }` (empty content → 400); audit `signal.pasted` actor `'owner'`; 303 back with the page then showing the last 10 pasted signals (keyword + fetchedAt, content escaped/truncated 200 chars).

- [ ] **Step 1: Write the failing tests.** Cases: unauth redirects (all three); GET shows every `SETTINGS_DEFAULTS` key with its current value and the paste box; POST flips `killswitch.global` checkbox on → `settings.get` reads true + audit row `{from:false,to:true}` (restore to false after — shared settings hygiene); POST `workflow.sourcing.mode=auto` round-trips (restore); POST mode `bogus` → 400, unchanged; POST unknown key → 400; number field non-numeric → 400; signal paste inserts the `sourcing_signals` row with `source 'owner_manual'` + audit; empty paste → 400; hostile pasted content renders escaped in the last-10 list.

- [ ] **Step 2: RED.**  - [ ] **Step 3: Implement.**  - [ ] **Step 4: GREEN** + typecheck.  - [ ] **Step 5: Commit.** `git commit -m "feat(ops): admin settings editor + manual signal paste box"`

---

### Task 9: Wiring, docs, workspace gate

**Files:**
- Modify: `apps/ops/src/index.ts` (assemble `AdminDeps`; register alongside `actions`), `README.md`, `docs/OWNER-CHECKLIST.md`
- Test: none new (wiring is exercised by every routes test through `buildServer`; the live check is Tier-2)

Steps:
- [ ] **Step 1: index.ts.** Build `adminDeps: AdminDeps` next to `actionDeps`, reusing the same `db/settings/notify/enqueue/alert` bindings and `config.adminBaseUrl!`; `getWalletBalance` = `cjAdapter ? () => cjAdapter.getBalance() : undefined`. Pass `...(config.adminBaseUrl ? { admin: adminDeps, actions: actionDeps } : {})` (one shared gate — replaces the actions-only spread). Confirm the `let alertImpl`/`let queue` deferred bindings still precede any request-time use (they do — admin routes are request-time only; keep the existing comment style and extend it to name admin).
- [ ] **Step 2: Docs.** README: current-phase paragraph → Plan B shipped, dashboard at `<ADMIN_BASE_URL>/admin`, next = Phase 5. OWNER-CHECKLIST: new 🟡 Tier-2 item — "log in at `https://doge-buddyops-production.up.railway.app/admin/login` after the next push (tap the Telegram login link on your phone), walk the dashboard/proposals/orders/settings pages, approve one seeded proposal from the dashboard"; footer pointer → Phase 5 prework (sourcing agent; needs the Anthropic API key ⚪ item).
- [ ] **Step 3: Workspace gate.** `pnpm -r typecheck && pnpm -r test` — all green; include tails in the report.
- [ ] **Step 4: Commit.** `git commit -m "feat(ops): wire admin surface; Phase 4B docs"`

---

**Tier 2 (owner, post-merge):** real login via Telegram through the Railway URL; dashboard walk; one dashboard-approved proposal. Tracked on OWNER-CHECKLIST by Task 9.
**Parked/inherited context an implementer may hit:** the five-copy local `Alert` type (deferred branch-wide nit — do NOT refactor it mid-task); `actions.ts`'s own `esc/page` stay as-is (no churn — new code uses `admin/html.ts`); the pg-boss `expire_in` parked ruling (Plan A ledger) is untouched by this plan.
