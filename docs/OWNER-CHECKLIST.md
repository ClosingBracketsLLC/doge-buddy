# Robert's Checklist

Things only you can do, with **explicit blocker status**. Build work continues regardless — nothing here stops Claude from writing and testing code against fixtures and the mock supplier. Items are ordered by when they'll be needed.

Legend: 🔴 **BLOCKER** (something specific stalls until done) · 🟡 soon (needed to *verify live*, not to build) · ⚪ later phase.

---

## Now / this week

- [ ] 🟡 **`git push origin main`** — main is **37 commits ahead of origin** (all Phase 5: the planning docs + the 34 implementation commits; Phase 4 is already pushed). Your push (Claude's are permission-blocked). This is what makes Railway/CI/Oxygen build the sourcing agent.
- [ ] 🟡 **`SERPAPI_KEY` → Railway variables** — needed before the weekly sourcing cron's trends stage works live. `ANTHROPIC_API_KEY` is already in Railway; this is the last env var. (Without it the run still completes — it just skips Google Trends and logs a warning.)
- [ ] 🟡 **Phase 5 Tier-2 walk (first live sourcing run)** — after the push + Railway redeploy, trigger one manual run against the real APIs: `DATABASE_URL=<railway pg> pnpm --filter @doge-buddy/ops run-sourcing --force` (run it wherever it can reach Railway's Postgres + the keys; or run it on Railway). Expect: an `agent_runs` row at `/admin/runs/:id` with real cost ≤ $2, CJ points < 25k, ≤10 SerpApi requests, and **1–3 real product proposals arriving on your phone** with working approve/reject. Approving one through to an ACTIVE product re-proves the whole loop end-to-end with agent-sourced data (and records the CJ product-webhook wire shape live — the one still-unverified CJ endpoint). This is Phase 5's live exit criterion; nothing auto-fires it (the cron is armed for Mondays 13:00 UTC, but `--force` lets you test now without waiting).

- [x] ~~Merge the Phase 0 PR.~~ **Done differently (2026-08-18):** Phases 0, 1, and 2 were merged into local `main` directly at your request (all suites green). Pushed to origin and the stale feature branches are gone from the remote (verified 2026-08-23). *New, standing note:* local `main` accumulates commits between pushes and Claude's pushes are permission-blocked — run `git push origin main` when Claude asks so Railway/CI/Oxygen build current code. (As of 2026-08-24 the repo's **CI is green for the first time** and the **first Oxygen deploy succeeded** — preview URL lives in the Hydrogen channel UI under the storefront's Deployments.)

- [x] ~~Test Shopify store: API credentials.~~ **Done (2026-08-23):** Robert created a Shopify Partner account + client-transfer store (`doge-buddy-1b9crsev.myshopify.com`, custom domain `dogebuddy.com`), created custom-distribution app `doge-buddy` via the Dev Dashboard, and set scopes through Versions → Create version (the Dev Dashboard doesn't expose scopes as a direct settings toggle). `apps/ops/.env` is filled in. `verify-live` prints `SHOPIFY OK` (token round-trip, listPublications, scripted DRAFT-product create/cleanup all pass against the real store). Note: `SHOPIFY_SHOP_DOMAIN` must be the `*.myshopify.com` domain, not the custom domain — the custom domain 301-redirects `/admin/oauth/access_token`, which turns the POST into a GET and breaks the token exchange.

- [x] ~~CJ Dropshipping account + API key.~~ **Done (2026-08-23):** CJ moved API access behind an installable app (Apps → Install App → **API** app under "Others" → Add API → Type: API Key) — there's no direct "Authorization" menu anymore. `CJ_OPEN_ID` doesn't appear anywhere in the dashboard UI either; it's the account's numeric `openId`, only obtainable by authenticating with `CJ_API_KEY` and calling `GET /setting/get`. `apps/ops/.env` is filled in (`CJ_API_KEY`, `CJ_OPEN_ID=47491`). `verify-live` prints `CJ OK` (token round-trip + `getBalance`). Also had to `pnpm db:up` + `DATABASE_URL=... pnpm --filter @doge-buddy/db migrate` — local dev Postgres wasn't running yet, unrelated to the CJ credentials themselves.
  *Check:* once `.env` is filled in, run `pnpm --filter @doge-buddy/ops verify-live` — the CJ section should print `CJ OK`.

- [x] ~~CJ key → re-record `order/list` fixtures, then run the full-pipeline sandbox contract check (Phase 3 Tier 2).~~ **Done (2026-08-23):** all CJ fixtures re-recorded from real responses and the full 9-case contract suite now passes live against the CJ sandbox (place → confirm → pay → advance → track → dispute). The unverified fixtures turned out to be wrong in ways that mattered — see `docs/cj-api-notes.md` for the full list, including a **real-money bug**: `placeOrder` sent `sandbox: true`, which CJ ignores, so every "sandbox" order would have been a real chargeable order.
  *Re-run:* `CJ_CONTRACT=1 CJ_API_KEY=<from apps/ops/.env> CJ_OPEN_ID=47491 CJ_CONTRACT_VID=<a real CJ variant id> pnpm --filter @doge-buddy/supplier test` — the CJ_API_KEY/CJ_OPEN_ID exports are load-bearing: the supplier package does **not** read `apps/ops/.env`, and without `CJ_API_KEY` the suite silently skips and prints green. Places fresh sandbox orders each run.

- [x] ~~Ask Shopify support about the launch-store type.~~ **Skipped by choice (2026-08-23):** Robert created a Shopify Partner account and a client-transfer store directly, without confirming with Shopify support first — his call, his store, willing to eat any cost if the transfer assumption turns out wrong. This store is now doing double duty as both the dev/test store (item below) and the intended Phase 7 launch store.

## Phase 1–3 window

- [x] ~~Railway account + deploy ops.~~ **Done (2026-08-23):** ops + Postgres live at `https://doge-buddyops-production.up.railway.app` — healthz green (`db:ok, queue:ok`), demo job processed on the deployed instance (**Phase 0 exit criterion closed**), and the webhook-audit cron self-registered all three Shopify webhook topics (ORDERS_PAID, ORDERS_CANCELLED, REFUNDS_CREATE) at the Railway URL. *Follow-up closed same day:* CJ webhooks are registered and **proven end-to-end live** — the diagnostic capture revealed the signature rides in the `sign` header (fixed in 2a2e0e5), registration then succeeded, and real sandbox-order events flowed CJ → HMAC verified → recorded → processed on the deployed instance. Nothing on the CJ adapter remains unverified except dispute-write bodies and STOCK/PRODUCT event shapes.

- [x] ~~Hydrogen channel + Oxygen for the test store.~~ **Done (2026-08-24):** channel installed, storefront `doge-buddy` (id 1000173017) created, GitHub connected (Shopify auto-PR'd its Oxygen workflow — which assumed a single-repo npm project and was adapted to the pnpm monorepo in 8a0734d), env vars in gitignored `apps/storefront/.env`. **Verified live:** local storefront serves the real store, and the Phase-4-pipeline product (Dog Snuff Pad, `DB-SNUFFPAD-01`, $29.99) renders on its product page with Shopify-CDN images — closing Phase 4's storefront-visibility check in its local form. *All sub-items closed 2026-08-24:* `PUBLIC_CHECKOUT_DOMAIN` set (the store's own myshopify domain — standard for dev stores), the **test payment gateway activated** (Shopify's current name for the legacy "Bogus Gateway" — same thing), and the first Oxygen deploy succeeded on push.

- [x] ~~Phase 4 Tier-2 verification.~~ **Done (2026-08-24) — closed by Robert's thumb.** The full production path ran live: seeded proposal → Telegram message with buttons → phone tap → deployed confirm page → form POST → guarded approval (`decided_by: owner`) → deployed apply worker → real ACTIVE product `gid://shopify/Product/8947876659288` with its CJ fulfillment mapping. The first tap surfaced a real bug (Fastify has no urlencoded parser, so real browser form submits 415'd — invisible to tests/curl, which send no Content-Type; fixed in 7efd26f with a regression test). Second Dog Snuff Pad listing on the store is the proof artifact — delete either duplicate via admin whenever. **Phase 4 Plan A is complete on every tier.**

- [ ] 🟡 **Phase 4B Tier-2 verification** — after the next push + Railway redeploy, visit
  `https://doge-buddyops-production.up.railway.app/admin/login` on your phone, tap the button to
  request a login link, tap the Telegram login link when it arrives, and walk the
  dashboard/proposals/orders/settings pages. Then approve one seeded proposal from the dashboard
  (not the old one-click Telegram link) — seed one first with
  `pnpm --filter @doge-buddy/ops seed-proposal` run against the Railway DB (`DATABASE_URL` set to
  the Railway Postgres connection string), then find it on `/admin/proposals` and approve it from
  there. Closes Phase 4 Plan B's live tier.

- [ ] ⚪ **Rotate the Railway Postgres password** (Settings on the Postgres service → regenerate credentials) — the public `DATABASE_PUBLIC_URL` was pasted into the Claude chat log during deploy verification (2026-08-23). Low urgency, private log, but hygiene says rotate. Claude's local verification scripts will need the new value if you want DB checks re-run afterward.

## Later phases (no action yet — listed so nothing surprises you)

- [x] ~~Anthropic API key.~~ **Done (2026-08-24):** key in `apps/ops/.env`, validated against the API (free `count_tokens` probe), **and added to Railway's variables same day**. *Optional remaining sub-step:* a workspace spend limit in the Anthropic console (~$15/mo hard cap comfortably covers the approved $2.00/run weekly sourcing budget).
- [x] ~~SerpApi account (Google Trends bridge for Phase 5).~~ **Done (2026-08-24):** free-tier account created, `SERPAPI_KEY` in gitignored `apps/ops/.env`, validated against the account endpoint (Free Plan, 250 searches/mo, 250 left — the weekly run uses ~18–45/wk). *Remaining sub-step before Phase 5's live runs on Railway:* add `SERPAPI_KEY` to Railway's variables.
- [ ] ⚪ **Domain name decision** + DNS access (Phase 6 email, Phase 7 launch). You said you own one — tell Claude which. 🔴 blocks Google Workspace setup and launch cutover.
- [ ] ⚪ **Google Workspace** (support@ user, ~$7/mo) **+ GCP project** with service account & domain-wide delegation (Phase 6). 🔴 blocks the support agent going live.
- [ ] ⚪ **FunkyDori webfont license check** (Phase 2). Not a blocker — Lilita One is the stand-in display face (the `--font-display` token in tailwind.css is the FunkyDori swap point); Poppins is the body face.
- [x] ~~Apply for the Google Trends official API alpha.~~ **Applied (2026-08-24).** Approval is slow (months-to-never per applicant reports) — SerpApi bridges it meanwhile; the Phase 5 trends adapter is swappable, so approval landing later is a drop-in.
- [ ] ⚪ **CJ wallet top-up ~$150** (Phase 7 canary). 🔴 blocks the first real order. Top-up is manual only — no API.
- [ ] ⚪ **Policy pages → Shopify Settings** (Phase 7). Paste `apps/storefront/app/content/policies.tsx` copy into Shopify Settings → Policies and review/finalize before launch.
- [ ] ⚪ **Business checks before launch** (Phase 7): Shopify Payments setup, US tax registrations in Shopify Tax, general liability insurance for the LLC (recommended), policy pages review.

- [ ] ⚪ **Store-transfer gotchas to re-verify at Phase 7 cutover** (carried from the never-sent Shopify support question, since the client-transfer path was taken unconfirmed): whether app installs + Admin API credentials, custom domains, and Shopify Payments configuration survive the transfer to your merchant account — budget time to re-create the `doge-buddy` app and re-issue credentials if they don't.

---

*Maintained by Claude; last updated 2026-08-24 (Phase 5 sourcing agent merged to local `main` at `ab98b57`). When you complete an item, check it off and tell Claude — especially the credential items, so live verification can run.*

**Next build session starts here →** **Phase 5 (sourcing agent) is COMPLETE and merged to local `main`** (34 commits, `ab98b57`; spec `docs/superpowers/specs/2026-08-24-phase-5-sourcing-agent-design.md`, plan `docs/superpowers/plans/2026-08-24-phase-5-sourcing-agent.md`). All 16 tasks passed adversarial per-task review; a final 5-lens whole-branch review found + fixed 5 cross-cutting defects (notably a freight-quoted-from-CN bug that would have dropped every winner on a live run). Full monorepo suite green on the merged tree (796 tests, typecheck clean). **Open before it runs live:** the three 🟡 items at the top (push, `SERPAPI_KEY`→Railway, the Tier-2 live run). **Next phase:** Phase 6 (support agent) — needs the Google Workspace + GCP + domain items in "Later phases" below; or Phase 7 launch prep. Phase 4's Tier-2 admin-dashboard walk (item above) is also still open.
