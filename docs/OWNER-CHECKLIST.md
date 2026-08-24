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

- [ ] 🟡 **Phase 4 Tier-2 verification — one tap left.** Tier-1 passed live 2026-08-24 (seeded proposal → click-approve → real product `gid://shopify/Product/8947799064664` ACTIVE + published + rendering on the storefront). Storefront-visibility: ✅ closed (local render verified; Oxygen deploy now live too). Telegram vars are on Railway (2026-08-24) and a **real production-path proposal is sitting on your phone right now**: proposal `263e41a3` — tap **Approve** in the Telegram message, confirm on the page it opens, and the *deployed* worker applies it (creates a second Dog Snuff Pad listing — expected; it proves the production path). That tap closes Phase 4A Tier-2 entirely. Expires 7 days from 2026-08-24 if untapped (harmless — reseed with `seed-proposal` against the Railway DB).

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

*Maintained by Claude; last updated 2026-08-24 (Phase 4 Plan A merged + live-verified; first green CI + first Oxygen deploy; Hydrogen/Oxygen done). When you complete an item, check it off and tell Claude — especially the credential items, so live verification can run.*

**Next build session starts here →** Phase 4 **Plan B** (admin surface: magic-link login, dashboard, proposals/orders/settings pages) — spec §§4-5 of `docs/superpowers/specs/2026-08-23-phase-4-proposals-design.md` (approved), written via superpowers:writing-plans, executed subagent-driven like Plan A (`docs/superpowers/plans/2026-08-23-phase-4a-proposal-pipeline.md` is the precedent; its parked/deferred items are listed at the end of the Plan A merge summary in the 2026-08-24 chat and in the spec's own Decisions table).
