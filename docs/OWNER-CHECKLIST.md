# Robert's Checklist

Things only you can do, with **explicit blocker status**. Build work continues regardless — nothing here stops Claude from writing and testing code against fixtures and the mock supplier. Items are ordered by when they'll be needed.

Legend: 🔴 **BLOCKER** (something specific stalls until done) · 🟡 soon (needed to *verify live*, not to build) · ⚪ later phase.

---

## Now / this week

- [ ] 🟡 **Merge the Phase 0 PR.** Create it at
  https://github.com/ClosingBracketsLLC/doge-buddy/pull/new/feat/phase-0-foundations (branch is already pushed), review, merge.
  *Blocks:* nothing today (Phase 1 stacks on the Phase 0 branch), but the Phase 1 PR should retarget/land after it. ~5 min.

- [ ] 🟡 **Test Shopify store: API credentials.** Using your other Shopify account:
  1. Note the store's `*.myshopify.com` domain.
  2. Go to the Shopify Dev Dashboard (dev.shopify.com/dashboard) → create app `doge-buddy-ops` (custom distribution).
  3. Configure Admin API scopes: `read_products, write_products, read_orders, write_orders, read_customers, read_inventory, write_inventory, read_fulfillments, read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders, read_publications, write_publications, read_files, write_files` — and request **`read_all_orders`** approval (separate approval; without it apps see only 60 days of orders).
  4. Install the app on the test store; copy the **client ID** and **client secret**.
  5. Put them in `apps/ops/.env`:
     `SHOPIFY_SHOP_DOMAIN=<store>.myshopify.com`, `SHOPIFY_CLIENT_ID=…`, `SHOPIFY_CLIENT_SECRET=…`, `SHOPIFY_WEBHOOK_SECRET=<same as client secret>`
  *Blocks:* 🔴 the **live-Shopify verification steps** of Phase 1 (scripted DRAFT-product creation, real webhook end-to-end). Building and fixture tests proceed without it. ~20–30 min.
  *Note:* Shopify retired admin-created custom apps for new apps (Jan 2026) — the Dev Dashboard flow above is the current path. If your account still shows the legacy "Develop apps" flow and it works, a legacy Admin API token also works — tell Claude which you ended up with.
  *Check:* once `.env` is filled in, run `pnpm --filter @doge-buddy/ops verify-live` — the Shopify section should print `SHOPIFY OK`.

- [ ] 🟡 **CJ Dropshipping account + API key.** cjdropshipping.com → register (free) → My CJ → Authorization → API → generate API key. Put in `apps/ops/.env`: `CJ_API_KEY=…` (CJ shows it as `<userNum>@api@<key>` — paste the whole string) and `CJ_OPEN_ID=…` (shown alongside; used to verify CJ webhooks).
  *Blocks:* 🔴 the **CJ live round-trip check** (token → `getBalance`) and recording real API fixtures. Mock-adapter and fixture builds proceed without it. ~15 min.
  *Check:* once `.env` is filled in, run `pnpm --filter @doge-buddy/ops verify-live` — the CJ section should print `CJ OK`.

- [ ] 🟡 **Ask Shopify support about the launch-store type** (do this early — the answer shapes Phase 7). Suggested message:
  > "I'm a developer building a store that must be free during development and become a live paid store at launch, without rebuilding. I understand Dev Dashboard development stores cannot be converted or transferred to a live store, and that the Partner Dashboard 'client transfer' store is the type meant for this. Can you confirm: (1) a Partner Dashboard client-transfer store can be transferred to my own merchant account and upgraded to a paid plan with all products/config intact, and (2) this is still the recommended path in 2026?"
  *Blocks:* 🔴 **creating the launch store (Phase 7 path)** only. Your existing test store covers all development until then. ~10 min to send.

## Phase 1–3 window

- [ ] 🟡 **Railway account + deploy ops** following `docs/deploy-railway.md` (~30–45 min).
  *Blocks:* 🔴 **receiving real webhooks from Shopify/CJ** (they need a public HTTPS URL) and the Phase 0 "demo job on deployed instance" exit criterion. Local webhook testing uses replay scripts, so building proceeds. Alternative for a quick test: a `cloudflared` tunnel to your machine.

## Later phases (no action yet — listed so nothing surprises you)

- [ ] ⚪ **Anthropic API key** (Phase 5 — sourcing agent). 🔴 blocks agent runs when we get there.
- [ ] ⚪ **Domain name decision** + DNS access (Phase 6 email, Phase 7 launch). You said you own one — tell Claude which. 🔴 blocks Google Workspace setup and launch cutover.
- [ ] ⚪ **Google Workspace** (support@ user, ~$7/mo) **+ GCP project** with service account & domain-wide delegation (Phase 6). 🔴 blocks the support agent going live.
- [ ] ⚪ **FunkyDori webfont license check** (Phase 2). Not a blocker — Poppins is the fallback display face.
- [ ] ⚪ **Apply for the Google Trends official API alpha** (free, approval is slow — applying early helps Phase 5). Not a blocker — SerpApi bridges it.
- [ ] ⚪ **CJ wallet top-up ~$150** (Phase 7 canary). 🔴 blocks the first real order. Top-up is manual only — no API.
- [ ] ⚪ **Business checks before launch** (Phase 7): Shopify Payments setup, US tax registrations in Shopify Tax, general liability insurance for the LLC (recommended), policy pages review.

---

*Maintained by Claude; last updated 2026-08-17 (Phase 1 start). When you complete an item, check it off and tell Claude — especially the credential items, so live verification can run.*
