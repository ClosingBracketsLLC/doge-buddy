# Robert's Checklist

Things only you can do, with **explicit blocker status**. Build work continues regardless — nothing here stops Claude from writing and testing code against fixtures and the mock supplier. Items are ordered by when they'll be needed.

Legend: 🔴 **BLOCKER** (something specific stalls until done) · 🟡 soon (needed to *verify live*, not to build) · ⚪ later phase.

---

## Now / this week

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

- [ ] ⚪ **Anthropic API key** (Phase 5 — sourcing agent). 🔴 blocks agent runs when we get there.
- [ ] ⚪ **Domain name decision** + DNS access (Phase 6 email, Phase 7 launch). You said you own one — tell Claude which. 🔴 blocks Google Workspace setup and launch cutover.
- [ ] ⚪ **Google Workspace** (support@ user, ~$7/mo) **+ GCP project** with service account & domain-wide delegation (Phase 6). 🔴 blocks the support agent going live.
- [ ] ⚪ **FunkyDori webfont license check** (Phase 2). Not a blocker — Lilita One is the stand-in display face (the `--font-display` token in tailwind.css is the FunkyDori swap point); Poppins is the body face.
- [ ] ⚪ **Apply for the Google Trends official API alpha** (free, approval is slow — applying early helps Phase 5). Not a blocker — SerpApi bridges it.
- [ ] ⚪ **CJ wallet top-up ~$150** (Phase 7 canary). 🔴 blocks the first real order. Top-up is manual only — no API.
- [ ] ⚪ **Policy pages → Shopify Settings** (Phase 7). Paste `apps/storefront/app/content/policies.tsx` copy into Shopify Settings → Policies and review/finalize before launch.
- [ ] ⚪ **Business checks before launch** (Phase 7): Shopify Payments setup, US tax registrations in Shopify Tax, general liability insurance for the LLC (recommended), policy pages review.

- [ ] ⚪ **Store-transfer gotchas to re-verify at Phase 7 cutover** (carried from the never-sent Shopify support question, since the client-transfer path was taken unconfirmed): whether app installs + Admin API credentials, custom domains, and Shopify Payments configuration survive the transfer to your merchant account — budget time to re-create the `doge-buddy` app and re-issue credentials if they don't.

---

*Maintained by Claude; last updated 2026-08-24 (Phase 4 Plan B merged — admin surface wired; Tier-2 dashboard walk added above). When you complete an item, check it off and tell Claude — especially the credential items, so live verification can run.*

**Next build session starts here →** Phase 5 prework (sourcing agent) — blocked on the ⚪ **Anthropic API key** item above (Later phases section); until that's filled in, build work can continue against fixtures/mocks but agent runs themselves can't. Phase 4 (Plan A + Plan B) is merged; only its Tier-2 admin-dashboard walk above is still open.
