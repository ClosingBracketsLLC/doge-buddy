# Admin control center — mobile-first design system + a real home page

**Date:** 2026-08-31 · **Status:** approved (design in chat, 2026-08-31) · **Owner device:** Samsung
Galaxy Z Fold 8 — cover screen ≈ 380 CSS px wide, inner screen ≈ 800 CSS px wide, both OLED; also
used on desktop. **Parent:** `docs/LAUNCH-BACKLOG.md` (ops quality-of-life).

## Facts this design rests on (audited 2026-08-31)

- The admin is server-rendered by the auto-escaping `html\`\`` tag in `apps/ops/src/http/admin/html.ts`;
  `layout(title, body)` emits `<!doctype html>` + a text `<nav>` + `<main>`. **No CSS, no viewport
  meta, no JS.** 42 `layout(...)` call sites in `routes.ts`; renderers in `render-{orders,proposal,
  run,tickets}.ts`. Element inventory: 26 `<section>`, 17 `<form>`, 16 `<button>`, 8 `<table>`,
  7 `<textarea>`, 4 `<pre>`, 3 `<select>`, 2 `<details>`.
- Routes: `/admin` (dashboard = `renderHealthStrip(loadHealthStrip(deps))`), `/admin/tickets[/:id]`,
  `/admin/runs[/:id]`, `/admin/proposals[/:id]` (+ `POST …/resend-apply`, approve/reject/edit forms
  in `render-proposal.ts`), `/admin/orders` (+ `POST …/:id/recover`), `/admin/settings` (GET; `POST`
  with body `{ key, value }`, `value` = `'on'`/absent for booleans, `manual|auto` for modes, integer
  string for numbers; 303 → `/admin/settings`), `/admin/guidance`, `POST /admin/signals`, login pages,
  `POST /admin/logout`.
- `loadHealthStrip` (health.ts) already loads: wallet cents (+ threshold), queue depth, last webhook,
  killswitch / fulfillment enabled / paused for funds, pending proposals, support poll state, support
  agent runs today + last run, scoring last run. Sync job audit actions: `inventory.synced`,
  `inventory_sync.variant_failed`; degraded alert kind `inventory_sync_degraded` (alerts are audit rows).
- `apps/ops/test/admin-dashboard.test.ts` (and the other `admin-*.test.ts`) assert on page TEXT
  (`toContain('Pending proposals: 3')`, `'Killswitch: ON'`, `'support poll: last ok …'`, …), never on
  structure. No CSP header is set; no static-file plugin is registered.
- Storefront brand tokens (`apps/storefront/app/styles/app.css`): gold `#f6ce18`, gold-dark `#bb6402`,
  accent `#ffb327`, cta red `#ff3641`, info `#145069`, ink `#10171a`, paper `#fdf3e0`, surface-raised
  `#fffcf5`, sky `#00e1ff`.
- Playwright Chromium builds are installed locally (`~/.cache/ms-playwright/chromium-*`) — visual
  checks at three widths are possible.

## Exit criteria

1. Every admin page renders with a viewport meta, the shared stylesheet, and no horizontal page
   scroll at 380, 800 and 1280 px wide (Playwright screenshots at all three, checked in review).
2. Under 640 px the nav is a bottom tab bar (Home · Proposals · Tickets · Orders · More) with count
   badges (pending proposals, escalated tickets); ≥ 640 px it is a left rail with the same items.
3. `/admin` is a card board: Needs-you counts, Money, Switches (toggles that post to the existing
   settings endpoint and land back on `/admin`), Agents & jobs (incl. inventory sync), Catalog — and
   the existing text health strip survives verbatim inside a collapsible "System status" block.
4. Every table stacks into cards under 640 px (each cell shows its column label); every irreversible
   POST (approve, reject, approve-edited, resend-apply, recover, escalate, resolve) asks
   `confirm()` first; proposal and ticket detail pages keep their primary actions in a sticky bottom
   bar on narrow screens.
5. All existing tests pass unchanged; new tests cover the shell, badges, cards, `data-label`s and the
   settings `returnTo` allow-list. Typecheck clean.

## Non-goals

No JS framework or build step, no external CDN/fonts, no PWA manifest/push, no auto-refresh, no
route/URL/behaviour changes beyond the `returnTo` field, no changes to the storefront.

## 1. Foundation (`html.ts`)

`layout()` gains `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`,
`<meta name="theme-color" content="#10171a">` (light: `#fdf3e0` via `media` attribute), and ONE
`<style>` block, exported from a new `apps/ops/src/http/admin/styles.ts` as a constant string
(`ADMIN_CSS`) so tests can assert on it and reviewers can read it in one place. ~350 lines, hand-written,
no preprocessor.

Tokens on `:root` (dark default): `--bg #0c1114`, `--surface #10171a`, `--surface-2 #172026`,
`--line #26333a`, `--ink #f2ede2`, `--muted #9aa7ad`, `--accent #f6ce18`, `--accent-ink #10171a`,
`--ok #3ddc84`, `--warn #ffb327`, `--bad #ff3641`, `--info #00e1ff`. Under
`@media (prefers-color-scheme: light)`: `--bg #fdf3e0`, `--surface #fffcf5`, `--surface-2 #fff7e6`,
`--line #e6d9bd`, `--ink #10171a`, `--muted #5b6a70`, `--accent #bb6402`, `--accent-ink #fff`,
status colors darkened one step for contrast (`--ok #1f8f52`, `--warn #b36b00`, `--bad #c8232c`,
`--info #145069`). `color-scheme: dark light` on `:root` so native controls follow.

Type: system stack (`-apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif`), base 16 px, inputs
and selects 16 px (no mobile zoom-in), `line-height 1.45`. Tap targets: every `button`, `a.tab`,
`select`, `input[type=checkbox]` wrapper ≥ 44 × 44 px. Spacing scale 4/8/12/16/24. Safe areas:
`padding-bottom: calc(var(--tabbar-h) + env(safe-area-inset-bottom))` on `main` under 640 px.

Breakpoints: **`< 640px`** phone/cover screen (single column, bottom tabs); **`640–1023px`** inner
screen (left rail 72 px icon+label, 2-column card grid); **`≥ 1024px`** desktop (rail 200 px with
labels, 3-column grid, `main` max-width 1200 px).

## 2. Shell

`layout(title, body, nav?: NavCounts)` where `NavCounts = { pendingProposals: number; escalatedTickets: number }`.
Markup:

```
<header class="topbar"><a class="brand" href="/admin">🐶 Doge Buddy</a><h1>{title}</h1>{LOGOUT_FORM}</header>
<nav class="tabs" aria-label="Admin">
  <a class="tab" href="/admin" aria-current="page"?><span class="ico">⌂</span>Home</a>
  <a class="tab" href="/admin/proposals">…Proposals<span class="badge">3</span></a>
  <a class="tab" href="/admin/tickets">…Tickets<span class="badge bad">1</span></a>
  <a class="tab" href="/admin/orders">…Orders</a>
  <details class="tab more"><summary>More</summary><a href="/admin/runs">Runs</a><a href="/admin/settings">Settings</a><a href="/admin/guidance">Guidance</a></details>
</nav>
<main>{body}</main>
```

`aria-current="page"` is set from the `title`→path map already implied by `NAV` (layout gets the
current path via a third param `{ path }` — passed by the `page()` helper, below). Badges render only
when the count is > 0; Tickets' badge uses the `bad` color (escalated = customer waiting). Under
640 px `.tabs` is `position: fixed; bottom: 0` with five equal cells; the `More` cell opens upward
(`details` positioned absolute above the bar). ≥ 640 px `.tabs` is a sticky left rail and `More`'s
three links render inline as ordinary rail items (CSS shows `summary` hidden, children visible).

**`page()` helper** in `routes.ts`: `const page = async (title, body, path) => layout(title, body, { path, counts: await loadNavCounts(deps) })`
replaces every authed `layout(...)` call (login/consume pages keep plain `layout` — no counts, no
tabs: `layout()` renders the tab bar only when `counts` is passed). `loadNavCounts(deps)` in a new
`nav.ts`: two `count()` queries (`proposals.status = 'pending'`, `support_tickets.status = 'escalated'`),
wrapped in try/catch → zeros, never a 500 for a badge.

Bad-request/error bodies inside handlers (`layout('Settings', html\`<p>Unknown setting.</p>\`)`) go
through `page()` too so they keep the shell.

## 3. Control center (`/admin`)

`loadHealthStrip` is extended (same file, same `Promise.all`) with:
`escalatedTickets`, `ordersNeedsAttention` (count of `supplier_orders.status = 'needs_attention'`),
`sourcingLastRun: { status, startedAt } | null` (newest `agent_runs` row whose `workflow` is the
sourcing pipeline's key — read the constant `startAgentRun` is called with in `sourcing/pipeline.ts`,
do not hardcode a guess), `inventorySyncLastAt: Date | null` (newest `audit_log` row with
`action = 'inventory.synced'`), `inventorySyncDegraded: boolean` (an `inventory_sync_degraded` alert
audit row newer than `inventorySyncLastAt`), `activeProducts`, `trackedVariants` (variants with a
non-null `shopify_inventory_item_gid` on active products), `latestListing: { title, handle, createdAt } | null`
(newest active product), and the four workflow modes (`workflow.sourcing.mode`, `support_reply`,
`refund`, `deprecation`).

`render-dashboard.ts` (new; `renderHealthStrip` moves there unchanged) renders, in order:

1. **Needs you** — three stat cards, each a link: *Pending proposals* → `/admin/proposals?status=pending`,
   *Escalated tickets* → `/admin/tickets?status=escalated`, *Orders needing attention* → `/admin/orders`.
   Value > 0 → `bad` accent + count; 0 → muted "0 · all clear".
2. **Money** — wallet card: `$x.xx` big, a bar `min(100, wallet/threshold·100)%` colored ok/warn/bad
   (bad when below threshold, warn under 2× threshold), "alert threshold $y.yy"; `paused_for_funds`
   ON renders a red chip. `n/a` when wallet unknown (existing behaviour).
3. **Switches** — one card per control, each its own `<form method="post" action="/admin/settings">`
   with `<input type="hidden" name="key">`, `<input type="hidden" name="returnTo" value="/admin">`:
   *Kill switch* and *Fulfillment* as checkbox toggles (`name="value"`, `value="on"`, `onchange="this.form.submit()"`;
   the kill switch and fulfillment-off additionally `confirm()`), the four modes as two-button
   segmented controls (`<button name="value" value="manual">` / `auto`, current one `aria-pressed`).
   The build-week use case: flip sourcing to auto and back from the cover screen in one tap.
4. **Agents & jobs** — compact rows (label · value · age): sourcing last run, support agent runs
   today / cap + last run, support poll (ok/failing), scoring last run, inventory sync last run
   (+ "DEGRADED" red chip), queue depth, last webhook. Ages render as "3m ago"/"2h ago"/"never" via a
   `relativeTime(date, now)` helper in `html.ts` (also used by the tables); ISO timestamps stay in a
   `title` attribute.
5. **Catalog** — active products (with "of 40" progress bar while < 40 — the build-week target),
   tracked variants, latest listing (link to the storefront product URL: `https://dogebuddy.com/products/<handle>`).
6. **System status** — `<details class="card"><summary>System status (text)</summary>${renderHealthStrip(h)}</details>`
   — the existing strip verbatim, so every current dashboard assertion holds.

Card grid: 1 / 2 / 3 columns by breakpoint (§1). Stat values use `font-size: clamp(1.75rem, 6vw, 2.5rem)`.

**`POST /admin/settings` gains `returnTo`**: accepted values exactly `/admin` or `/admin/settings`
(anything else → `/admin/settings`). The audit row is unchanged.

## 4. Pages

- **Tables**: each `<td>` gets `data-label="<column>"`; `<table>` gets `class="rows"`. Under 640 px:
  `thead` hidden, `tr` becomes a card, `td` a label/value row (`td::before { content: attr(data-label) }`).
  Long cells (`summary`, `lastError`) get `class="wrap"`; ids get `class="mono"` (monospace, ellipsis).
- **Chips**: `chip(state)` helper in `html.ts` maps proposal (`pending` warn, `approved`/`applying`
  info, `applied` ok, `rejected`/`expired`/`failed` bad), ticket (`escalated` bad, `triaged`/`open`
  warn, `resolved` ok, spam muted), supplier-order (`needs_attention` bad, `placed`/`paid`/`shipped`
  ok/info, `failed` bad), run (`running` info, `succeeded` ok, `failed`/`aborted` bad) states to
  `<span class="chip chip-<tone>">text</span>`. Unknown states → neutral chip. Renderers swap their
  bare status text for `chip(...)` (the state's text is still present — tests that `toContain('escalated')`
  keep passing).
- **Forms**: labels above inputs, inputs full-width, `textarea` min-height 8 rem, primary action
  `class="btn primary"` (gold), destructive `class="btn danger"`, everything else `class="btn"`.
  Filter chips on list pages (`?status=`) render as a horizontal scrollable chip row.
- **Confirmations**: irreversible forms get `data-confirm="Approve this proposal?"`; a 12-line inline
  `<script>` at the end of `layout()` attaches `submit` listeners (`if (!confirm(form.dataset.confirm)) e.preventDefault()`)
  and submits toggle forms on `change`. That script is the ONLY JS. Without JS everything still works
  (forms post; toggles have a visible "Save" button hidden only when JS is present via a `js` class
  on `<html>`).
- **Sticky action bar**: proposal detail wraps Approve/Reject (and Approve-edited) forms in
  `<div class="actions sticky">`; ticket detail wraps escalate/resolve the same way. Under 640 px it
  is `position: sticky; bottom: var(--tabbar-h)`.
- **Preformatted payloads**: `<pre>` gets `overflow-x: auto; max-height: 50vh`. `main`
  `overflow-x: hidden` guards the page.
- **Login pages**: centred single card, same tokens, no tabs.

## 5. Testing

- `admin-html.test.ts`: viewport meta + `ADMIN_CSS` present; tabs render only with counts; badge
  markup for 0/1/n; `aria-current` on the active tab; `relativeTime` cases; `chip` tone mapping.
- `admin-dashboard.test.ts` (existing assertions untouched) + new: each Needs-you count with seeded
  rows; wallet bar tone at below/near/above threshold; switch forms carry `returnTo=/admin` and the
  right `key`; sourcing/sync/catalog rows with and without data.
- `admin-settings.test.ts`: `returnTo=/admin` → 303 `/admin`; `returnTo=/evil` → `/admin/settings`.
- Every list page test gets one assertion that its table cells carry `data-label`.
- Visual: a throwaway Playwright script (scratchpad, not committed) screenshots `/admin`,
  `/admin/proposals`, a proposal detail, `/admin/tickets`, `/admin/orders`, `/admin/settings` at
  380 / 800 / 1280 px against the local ops server with seeded data; the final review reads them.

## 6. File map

| File | Change |
|---|---|
| `apps/ops/src/http/admin/styles.ts` | new — `ADMIN_CSS`, `ADMIN_JS` |
| `apps/ops/src/http/admin/html.ts` | `layout(title, body, nav?)`, `chip()`, `relativeTime()` |
| `apps/ops/src/http/admin/nav.ts` | new — `loadNavCounts(deps)` |
| `apps/ops/src/http/admin/health.ts` | extended `HealthStrip` + loaders |
| `apps/ops/src/http/admin/render-dashboard.ts` | new — cards + moved `renderHealthStrip` |
| `apps/ops/src/http/admin/routes.ts` | `page()` helper, `returnTo`, `data-confirm`, sticky bars |
| `apps/ops/src/http/admin/render-{orders,proposal,run,tickets}.ts` | `data-label`, chips, classes |
| `apps/ops/test/admin-*.test.ts` | new assertions per §5 |
