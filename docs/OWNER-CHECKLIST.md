# Robert's Checklist

Things only you can do, with **explicit blocker status**. Build work continues regardless — nothing here stops Claude from writing and testing code against fixtures and the mock supplier. Items are ordered by when they'll be needed.

Legend: 🔴 **BLOCKER** (something specific stalls until done) · 🟡 soon (needed to *verify live*, not to build) · ⚪ later phase.

---

## Now / this week

- [x] ~~Merge the Phase 0 PR.~~ **Done differently (2026-08-18):** Phases 0, 1, and 2 were merged into local `main` directly at your request (all suites green). Pushed to origin and the stale feature branches are gone from the remote (verified 2026-08-23). *New, standing note:* local `main` accumulates commits between pushes and Claude's pushes are permission-blocked — run `git push origin main` before any Railway deploy so it builds current code.

- [x] ~~Test Shopify store: API credentials.~~ **Done (2026-08-23):** Robert created a Shopify Partner account + client-transfer store (`doge-buddy-1b9crsev.myshopify.com`, custom domain `dogebuddy.com`), created custom-distribution app `doge-buddy` via the Dev Dashboard, and set scopes through Versions → Create version (the Dev Dashboard doesn't expose scopes as a direct settings toggle). `apps/ops/.env` is filled in. `verify-live` prints `SHOPIFY OK` (token round-trip, listPublications, scripted DRAFT-product create/cleanup all pass against the real store). Note: `SHOPIFY_SHOP_DOMAIN` must be the `*.myshopify.com` domain, not the custom domain — the custom domain 301-redirects `/admin/oauth/access_token`, which turns the POST into a GET and breaks the token exchange.

- [x] ~~CJ Dropshipping account + API key.~~ **Done (2026-08-23):** CJ moved API access behind an installable app (Apps → Install App → **API** app under "Others" → Add API → Type: API Key) — there's no direct "Authorization" menu anymore. `CJ_OPEN_ID` doesn't appear anywhere in the dashboard UI either; it's the account's numeric `openId`, only obtainable by authenticating with `CJ_API_KEY` and calling `GET /setting/get`. `apps/ops/.env` is filled in (`CJ_API_KEY`, `CJ_OPEN_ID=47491`). `verify-live` prints `CJ OK` (token round-trip + `getBalance`). Also had to `pnpm db:up` + `DATABASE_URL=... pnpm --filter @doge-buddy/db migrate` — local dev Postgres wasn't running yet, unrelated to the CJ credentials themselves.
  *Check:* once `.env` is filled in, run `pnpm --filter @doge-buddy/ops verify-live` — the CJ section should print `CJ OK`.

- [x] ~~CJ key → re-record `order/list` fixtures, then run the full-pipeline sandbox contract check (Phase 3 Tier 2).~~ **Done (2026-08-23):** all CJ fixtures re-recorded from real responses and the full 9-case contract suite now passes live against the CJ sandbox (place → confirm → pay → advance → track → dispute). The unverified fixtures turned out to be wrong in ways that mattered — see `docs/cj-api-notes.md` for the full list, including a **real-money bug**: `placeOrder` sent `sandbox: true`, which CJ ignores, so every "sandbox" order would have been a real chargeable order.
  *Re-run:* `CJ_CONTRACT=1 CJ_API_KEY=<from apps/ops/.env> CJ_OPEN_ID=47491 CJ_CONTRACT_VID=<a real CJ variant id> pnpm --filter @doge-buddy/supplier test` — the CJ_API_KEY/CJ_OPEN_ID exports are load-bearing: the supplier package does **not** read `apps/ops/.env`, and without `CJ_API_KEY` the suite silently skips and prints green. Places fresh sandbox orders each run.

- [x] ~~Ask Shopify support about the launch-store type.~~ **Skipped by choice (2026-08-23):** Robert created a Shopify Partner account and a client-transfer store directly, without confirming with Shopify support first — his call, his store, willing to eat any cost if the transfer assumption turns out wrong. This store is now doing double duty as both the dev/test store (item below) and the intended Phase 7 launch store.

## Phase 1–3 window

- [ ] 🟡 **Railway account + deploy ops** following `docs/deploy-railway.md` (~30–45 min).
  *Blocks:* 🔴 **receiving real webhooks from Shopify/CJ** (they need a public HTTPS URL) and the Phase 0 "demo job on deployed instance" exit criterion. Local webhook testing uses replay scripts, so building proceeds. Alternative for a quick test: a `cloudflared` tunnel to your machine.

- [ ] 🟡 **Hydrogen channel + Oxygen for the test store.** Using your test Shopify store:
  1. Install the Hydrogen sales channel on the test store.
  2. Create a storefront named `doge-buddy`.
  3. Connect the GitHub repo `ClosingBracketsLLC/doge-buddy` for Oxygen auto-deploys (dev-store deploys are password-protected — expected).
  4. Copy the storefront env vars it issues into `apps/storefront/.env` (see `.env.example`).
  5. Enable **Bogus Gateway** (test store → Settings → Payments → third-party → Bogus).
  *Blocks:* 🔴 **Tier-2 verification of Phase 2** (real-store browse, Bogus checkout, Oxygen deploy) — Tier-1/mock.shop build proceeds without it.

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

*Maintained by Claude; last updated 2026-08-23 (Shopify + CJ credentials live, CJ contract suite green, Phase 4 planning started). When you complete an item, check it off and tell Claude — especially the credential items, so live verification can run.*
