# Admin Control Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A mobile-first admin (Galaxy Z Fold 8 cover screen ≈ 380 px, inner screen ≈ 800 px, desktop) with a shared design system, a bottom-tab/left-rail shell with count badges, and a card-based control-center home page — without changing any route's behaviour or breaking any existing test.

**Architecture:** One hand-written stylesheet (`styles.ts`, exported as a string) and ~12 lines of inline JS are emitted by `layout()`; `layout()` gains an optional `shell` (current path + nav counts) that a `page()` helper in `routes.ts` supplies for every authed page. The dashboard becomes `render-dashboard.ts` (cards built from an extended `HealthStrip`), with the old text strip preserved verbatim inside a `<details>`. Renderers gain `data-label` cells, status chips, button classes, sticky action bars and `data-confirm`. `POST /admin/settings` accepts an allow-listed `returnTo`.

**Tech Stack:** TypeScript (Node 22, ESM `.ts` imports), Fastify, drizzle-orm/Postgres (tests hit the real local DB on 5433), vitest, the repo's own `html\`\`` auto-escaping tag. No new dependencies. Playwright (already installed locally) only for the visual check in Task 6 — never in the test suite.

**Spec:** `docs/superpowers/specs/2026-08-31-admin-control-center-design.md` — read it first; every task cites its sections.

## Global Constraints

- Run from the worktree root: `pnpm --filter @doge-buddy/ops test <file>` (vitest, real DB `postgres://doge:doge@localhost:5433/doge_buddy`, shared container — never `pnpm db:up` in a worktree) and `pnpm --filter @doge-buddy/ops typecheck` (`tsc --noEmit`; CI gates on it separately from tests). Both must be green before a task is called done. No migration is expected; if one becomes necessary, STOP and rule (it changes the owner's deploy steps).
- Markup discipline: every admin string goes through `html\`\`` (auto-escaped). `raw()` is allowed ONLY for (a) the constant `ADMIN_CSS`/`ADMIN_JS` strings, (b) hrefs/attribute fragments built from constants, (c) existing call sites. Never `raw()` anything derived from DB/user data.
- **Every existing test stays green and unmodified** unless a task explicitly says which assertion to change. The dashboard tests pin the health-strip text (`Pending proposals: 3`, `Killswitch: ON`, `support poll: last ok …`, `support agent: N runs today / …`, `scoring: last run …`) — `renderHealthStrip` moves files but its output does not change by one byte.
- Tokens (spec §1), exactly: dark `--bg #0c1114 --surface #10171a --surface-2 #172026 --line #26333a --ink #f2ede2 --muted #9aa7ad --accent #f6ce18 --accent-ink #10171a --ok #3ddc84 --warn #ffb327 --bad #ff3641 --info #00e1ff`; light `--bg #fdf3e0 --surface #fffcf5 --surface-2 #fff7e6 --line #e6d9bd --ink #10171a --muted #5b6a70 --accent #bb6402 --accent-ink #fff --ok #1f8f52 --warn #b36b00 --bad #c8232c --info #145069`. Breakpoints: `max-width: 639px` phone, `640px–1023px` inner screen, `min-width: 1024px` desktop. Tab bar height `--tabbar-h: 64px`.
- Tab items and hrefs, in order: Home `/admin`, Proposals `/admin/proposals`, Tickets `/admin/tickets`, Orders `/admin/orders`, More → Runs `/admin/runs`, Settings `/admin/settings`, Guidance `/admin/guidance`. Badges: Proposals = pending proposals, Tickets = escalated tickets; rendered only when > 0.
- `returnTo` on `POST /admin/settings`: exactly `/admin` or `/admin/settings` are honoured; anything else (or absent) → `/admin/settings`.
- Sourcing workflow key is `'sourcing.weekly'`, exported from `sourcing/pipeline.ts` as `SOURCING_WORKFLOW`.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Never `git push`. Never `pkill -f`.

---

## File map

| File | Responsibility |
|---|---|
| `apps/ops/src/http/admin/styles.ts` (new) | `ADMIN_CSS`, `ADMIN_JS` constants |
| `apps/ops/src/http/admin/html.ts` | `layout(title, body, shell?)`, `NAV_ITEMS`, `chip()`, `relativeTime()` |
| `apps/ops/src/http/admin/nav.ts` (new) | `loadNavCounts(db)` |
| `apps/ops/src/http/admin/health.ts` | extended `HealthStrip` + loaders |
| `apps/ops/src/http/admin/render-dashboard.ts` (new) | `renderHealthStrip` (moved verbatim) + `renderDashboard` cards |
| `apps/ops/src/sourcing/pipeline.ts` | export `SOURCING_WORKFLOW` |
| `apps/ops/src/http/admin/routes.ts` | `page()` helper, `returnTo`, settings/signals/runs/guidance markup |
| `apps/ops/src/http/admin/render-{orders,proposal,run,tickets}.ts` | `data-label`, chips, classes, sticky bars, `data-confirm` |
| `apps/ops/test/admin-html.test.ts`, `admin-nav.test.ts` (new), `admin-dashboard.test.ts`, `admin-settings.test.ts`, `admin-proposals-pages.test.ts`, `admin-tickets.test.ts`, `admin-orders.test.ts`, `admin-runs.test.ts` | new assertions |
| `docs/OWNER-CHECKLIST.md` | one line: admin redesign shipped, what to look at on the Fold |

---

### Task 1: Design system + shell — `styles.ts`, `html.ts`, `nav.ts`

**Files:**
- Create: `apps/ops/src/http/admin/styles.ts`, `apps/ops/src/http/admin/nav.ts`, `apps/ops/test/admin-nav.test.ts`
- Modify: `apps/ops/src/http/admin/html.ts`, `apps/ops/test/admin-html.test.ts`

**Interfaces (produces):**
```ts
// styles.ts
export const ADMIN_CSS: string
export const ADMIN_JS: string
// html.ts
export interface NavCounts { pendingProposals: number; escalatedTickets: number }
export interface Shell { path: string; counts: NavCounts }
export const NAV_ITEMS: readonly { href: string; label: string; more?: true }[]
export function layout(title: string, body: RawHtml, shell?: Shell): string
export type ChipTone = 'ok' | 'warn' | 'bad' | 'info' | 'muted'
export function chipTone(state: string): ChipTone
export function chip(state: string): RawHtml            // <span class="chip chip-<tone>">state</span>
export function relativeTime(date: Date | null, now?: Date): string  // 'never' | 'just now' | '3m ago' | '2h ago' | '4d ago'
// nav.ts
export function loadNavCounts(db: Db): Promise<NavCounts>   // never throws; zeros on error
```

- [ ] **Step 1: Failing tests** — replace the last test in `apps/ops/test/admin-html.test.ts` and append:

```ts
  it('layout without a shell: viewport + stylesheet + JS, NO tabs (login pages)', () => {
    const doc = layout('P & Q', html`<p>body</p>`)
    expect(doc).toContain('<title>P &amp; Q</title>')
    expect(doc).toContain('<p>body</p>')
    expect(doc).toContain('name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"')
    expect(doc).toContain('<style>')
    expect(doc).toContain(ADMIN_CSS)
    expect(doc).toContain(ADMIN_JS)
    expect(doc).not.toContain('class="tabs"')
    expect(doc).toContain('action="/admin/logout"')
  })

  it('layout with a shell renders the seven nav links, badges only when > 0, aria-current on the active tab', () => {
    const doc = layout('Tickets', html`<p>x</p>`, { path: '/admin/tickets', counts: { pendingProposals: 3, escalatedTickets: 0 } })
    expect(doc).toContain('class="tabs"')
    for (const href of ['/admin', '/admin/proposals', '/admin/tickets', '/admin/orders', '/admin/runs', '/admin/settings', '/admin/guidance']) {
      expect(doc).toContain(`href="${href}"`)
    }
    expect(doc).toContain('<span class="badge">3</span>')
    expect(doc).not.toContain('class="badge bad"')
    expect(doc).toMatch(/<a class="tab" href="\/admin\/tickets" aria-current="page">/)
    expect(doc).not.toMatch(/href="\/admin" aria-current/)
    expect(doc).toContain('<h1 class="page-title">Tickets</h1>')
  })

  it('escalated badge uses the bad tone; /admin is current only on an exact match; detail paths match their list tab', () => {
    const doc = layout('Home', html``, { path: '/admin', counts: { pendingProposals: 0, escalatedTickets: 2 } })
    expect(doc).toContain('<span class="badge bad">2</span>')
    expect(doc).toMatch(/<a class="tab" href="\/admin" aria-current="page">/)
    const detail = layout('Proposal', html``, { path: '/admin/proposals/abc', counts: { pendingProposals: 0, escalatedTickets: 0 } })
    expect(detail).toMatch(/<a class="tab" href="\/admin\/proposals" aria-current="page">/)
    expect(detail).not.toContain('class="badge')
  })

  it('chip maps states to tones and escapes the text', () => {
    expect(chipTone('pending')).toBe('warn')
    expect(chipTone('applied')).toBe('ok')
    expect(chipTone('escalated')).toBe('bad')
    expect(chipTone('needs_attention')).toBe('bad')
    expect(chipTone('running')).toBe('info')
    expect(chipTone('succeeded')).toBe('ok')
    expect(chipTone('whatever')).toBe('muted')
    expect(chip('<x>').value).toBe('<span class="chip chip-muted">&lt;x&gt;</span>')
  })

  it('relativeTime buckets', () => {
    const now = new Date('2026-08-31T12:00:00Z')
    expect(relativeTime(null, now)).toBe('never')
    expect(relativeTime(new Date('2026-08-31T11:59:40Z'), now)).toBe('just now')
    expect(relativeTime(new Date('2026-08-31T11:57:00Z'), now)).toBe('3m ago')
    expect(relativeTime(new Date('2026-08-31T10:00:00Z'), now)).toBe('2h ago')
    expect(relativeTime(new Date('2026-08-27T12:00:00Z'), now)).toBe('4d ago')
    expect(relativeTime(new Date('2026-08-31T12:00:30Z'), now)).toBe('just now') // clock skew: never negative
  })
```
Update the import line to `import { ADMIN_CSS, ADMIN_JS } from '../src/http/admin/styles.ts'` and `import { chip, chipTone, esc, html, layout, raw, relativeTime } from '../src/http/admin/html.ts'`.

Create `apps/ops/test/admin-nav.test.ts`:

```ts
import { createDb, proposals, supportTickets } from '@doge-buddy/db'
import { inArray } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { loadNavCounts } from '../src/http/admin/nav.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

describe('loadNavCounts', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())
  let proposalIds: string[] = []
  let ticketIds: string[] = []
  afterEach(async () => {
    if (proposalIds.length) await db.delete(proposals).where(inArray(proposals.id, proposalIds))
    if (ticketIds.length) await db.delete(supportTickets).where(inArray(supportTickets.id, ticketIds))
    proposalIds = []; ticketIds = []
  })

  it('counts pending proposals and escalated tickets (deltas against whatever else is in the DB)', async () => {
    const before = await loadNavCounts(db)
    const [p1, p2, p3] = await db.insert(proposals).values([
      { type: 'new_listing', status: 'pending', summary: 'nav a', payload: {}, sourceWorkflow: 'test', expiresAt: new Date(Date.now() + 3_600_000) },
      { type: 'new_listing', status: 'pending', summary: 'nav b', payload: {}, sourceWorkflow: 'test', expiresAt: new Date(Date.now() + 3_600_000) },
      { type: 'new_listing', status: 'rejected', summary: 'nav c', payload: {}, sourceWorkflow: 'test', expiresAt: new Date(Date.now() + 3_600_000) },
    ]).returning({ id: proposals.id })
    proposalIds = [p1!.id, p2!.id, p3!.id]
    const [t1, t2] = await db.insert(supportTickets).values([
      { customerEmail: 'nav1@example.com', subject: 'nav', status: 'escalated' },
      { customerEmail: 'nav2@example.com', subject: 'nav', status: 'triaged' },
    ]).returning({ id: supportTickets.id })
    ticketIds = [t1!.id, t2!.id]

    const after = await loadNavCounts(db)
    expect(after.pendingProposals - before.pendingProposals).toBe(2)
    expect(after.escalatedTickets - before.escalatedTickets).toBe(1)
  })

  it('never throws: a broken db yields zeros', async () => {
    const broken = { select: () => { throw new Error('boom') } } as unknown as Parameters<typeof loadNavCounts>[0]
    await expect(loadNavCounts(broken)).resolves.toEqual({ pendingProposals: 0, escalatedTickets: 0 })
  })
})
```
(Check `proposals`/`supportTickets` NOT NULL columns against `packages/db/src/schema.ts` before running — add any required column the insert is missing, mirroring `admin-dashboard.test.ts`'s seeds.)

- [ ] **Step 2: Run, verify they fail** — `pnpm --filter @doge-buddy/ops test test/admin-html.test.ts test/admin-nav.test.ts` → import errors / missing exports.

- [ ] **Step 3: `styles.ts`** — create with exactly this content (tokens per Global Constraints; keep it hand-readable, no minification):

```ts
/**
 * The admin's ONLY stylesheet and ONLY script, inlined by `layout()` (html.ts). No build step, no
 * CDN, no framework — a design system small enough to read in one sitting. Mobile-first for the
 * owner's Galaxy Z Fold 8: `< 640px` is the cover screen (bottom tab bar, single column),
 * `640–1023px` the inner screen (left rail, two columns), `>= 1024px` desktop (rail with labels,
 * three columns). Dark by default; light follows `prefers-color-scheme`.
 */
export const ADMIN_CSS = `
:root {
  color-scheme: dark light;
  --bg: #0c1114; --surface: #10171a; --surface-2: #172026; --line: #26333a;
  --ink: #f2ede2; --muted: #9aa7ad; --accent: #f6ce18; --accent-ink: #10171a;
  --ok: #3ddc84; --warn: #ffb327; --bad: #ff3641; --info: #00e1ff;
  --tabbar-h: 64px; --rail-w: 72px; --radius: 12px;
  --font: -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #fdf3e0; --surface: #fffcf5; --surface-2: #fff7e6; --line: #e6d9bd;
    --ink: #10171a; --muted: #5b6a70; --accent: #bb6402; --accent-ink: #fff;
    --ok: #1f8f52; --warn: #b36b00; --bad: #c8232c; --info: #145069;
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.45 var(--font); }
a { color: var(--accent); }
h1, h2, h3 { line-height: 1.2; margin: 0 0 12px; }
h1 { font-size: 1.5rem; } h2 { font-size: 1.2rem; margin-top: 24px; } h3 { font-size: 1rem; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
p { margin: 0 0 8px; }
img { max-width: 100%; height: auto; }

/* --- shell -------------------------------------------------------------- */
.topbar { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 12px; padding: 8px 16px; padding-top: max(8px, env(safe-area-inset-top)); background: var(--surface); border-bottom: 1px solid var(--line); }
.topbar .brand { font-weight: 700; text-decoration: none; color: var(--ink); white-space: nowrap; }
.topbar .page-title { flex: 1; font-size: 1.1rem; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.topbar form { margin: 0; }
main { padding: 16px; max-width: 1200px; margin: 0 auto; overflow-x: hidden; }
.tabs { display: flex; gap: 2px; background: var(--surface); border-top: 1px solid var(--line); }
.tab { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; min-height: 44px; padding: 6px 4px; font-size: .75rem; color: var(--muted); text-decoration: none; position: relative; }
.tab .ico { font-size: 1.25rem; line-height: 1; }
.tab[aria-current="page"] { color: var(--accent); }
.tab .badge { position: absolute; top: 4px; right: calc(50% - 22px); }
.badge { display: inline-block; min-width: 18px; padding: 0 5px; border-radius: 9px; background: var(--accent); color: var(--accent-ink); font-size: .7rem; font-weight: 700; line-height: 18px; text-align: center; }
.badge.bad { background: var(--bad); color: #fff; }
.tab.more summary { list-style: none; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 2px; }
.tab.more summary::-webkit-details-marker { display: none; }
.tab.more a { display: block; padding: 12px 16px; color: var(--ink); text-decoration: none; min-height: 44px; }
@media (max-width: 639px) {
  .tabs { position: fixed; left: 0; right: 0; bottom: 0; z-index: 20; height: calc(var(--tabbar-h) + env(safe-area-inset-bottom)); padding-bottom: env(safe-area-inset-bottom); }
  main { padding-bottom: calc(var(--tabbar-h) + env(safe-area-inset-bottom) + 16px); }
  .tab.more[open] .menu { position: absolute; bottom: 100%; right: 0; min-width: 160px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius) var(--radius) 0 0; box-shadow: 0 -8px 24px rgba(0,0,0,.35); }
}
@media (min-width: 640px) {
  body { display: grid; grid-template-columns: var(--rail-w) 1fr; grid-template-rows: auto 1fr; grid-template-areas: "top top" "rail main"; min-height: 100vh; }
  .topbar { grid-area: top; }
  .tabs { grid-area: rail; flex-direction: column; justify-content: flex-start; border-top: 0; border-right: 1px solid var(--line); position: sticky; top: 0; height: 100vh; padding-top: 8px; }
  .tab { flex: 0 0 auto; }
  .tab.more summary { display: none; }
  .tab.more .menu a { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 6px 4px; font-size: .75rem; color: var(--muted); }
  main { grid-area: main; width: 100%; }
}
@media (min-width: 1024px) {
  :root { --rail-w: 200px; }
  .tab, .tab.more .menu a { flex-direction: row; justify-content: flex-start; gap: 10px; padding: 10px 16px; font-size: .95rem; }
  .tab .badge { position: static; margin-left: auto; }
}

/* --- cards & grid ----------------------------------------------------- */
.grid { display: grid; gap: 12px; grid-template-columns: 1fr; }
@media (min-width: 640px) { .grid { grid-template-columns: repeat(2, 1fr); } }
@media (min-width: 1024px) { .grid { grid-template-columns: repeat(3, 1fr); } }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; }
a.card { display: block; color: inherit; text-decoration: none; }
.card .label { color: var(--muted); font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
.stat { font-size: clamp(1.75rem, 6vw, 2.5rem); font-weight: 700; line-height: 1.1; }
.stat.bad { color: var(--bad); } .stat.ok { color: var(--ok); } .stat.warn { color: var(--warn); }
.bar { height: 8px; border-radius: 4px; background: var(--surface-2); overflow: hidden; margin: 8px 0; }
.bar > i { display: block; height: 100%; background: var(--ok); }
.bar.warn > i { background: var(--warn); } .bar.bad > i { background: var(--bad); }
.kv { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-top: 1px solid var(--line); }
.kv:first-of-type { border-top: 0; }
.kv .v { text-align: right; }
details.card > summary { cursor: pointer; font-weight: 600; }

/* --- chips ------------------------------------------------------------ */
.chip { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: .75rem; font-weight: 600; border: 1px solid currentColor; white-space: nowrap; }
.chip-ok { color: var(--ok); } .chip-warn { color: var(--warn); } .chip-bad { color: var(--bad); } .chip-info { color: var(--info); } .chip-muted { color: var(--muted); }
.chips { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; margin-bottom: 12px; }
.chips a { flex: 0 0 auto; padding: 8px 12px; border-radius: 999px; border: 1px solid var(--line); color: var(--ink); text-decoration: none; min-height: 40px; display: inline-flex; align-items: center; }
.chips a[aria-current="page"] { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }

/* --- tables ----------------------------------------------------------- */
.table-wrap { overflow-x: auto; }
table.rows { width: 100%; border-collapse: collapse; }
table.rows th, table.rows td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
table.rows th { color: var(--muted); font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
.mono { font-family: var(--mono); font-size: .85rem; }
td.mono { max-width: 12ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
td.wrap { white-space: normal; overflow-wrap: anywhere; }
@media (max-width: 639px) {
  table.rows thead { display: none; }
  table.rows, table.rows tbody, table.rows tr, table.rows td { display: block; width: 100%; }
  table.rows tr { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 6px 12px; margin-bottom: 10px; }
  table.rows td { display: flex; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--line); }
  table.rows td:last-child { border-bottom: 0; }
  table.rows td::before { content: attr(data-label); flex: 0 0 38%; color: var(--muted); font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
  table.rows td:not([data-label])::before { display: none; }
  td.mono { max-width: none; white-space: normal; overflow-wrap: anywhere; }
}

/* --- forms & buttons -------------------------------------------------- */
form { margin: 0 0 12px; }
label { display: block; margin-bottom: 6px; color: var(--muted); font-size: .9rem; }
input:not([type=checkbox]):not([type=hidden]), select, textarea { width: 100%; font: inherit; font-size: 16px; color: var(--ink); background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; min-height: 44px; }
textarea { min-height: 8rem; font-family: var(--mono); font-size: .9rem; }
input[type=checkbox] { width: 24px; height: 24px; accent-color: var(--accent); }
button, .btn { font: inherit; font-weight: 600; min-height: 44px; padding: 10px 18px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface-2); color: var(--ink); cursor: pointer; }
button.primary, .btn.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
button.danger, .btn.danger { background: transparent; color: var(--bad); border-color: var(--bad); }
button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.seg { display: inline-flex; gap: 0; }
.seg button { border-radius: 0; }
.seg button:first-child { border-radius: 10px 0 0 10px; } .seg button:last-child { border-radius: 0 10px 10px 0; }
.toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.toggle label { margin: 0; color: var(--ink); font-size: 1rem; }
html.js .js-hide { display: none; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.actions form { margin: 0; }
.actions.sticky { position: sticky; bottom: 0; z-index: 10; background: var(--surface); border-top: 1px solid var(--line); margin: 16px -16px 0; padding: 12px 16px; }
@media (max-width: 639px) { .actions.sticky { bottom: calc(var(--tabbar-h) + env(safe-area-inset-bottom)); } }

/* --- misc ------------------------------------------------------------- */
pre { background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow-x: auto; max-height: 50vh; font-family: var(--mono); font-size: .85rem; }
section { margin-bottom: 20px; }
.message { border: 1px solid var(--line); border-radius: var(--radius); padding: 12px; margin-bottom: 10px; background: var(--surface); }
.message-outbound { border-color: var(--accent); }
.listing-images { display: flex; gap: 8px; overflow-x: auto; }
.listing-images img { height: 120px; width: auto; border-radius: 8px; }
.login { max-width: 420px; margin: 10vh auto; }
.empty { color: var(--muted); }
`

/**
 * Progressive enhancement only — without it every form still posts. (1) marks <html> as js-capable
 * so "Save" buttons on auto-submitting toggles can hide; (2) `data-confirm` forms ask before an
 * irreversible POST; (3) `data-autosubmit` forms submit on change.
 */
export const ADMIN_JS = `
document.documentElement.classList.add('js');
document.addEventListener('submit', function (e) {
  var f = e.target; if (f && f.dataset && f.dataset.confirm && !window.confirm(f.dataset.confirm)) e.preventDefault();
});
document.addEventListener('change', function (e) {
  var f = e.target && e.target.form; if (f && f.dataset && 'autosubmit' in f.dataset) f.requestSubmit ? f.requestSubmit() : f.submit();
});
`
```

- [ ] **Step 4: `nav.ts`**

```ts
import { proposals, supportTickets, type createDb } from '@doge-buddy/db'
import { count, eq } from 'drizzle-orm'
import type { NavCounts } from './html.ts'

type Db = ReturnType<typeof createDb>['db']

/**
 * The two tab-bar badges, loaded once per authed page render (`routes.ts`'s `page()` helper).
 * Never throws: a badge is not worth a 500, so any failure degrades to zeros.
 */
export async function loadNavCounts(db: Db): Promise<NavCounts> {
  try {
    const [pending, escalated] = await Promise.all([
      db.select({ value: count() }).from(proposals).where(eq(proposals.status, 'pending')),
      db.select({ value: count() }).from(supportTickets).where(eq(supportTickets.status, 'escalated')),
    ])
    return { pendingProposals: pending[0]?.value ?? 0, escalatedTickets: escalated[0]?.value ?? 0 }
  } catch {
    return { pendingProposals: 0, escalatedTickets: 0 }
  }
}
```

- [ ] **Step 5: `html.ts`** — keep `RawHtml`, `raw`, `esc`, `render`, `html` untouched; replace everything from `const NAV = …` down with:

```ts
import { ADMIN_CSS, ADMIN_JS } from './styles.ts'

export interface NavCounts { pendingProposals: number; escalatedTickets: number }
export interface Shell { path: string; counts: NavCounts }

/** Tab bar / rail items in display order. `more` items live under the "More" cell on phones. */
export const NAV_ITEMS = [
  { href: '/admin', label: 'Home', ico: '⌂' },
  { href: '/admin/proposals', label: 'Proposals', ico: '✓' },
  { href: '/admin/tickets', label: 'Tickets', ico: '✉' },
  { href: '/admin/orders', label: 'Orders', ico: '▤' },
  { href: '/admin/runs', label: 'Runs', ico: '⟳', more: true },
  { href: '/admin/settings', label: 'Settings', ico: '⚙', more: true },
  { href: '/admin/guidance', label: 'Guidance', ico: '☰', more: true },
] as const

const LOGOUT_FORM = html`<form method="post" action="/admin/logout"><button type="submit">Log out</button></form>`

function isCurrent(href: string, path: string): boolean {
  return href === '/admin' ? path === '/admin' : path === href || path.startsWith(`${href}/`) || path.startsWith(`${href}?`)
}

function badgeFor(href: string, counts: NavCounts): RawHtml {
  if (href === '/admin/proposals' && counts.pendingProposals > 0) return html`<span class="badge">${counts.pendingProposals}</span>`
  if (href === '/admin/tickets' && counts.escalatedTickets > 0) return html`<span class="badge bad">${counts.escalatedTickets}</span>`
  return html``
}

function renderTabs(shell: Shell): RawHtml {
  const tab = (item: (typeof NAV_ITEMS)[number]) =>
    html`<a class="tab" href="${raw(item.href)}"${raw(isCurrent(item.href, shell.path) ? ' aria-current="page"' : '')}><span class="ico">${item.ico}</span>${item.label}${badgeFor(item.href, shell.counts)}</a>`
  const main = NAV_ITEMS.filter((i) => !('more' in i)).map(tab)
  const more = NAV_ITEMS.filter((i) => 'more' in i).map(tab)
  return html`<nav class="tabs" aria-label="Admin">${main}<details class="tab more"><summary><span class="ico">⋯</span>More</summary><div class="menu">${more}</div></details></nav>`
}

/**
 * The page frame. `shell` (current path + badge counts) is passed by `routes.ts`'s `page()` for
 * every authed page and omitted for the login pages, which get the same stylesheet but no tabs.
 * The stylesheet and the tiny script are inlined: no static route, no CDN, no CSP to negotiate.
 */
export function layout(title: string, body: RawHtml, shell?: Shell): string {
  return html`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#10171a" media="(prefers-color-scheme: dark)"><meta name="theme-color" content="#fdf3e0" media="(prefers-color-scheme: light)"><title>${title}</title><style>${raw(ADMIN_CSS)}</style></head><body>
    <header class="topbar"><a class="brand" href="/admin">🐶 Doge Buddy</a><h1 class="page-title">${title}</h1>${LOGOUT_FORM}</header>
    ${shell ? renderTabs(shell) : html``}
    <main>${body}</main>
    <script>${raw(ADMIN_JS)}</script>
  </body></html>`.value
}

export type ChipTone = 'ok' | 'warn' | 'bad' | 'info' | 'muted'

const CHIP_TONES: Record<string, ChipTone> = {
  // proposals
  pending: 'warn', approved: 'info', applying: 'info', applied: 'ok', rejected: 'bad', expired: 'muted', failed: 'bad',
  // tickets
  new: 'warn', triaged: 'warn', awaiting_approval: 'warn', waiting_on_customer: 'info', resolved: 'ok', escalated: 'bad', spam: 'muted',
  // supplier orders
  created: 'info', confirmed: 'info', paid: 'ok', shipped: 'ok', delivered: 'ok', cancelled: 'muted', needs_attention: 'bad', awaiting_funds: 'warn',
  // agent runs
  running: 'info', succeeded: 'ok', aborted: 'bad',
  // switches
  ON: 'bad', OFF: 'muted', auto: 'info', manual: 'muted',
}

export function chipTone(state: string): ChipTone {
  return CHIP_TONES[state] ?? 'muted'
}

/** A colored status pill. The state text itself is still in the markup, so text assertions hold. */
export function chip(state: string): RawHtml {
  return html`<span class="chip chip-${raw(chipTone(state))}">${state}</span>`
}

/** 'never' | 'just now' | 'Nm ago' | 'Nh ago' | 'Nd ago' — never negative (clock skew reads as 'just now'). */
export function relativeTime(date: Date | null, now: Date = new Date()): string {
  if (!date) return 'never'
  const s = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}
```
Note `pending` proposals chip tone `warn` vs the ticket `new` — both warn; fine. `ON` maps to `bad` because ON for the kill switch / paused-for-funds is the alarming state — the dashboard uses `chip` for those two only.

- [ ] **Step 6: Run tests** — `pnpm --filter @doge-buddy/ops test test/admin-html.test.ts test/admin-nav.test.ts` → all pass. Then the whole admin family: `pnpm --filter @doge-buddy/ops test test/admin-` — the old `layout` test was replaced; everything else must still pass (no caller passes a shell yet, so no tabs render — existing `href="/admin/…"` assertions in other tests may rely on the nav links! Check: `grep -n 'href="/admin' test/admin-*.test.ts`; if any test asserts a nav link on a page, that test is satisfied again in Task 2 when `page()` supplies the shell — run the full admin family at the END of Task 2, not here, and note in the report which tests went red in between).
- [ ] **Step 7: Typecheck + commit** — `pnpm --filter @doge-buddy/ops typecheck`; `git add apps/ops/src/http/admin/styles.ts apps/ops/src/http/admin/nav.ts apps/ops/src/http/admin/html.ts apps/ops/test/admin-html.test.ts apps/ops/test/admin-nav.test.ts && git commit -m "feat(admin): design system, mobile shell with tab badges, chip/relativeTime helpers"`.

---

### Task 2: `page()` helper on every authed page + `returnTo` on settings POST

**Files:**
- Modify: `apps/ops/src/http/admin/routes.ts`, `apps/ops/test/admin-settings.test.ts`

**Interfaces (consumes):** `layout(title, body, shell?)`, `loadNavCounts(db)` from Task 1.

- [ ] **Step 1: Failing tests** — append to `apps/ops/test/admin-settings.test.ts` (use the file's existing `login()`/cookie helper and `FORM_HEADERS`; restore `killswitch.global` in the file's afterEach as it already does):

```ts
  it('POST /admin/settings honours returnTo=/admin and falls back to /admin/settings for anything else', async () => {
    const cookie = await login()
    const home = await app.inject({ method: 'POST', url: '/admin/settings', headers: { ...FORM_HEADERS, cookie }, payload: 'key=killswitch.global&value=on&returnTo=%2Fadmin' })
    expect(home.statusCode).toBe(303)
    expect(home.headers.location).toBe('/admin')
    const evil = await app.inject({ method: 'POST', url: '/admin/settings', headers: { ...FORM_HEADERS, cookie }, payload: 'key=killswitch.global&returnTo=https%3A%2F%2Fevil.example' })
    expect(evil.statusCode).toBe(303)
    expect(evil.headers.location).toBe('/admin/settings')
  })

  it('every authed page carries the tab shell with badge counts; login pages do not', async () => {
    const cookie = await login()
    const res = await app.inject({ method: 'GET', url: '/admin/settings', headers: { cookie } })
    expect(res.body).toContain('class="tabs"')
    expect(res.body).toMatch(/<a class="tab" href="\/admin\/settings" aria-current="page">/)
    const loginPage = await app.inject({ method: 'GET', url: '/admin/login' })
    expect(loginPage.body).not.toContain('class="tabs"')
    expect(loginPage.body).toContain('<style>')
  })
```

- [ ] **Step 2: Run, verify they fail.**

- [ ] **Step 3: `page()` helper** — in `routes.ts`, inside the authed scope right after `safeHandle` is defined, add:

```ts
      /**
       * Every authed page goes through here so the tab shell (current path + badge counts) is on
       * all of them. `path` is the tab-matching path — pass the request's `url` (query string and
       * `/:id` suffixes are handled by `layout`'s prefix match).
       */
      async function page(title: string, body: RawHtml, path: string): Promise<string> {
        return layout(title, body, { path, counts: await loadNavCounts(deps.db) })
      }
```
Import `loadNavCounts` from `./nav.ts`. Then convert EVERY `layout(` call inside the authed scope (line ≥ 411 today; the four login routes and `safeHandleLogin` keep plain `layout`) to `await page(title, body, request.url)` — including the error/not-found/bad-request bodies (`'Not found.'`, `'Unknown setting.'`, `'Invalid target.'`, …) and `safeHandle`'s own fallback (use `'/admin'` as its path; it has no request in scope — add a `path` parameter defaulting to `'/admin'` if you prefer, but do not change its signature for existing callers). Handlers that use `_request` must rename it to `request`. Mechanical rule: `layout(X, Y)` → `await page(X, Y, request.url)`.

- [ ] **Step 4: `returnTo`** — in `POST /admin/settings`, read `returnTo` from the body alongside `key`/`value`:
```ts
          const body = (request.body ?? {}) as { key?: string; value?: string; returnTo?: string }
          …
          const returnTo = body.returnTo === '/admin' ? '/admin' : '/admin/settings'
          return reply.code(303).header('location', returnTo).send()
```
- [ ] **Step 5: Run** `pnpm --filter @doge-buddy/ops test test/admin-` (the whole admin family) and `typecheck` → all green (this is where any Task 1 Step 6 reds from missing nav links come back).
- [ ] **Step 6: Commit** — `git commit -am "feat(admin): page() helper puts the tab shell on every authed page; settings POST returnTo"`.

---

### Task 3: Control center home — `health.ts` extension + `render-dashboard.ts`

**Files:**
- Create: `apps/ops/src/http/admin/render-dashboard.ts`
- Modify: `apps/ops/src/http/admin/health.ts`, `apps/ops/src/http/admin/routes.ts` (move `renderHealthStrip` out; `/admin` handler), `apps/ops/src/sourcing/pipeline.ts` (export `SOURCING_WORKFLOW`), `apps/ops/test/admin-dashboard.test.ts`

**Interfaces (produces):**
```ts
// health.ts — HealthStrip gains:
escalatedTickets: number; ordersNeedsAttention: number
sourcingLastRun: { status: string; startedAt: Date } | null
inventorySyncLastAt: Date | null; inventorySyncDegraded: boolean
activeProducts: number; trackedVariants: number
latestListing: { title: string; handle: string | null; createdAt: Date } | null
modes: { sourcing: WorkflowMode; supportReply: WorkflowMode; refund: WorkflowMode; deprecation: WorkflowMode }
// render-dashboard.ts
export function renderHealthStrip(h: HealthStrip): RawHtml   // moved from routes.ts, byte-identical output
export function renderDashboard(h: HealthStrip, now?: Date): RawHtml
// pipeline.ts
export const SOURCING_WORKFLOW = 'sourcing.weekly'
```

- [ ] **Step 1: Failing tests** — append to `admin-dashboard.test.ts` inside the main `describe`. The file already has `makeDeps`, `loginAndGetCookie(app, deps)`, `seedAgentRun(workflow, status)` (the `db.insert(agentRuns).values({ workflow, status })` helper at ~line 138), `seedAgentRunAuditRow`, the `createdProposalIds/createdRunIds/createdAuditLogIds/createdProductIds` cleanup lists and `VALID_NEW_LISTING_PAYLOAD`. Add cleanup lists + helpers for tickets, orders and supplier orders (copy `seedOrder`/`seedSupplierOrder` from `admin-orders.test.ts` lines ~80–107, with their `afterEach` deletes: supplier_orders before orders) and `productVariants`. Then:

```ts
  async function seedTicket(status: 'escalated' | 'triaged') {
    const [row] = await db.insert(supportTickets).values({ customerEmail: `cc-${crypto.randomUUID()}@example.com`, subject: 'cc', status }).returning({ id: supportTickets.id })
    createdTicketIds.push(row!.id)
    return row!.id
  }

  it('control center: Needs-you cards link to the filtered lists with live counts', async () => {
    const deps = makeDeps()
    const app = buildServer(deps) // or however this file constructs the app — mirror the strip tests above
    const cookie = await loginAndGetCookie(app, deps)
    const [pending] = await db.insert(proposals).values({ type: 'new_listing', status: 'pending', summary: 'cc pending', payload: VALID_NEW_LISTING_PAYLOAD, sourceWorkflow: 'test', expiresAt: new Date(Date.now() + 3_600_000) }).returning({ id: proposals.id })
    createdProposalIds.push(pending!.id)
    await seedTicket('escalated')
    const order = await seedOrder()
    await seedSupplierOrder({ orderId: order.id, status: 'needs_attention' })

    const res = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<a class="card" href="/admin/proposals?status=pending">')
    expect(res.body).toMatch(/Pending proposals<\/div><div class="stat bad">[1-9]\d*</)
    expect(res.body).toContain('<a class="card" href="/admin/tickets?status=escalated">')
    expect(res.body).toMatch(/Escalated tickets<\/div><div class="stat bad">[1-9]\d*</)
    expect(res.body).toContain('<a class="card" href="/admin/orders">')
    expect(res.body).toMatch(/Orders needing attention<\/div><div class="stat bad">[1-9]\d*</)
    // the verbatim strip survives inside the details block
    expect(res.body).toContain('<summary>System status (text)</summary>')
    expect(res.body).toContain('Pending proposals: ')
    await app.close()
  })

  it('control center: switches post to /admin/settings with returnTo=/admin, the kill switch asks first, modes are segmented', async () => {
    const deps = makeDeps()
    const app = buildServer(deps)
    const cookie = await loginAndGetCookie(app, deps)
    const res = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })
    expect(res.body).toContain('<input type="hidden" name="key" value="killswitch.global">')
    expect(res.body).toContain('<input type="hidden" name="returnTo" value="/admin">')
    expect(res.body).toContain('data-confirm="Turn the global kill switch ON? Every workflow stops."')
    expect(res.body).toContain('<input type="hidden" name="key" value="workflow.sourcing.mode">')
    expect(res.body).toContain('<button type="submit" name="value" value="manual" aria-pressed="true">manual</button>')
    expect(res.body).toContain('<button type="submit" name="value" value="auto" aria-pressed="false">auto</button>')
    await app.close()
  })

  it('control center: wallet bar tone — bad below threshold, warn under 2x, plain otherwise', async () => {
    for (const [cents, cls] of [[500, 'bar bad'], [3000, 'bar warn'], [9000, 'bar ']] as const) {
      const deps = makeDeps({ getWalletBalance: async () => ({ availableCents: cents, frozenCents: 0 }) })
      const app = buildServer(deps)
      const cookie = await loginAndGetCookie(app, deps)
      const res = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })
      expect(res.body).toContain(`<div class="${cls}">`)
      await app.close()
    }
  })

  it('control center: agents & jobs + catalog rows, without and with data', async () => {
    const deps = makeDeps()
    const app = buildServer(deps)
    const cookie = await loginAndGetCookie(app, deps)
    // The DB may hold other rows; assert on the rows this test controls via distinctive seeds.
    const [product] = await db.insert(products).values({ title: 'CC Latest Widget', handle: 'cc-latest-widget-abc12345', status: 'active' }).returning({ id: products.id })
    createdProductIds.push(product!.id)
    await db.insert(productVariants).values({ productId: product!.id, sku: `CC-${crypto.randomUUID()}`, priceCents: 1999, shopifyInventoryItemGid: 'gid://shopify/InventoryItem/1' })
    await seedAgentRun('sourcing.weekly', 'succeeded')
    const [synced] = await db.insert(auditLog).values({ actor: 'system', action: 'inventory.synced', entityType: 'product', entityId: product!.id, detail: {} }).returning({ id: auditLog.id })
    createdAuditLogIds.push(synced!.id)

    const res = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })
    expect(res.body).toContain('<span>Sourcing last run</span>')
    expect(res.body).toContain('<span class="chip chip-ok">succeeded</span>')
    expect(res.body).toContain('<span>Inventory sync</span>')
    expect(res.body).toContain('just now')
    expect(res.body).not.toContain('DEGRADED')
    expect(res.body).toContain('<a href="https://dogebuddy.com/products/cc-latest-widget-abc12345">CC Latest Widget</a>')
    expect(res.body).toContain('<div class="label">Tracked variants</div>')

    // a degraded alert newer than the last sync flips the chip on
    const [degraded] = await db.insert(auditLog).values({ actor: 'system', action: 'alert.inventory_sync_degraded', entityType: 'alert', detail: { severity: 'warning', failed: 3, attempted: 4 } }).returning({ id: auditLog.id })
    createdAuditLogIds.push(degraded!.id)
    const res2 = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })
    expect(res2.body).toContain('<span class="chip chip-bad">DEGRADED</span>')
    await app.close()
  })
```
Facts baked in (verified 2026-08-31): `alerts.ts` persists an alert as an `audit_log` row with `action = \`alert.${kind}\`` and `detail = { severity, ...detail }`; `products` has `handle`/`title`/`status`; `product_variants.sku` is NOT NULL UNIQUE and `price_cents` NOT NULL. Delete the seeded variant in `afterEach` BEFORE its product (`productVariants.productId in createdProductIds`). Check how this file builds `app` (it may use a `makeApp`/`buildServer(deps)` pattern — use exactly that).

- [ ] **Step 2: Run, verify they fail.**

- [ ] **Step 3: `SOURCING_WORKFLOW`** — in `sourcing/pipeline.ts` add `export const SOURCING_WORKFLOW = 'sourcing.weekly'` and use it in the `claimDailyRun` call (`workflow: SOURCING_WORKFLOW`).

- [ ] **Step 4: `health.ts`** — extend `HealthStrip` and `loadHealthStrip` with the new fields (all in the existing `Promise.all`; every loader degrades to null/0/false in try/catch like the existing ones). Queries:
  - `escalatedTickets`: `count()` from `supportTickets` where `status = 'escalated'`.
  - `ordersNeedsAttention`: `count()` from `supplierOrders` where `status = 'needs_attention'`.
  - `sourcingLastRun`: newest `agentRuns` row where `workflow = SOURCING_WORKFLOW` (import from `../../sourcing/pipeline.ts`), `{ status, startedAt }`.
  - `inventorySyncLastAt`: newest `auditLog.createdAt` where `action = 'inventory.synced'`.
  - `inventorySyncDegraded`: exists an audit row that `alerts.ts` writes for kind `inventory_sync_degraded` (read `alerts.ts` for the exact action/detail shape and filter with `sql` on the jsonb detail) with `createdAt > inventorySyncLastAt` (or any such row when `inventorySyncLastAt` is null).
  - `activeProducts`: `count()` from `products` where `status = 'active'`.
  - `trackedVariants`: `count()` from `productVariants` inner-joined to active `products`, where `shopifyInventoryItemGid is not null`.
  - `latestListing`: newest active product `{ title, handle, createdAt }` (`products.handle` — check the column name in `packages/db/src/schema.ts`; if there is no handle column, return `handle: null`).
  - `modes`: four `settings.get(...)` calls.

- [ ] **Step 5: `render-dashboard.ts`** — move `renderHealthStrip` here from `routes.ts` verbatim (it needs `formatCents` from `@doge-buddy/core` and `SUPPORT_AGENT_MAX_RUNS_PER_DAY`), and add:

```ts
const CATALOG_TARGET = 40 // build-week goal (docs/OWNER-CHECKLIST.md runway B14)

function statCard(label: string, value: number, href: string, opts: { zeroText?: string } = {}): RawHtml {
  const tone = value > 0 ? 'bad' : 'ok'
  return html`<a class="card" href="${raw(href)}"><div class="label">${label}</div><div class="stat ${raw(tone)}">${value}</div><div class="empty">${value > 0 ? 'tap to review' : (opts.zeroText ?? 'all clear')}</div></a>`
}

function walletCard(h: HealthStrip): RawHtml {
  if (h.walletCents === null) {
    return html`<div class="card"><div class="label">CJ wallet</div><div class="stat">n/a</div><div class="empty">wallet read unavailable</div></div>`
  }
  const ratio = h.walletAlertThresholdCents > 0 ? h.walletCents / h.walletAlertThresholdCents : 1
  const tone = ratio < 1 ? 'bad' : ratio < 2 ? 'warn' : 'ok'
  const pct = Math.max(0, Math.min(100, Math.round((ratio / 2) * 100)))
  return html`<div class="card"><div class="label">CJ wallet</div><div class="stat ${raw(tone)}">${formatCents(h.walletCents)}</div>
    <div class="bar ${raw(tone === 'ok' ? '' : tone)}"><i style="width:${raw(String(pct))}%"></i></div>
    <div class="empty">alert threshold ${formatCents(h.walletAlertThresholdCents)}${h.pausedForFunds ? html` · ${chip('ON')} paused for funds` : html``}</div></div>`
}

function toggleCard(label: string, key: string, on: boolean, confirmWhenOn?: string): RawHtml {
  const confirmAttr = confirmWhenOn && !on ? html` data-confirm="${confirmWhenOn}"` : html``
  return html`<div class="card"><form method="post" action="/admin/settings" data-autosubmit${confirmAttr}>
    <input type="hidden" name="key" value="${key}"><input type="hidden" name="returnTo" value="/admin">
    <div class="toggle"><label for="sw-${raw(key.replaceAll('.', '-'))}">${label}</label>
      <input type="checkbox" id="sw-${raw(key.replaceAll('.', '-'))}" name="value" value="on"${raw(on ? ' checked' : '')}></div>
    <button type="submit" class="js-hide">Save</button></form></div>`
}

function modeCard(label: string, key: string, current: 'manual' | 'auto'): RawHtml {
  const seg = (mode: 'manual' | 'auto') =>
    html`<button type="submit" name="value" value="${mode}" aria-pressed="${raw(String(current === mode))}">${mode}</button>`
  return html`<div class="card"><form method="post" action="/admin/settings"${key === 'workflow.refund.mode' ? html`` : html``}>
    <input type="hidden" name="key" value="${key}"><input type="hidden" name="returnTo" value="/admin">
    <div class="toggle"><label>${label}</label><span class="seg">${seg('manual')}${seg('auto')}</span></div></form></div>`
}

function kv(label: string, value: RawHtml | string, iso?: Date | null): RawHtml {
  const title = iso ? html` title="${iso.toISOString()}"` : html``
  return html`<div class="kv"><span>${label}</span><span class="v"${title}>${value}</span></div>`
}

export function renderDashboard(h: HealthStrip, now: Date = new Date()): RawHtml {
  const runLine = (run: { status: string; startedAt: Date } | null) => (run ? html`${chip(run.status)} ${relativeTime(run.startedAt, now)}` : html`never`)
  const catalogPct = Math.min(100, Math.round((h.activeProducts / CATALOG_TARGET) * 100))
  return html`
    <h2>Needs you</h2>
    <div class="grid">
      ${statCard('Pending proposals', h.pendingProposals, '/admin/proposals?status=pending')}
      ${statCard('Escalated tickets', h.escalatedTickets, '/admin/tickets?status=escalated')}
      ${statCard('Orders needing attention', h.ordersNeedsAttention, '/admin/orders')}
    </div>
    <h2>Money</h2>
    <div class="grid">${walletCard(h)}</div>
    <h2>Switches</h2>
    <div class="grid">
      ${toggleCard('Global kill switch', 'killswitch.global', h.killswitch, 'Turn the global kill switch ON? Every workflow stops.')}
      ${toggleCard('Fulfillment', 'workflow.fulfillment.enabled', h.fulfillmentEnabled)}
      ${modeCard('Sourcing', 'workflow.sourcing.mode', h.modes.sourcing)}
      ${modeCard('Support replies', 'workflow.support_reply.mode', h.modes.supportReply)}
      ${modeCard('Refunds', 'workflow.refund.mode', h.modes.refund)}
      ${modeCard('Deprecation', 'workflow.deprecation.mode', h.modes.deprecation)}
    </div>
    <h2>Agents &amp; jobs</h2>
    <div class="card">
      ${kv('Sourcing last run', runLine(h.sourcingLastRun), h.sourcingLastRun?.startedAt)}
      ${kv('Support agent today', html`${h.supportAgentRunsToday} / ${SUPPORT_AGENT_MAX_RUNS_PER_DAY}`)}
      ${kv('Support agent last run', runLine(h.supportAgentLastRun), h.supportAgentLastRun?.startedAt)}
      ${kv('Support poll', h.supportPollConsecutiveFailures > 0 ? html`${chip('failed')} ${h.supportPollConsecutiveFailures} failures` : html`${chip('ok')} ${relativeTime(h.supportPollLastSuccessAt, now)}`, h.supportPollLastSuccessAt)}
      ${kv('Scoring', h.scoringLastRunDate ? html`${h.scoringLastRunDate} · ${h.scoringProductsScored} scored` : 'never')}
      ${kv('Inventory sync', html`${relativeTime(h.inventorySyncLastAt, now)}${h.inventorySyncDegraded ? html` ${chip('DEGRADED')}` : html``}`, h.inventorySyncLastAt)}
      ${kv('Queue depth', String(h.queueDepth))}
      ${kv('Last webhook', relativeTime(h.lastWebhookAt, now), h.lastWebhookAt)}
    </div>
    <h2>Catalog</h2>
    <div class="grid">
      <div class="card"><div class="label">Active products</div><div class="stat">${h.activeProducts}</div>
        ${h.activeProducts < CATALOG_TARGET ? html`<div class="bar"><i style="width:${raw(String(catalogPct))}%"></i></div><div class="empty">${h.activeProducts} of ${CATALOG_TARGET} build-week target</div>` : html`<div class="empty">target reached</div>`}</div>
      <div class="card"><div class="label">Tracked variants</div><div class="stat">${h.trackedVariants}</div></div>
      <div class="card"><div class="label">Latest listing</div>
        ${h.latestListing ? html`<div>${h.latestListing.handle ? html`<a href="https://dogebuddy.com/products/${h.latestListing.handle}">${h.latestListing.title}</a>` : h.latestListing.title}</div><div class="empty">${relativeTime(h.latestListing.createdAt, now)}</div>` : html`<div class="empty">none yet</div>`}</div>
    </div>
    <details class="card"><summary>System status (text)</summary>${renderHealthStrip(h)}</details>`
}
```
Add `chipTone('DEGRADED')` → `'bad'` and `'ok'` → `'ok'` to `CHIP_TONES` in `html.ts` (one-line additions). The `/admin` handler becomes `await page('Home', renderDashboard(health), request.url)`; delete `renderHealthStrip` from `routes.ts` and its now-unused imports (`formatCents`, `SUPPORT_AGENT_MAX_RUNS_PER_DAY` if nothing else uses them — check).

- [ ] **Step 6: Run** `test/admin-dashboard.test.ts` (existing strip assertions must still pass — the strip is inside `<details>`; `'Killswitch: ON'` etc. are unchanged text) then the admin family + typecheck.
- [ ] **Step 7: Commit** — `git commit -am "feat(admin): control center home — needs-you, money, switches, agents & jobs, catalog cards"`.

---

### Task 4: Renderers — `data-label`, chips, classes, sticky actions, `data-confirm`

**Files:**
- Modify: `render-orders.ts`, `render-proposal.ts`, `render-run.ts`, `render-tickets.ts`, and the table/form markup inside `routes.ts` (`renderSettingRow`, `renderSignalPasteBox`, `renderRecentSignals`, the runs list table, the proposals list table, guidance form); tests `admin-proposals-pages.test.ts`, `admin-tickets.test.ts`, `admin-orders.test.ts`, `admin-runs.test.ts`.

- [ ] **Step 1: Failing tests** — one assertion per list page test file (find that file's existing "renders the list" test and add to it):
  - orders: `expect(res.body).toContain('<td data-label="Status">')` and `expect(res.body).toContain('<span class="chip chip-bad">needs_attention</span>')` and the recovery form's button has `class="primary"`.
  - proposals list: `<td data-label="Summary" class="wrap">`; proposal detail (pending new_listing): `<div class="actions sticky">`, `data-confirm="Approve this proposal?"` on the approve form, `<button type="submit" class="primary">Approve</button>`, `<button type="submit" class="danger">Reject</button>`.
  - tickets list: `<td data-label="Subject" class="wrap">`; filter nav is `<nav class="chips" id="ticket-filters">` and the active chip has `aria-current="page"`; ticket detail: `<div class="actions sticky">` and `data-confirm="Resolve this ticket?"`.
  - runs: `<td data-label="Workflow">` and `<span class="chip chip-ok">succeeded</span>` when a succeeded run is seeded.
- [ ] **Step 2: Run, verify they fail.**
- [ ] **Step 3: Edit renderers** (the rule everywhere: `<table>` → `<div class="table-wrap"><table class="rows"><thead><tr><th>…</th>…</tr></thead><tbody>…</tbody></table></div>`; every `<td>` gets `data-label="<the th text>"`; ids get `class="mono"`; free text cells get `class="wrap"`; bare status text → `chip(status)`; ISO timestamps in list cells → `relativeTime(d)` wrapped in `<span title="<iso>">` — **except** cells an existing test asserts by ISO string: grep the test files for `toISOString()` assertions first and keep those cells' text). Specifics:
  - **orders**: columns Id · Order · Customer · Supplier · Status · Last error · Created · Action. Recovery form: `<form class="actions" method="post" …>` with `<button type="submit" class="primary">Recover</button>`.
  - **proposals list** (`renderProposalRow` + the table in `routes.ts`): Id · Type · Status · Summary · Created · Expires; add a filter chip row above the table (`all` + each `PROPOSAL_STATUSES`, `?status=`), same `chips` markup as tickets.
  - **proposal detail**: header `<p>`s → a `.card` with `kv()`-style rows (status as `chip`); `renderDecisionForms`: wrap the approve + reject forms in `<div class="actions sticky">`; approve form gets `data-confirm="Approve this proposal?"` and `class="primary"` button; reject buttons `class="danger"`; "Approve edited" forms get `data-confirm="Approve the EDITED payload?"`; `renderResendForm` gets `data-confirm="Re-send the apply job?"`. The variants table gets the `rows` treatment.
  - **run list/detail**: list columns Id · Workflow · Status · Cost · Turns · Created · Finished; detail header → `.card` with `kv` rows; events keep `<details>` + `<pre>`.
  - **tickets list**: columns Status · Category · Sentiment · Customer · Subject · Order · Last contact; `renderStatusChips` → `<nav class="chips" id="ticket-filters">` with `aria-current="page"` on the active chip instead of `<strong>`; the `via contact form` badge keeps its text. Detail: header → `.card`; `renderActionForms` → `<div class="actions sticky">` with `data-confirm="Escalate this ticket?"` (`class="danger"`) and `data-confirm="Resolve this ticket?"` (`class="primary"`); proposals table gets `rows`; messages keep their classes.
  - **routes.ts settings**: `renderSettingRow` → `<form class="card toggle-row" …>` with the label first, number inputs keep a visible Save (`class="primary"`); boolean/mode rows add `data-autosubmit` and `class="js-hide"` on Save. Recent-signals table → `rows` + labels. Signal paste form: labels above inputs. Guidance textarea: drop `cols`, keep `rows`. Runs list table → `rows`.
  - **login pages**: wrap bodies in `<div class="login card">` with `class="primary"` buttons.
- [ ] **Step 4: Run the whole admin family + typecheck.** Any pre-existing test that broke on a timestamp/format change means Step 3 changed a cell it should not have — revert that cell, do not edit the old test.
- [ ] **Step 5: Commit** — `git commit -am "feat(admin): responsive tables, status chips, sticky actions, confirm on irreversible posts"`.

---

### Task 5: Visual verification at 380 / 800 / 1280 px + fixes

**Files:** none committed except fixes to the files above; a throwaway script in the session scratchpad.

- [ ] **Step 1**: start the ops server against the local DB with seeded data — run `pnpm --filter @doge-buddy/ops seed-store`? No: that needs Shopify creds. Instead seed directly: one pending `new_listing` proposal (use `scripts/seed-proposal.ts`'s payload shape via a tiny scratchpad script inserting into `proposals`), one escalated ticket with two messages, one `needs_attention` supplier order (+ parent order), one succeeded `sourcing.weekly` agent run. Start `pnpm --filter @doge-buddy/ops dev` (note its port from the log; login is by magic link — with no Telegram configured the link is printed to the console by the capture/console notifier; use it).
- [ ] **Step 2**: Playwright script (`playwright` is resolvable from the repo root's `node_modules`; use `chromium.launch()` with the installed build) that logs in once, then for each of `/admin`, `/admin/proposals`, the proposal detail, `/admin/tickets`, the ticket detail, `/admin/orders`, `/admin/settings`, `/admin/runs` takes full-page screenshots at viewports `380×820`, `800×900`, `1280×900`, both color schemes for `/admin` (`colorScheme: 'dark' | 'light'`). Also assert `document.documentElement.scrollWidth <= window.innerWidth` on every page/width and print any violation.
- [ ] **Step 3**: read every screenshot (the Read tool renders PNGs). Fix what is wrong (overflow, unreadable contrast, tab bar covering the sticky actions, badges misplaced, the More menu opening the wrong way). Re-run until clean. Typical fixes belong in `styles.ts`.
- [ ] **Step 4**: `pnpm --filter @doge-buddy/ops test test/admin-` + typecheck; commit fixes as `fix(admin): visual pass at 380/800/1280`. Record the screenshot paths in the task report so the reviewer can look.

---

### Task 6: Docs

- [ ] Add to `docs/OWNER-CHECKLIST.md` under runway A/housekeeping (or the "done" list) one item: "Admin redesigned for the Fold (2026-08-31): open `/admin` on the cover screen — bottom tabs with badges, switches on the home page flip settings in one tap (kill switch asks first). Report anything that overflows or is too small to tap." Update the footer pointer. Commit `docs(checklist): admin control center shipped`.

---

## Self-review notes (writer)

- Spec coverage: §1 → T1; §2 → T1+T2; §3 → T3; §4 → T4; §5 → tests in every task + T5 visual; §6 file map matches.
- Type consistency: `Shell`/`NavCounts` (T1) consumed by T2/T3; `chip`/`relativeTime` (T1) by T3/T4; `SOURCING_WORKFLOW` (T3) by `health.ts`; `HealthStrip.modes` typed with `WorkflowMode` from `settings.ts`.
- Known open point for the implementer of T3: `products.handle` column existence and `alerts.ts`'s audit-row shape — both are "read the file first" instructions, not guesses baked into code.
