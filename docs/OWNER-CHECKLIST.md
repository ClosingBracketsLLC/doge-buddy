# Robert's Checklist

Things only you can do, with **explicit blocker status**. Build work continues regardless — nothing here stops Claude from writing and testing code against fixtures and the mock supplier. Items are ordered by when they'll be needed.

Legend: 🔴 **BLOCKER** (something specific stalls until done) · 🟡 soon (needed to *verify live*, not to build) · ⚪ later phase.

---

## Launch runway — everything left, in order (2026-08-31)

**Storefront/catalog work is a separate list — `docs/LAUNCH-BACKLOG.md` (audited 2026-08-31: nav categories 404, two products, bare product pages).** Read top to bottom. **A** is this week's housekeeping, **B** is launch prep you can do in any order, **C** is launch day. Nothing code-side is pending; every item is a click-path for you, and "→ Claude" marks where I take over. The detailed items further down stay as reference.

**A. Housekeeping (≈30 min total)**
1. [x] **Push the last commit** — from `~/Desktop/code/ClosingBrackets/doge-buddy`: `git push origin main` (no migration; it's the hedged `/contact` success copy + the walk write-ups; Oxygen redeploys the storefront).
2. [x] **Outlook safe-sender on your test account (30 s)** — Outlook.com → ⚙️ Settings → **Mail → Junk email → Safe senders and domains** → add `dogebuddy.com` → Save. Future walks from that mailbox become visible again.
3. [x] **Rotate the Railway Postgres password** — Railway → **Postgres service → Variables** → regenerate `POSTGRES_PASSWORD` (Railway rewrites `DATABASE_URL`/`DATABASE_PUBLIC_URL` from it) → then open the **ops service → Variables** and confirm `DATABASE_URL` is the reference `${{Postgres.DATABASE_URL}}`, not a pasted literal (the literal is what broke ops on 2026-08-27) → click the **Apply** banner → ops → **Deployments → ⋮ → Redeploy** → `https://doge-buddyops-production.up.railway.app/healthz` shows `"db":"ok"`. Don't paste the new URL anywhere; when I need DB access you paste it once and we rotate again before launch.
4. [ ] *(optional)* Delete the two stray build-test ack threads in the support mailbox (to robert@closingbrackets.com, 2026-08-31 02:53 and 22:34 — the second one is the real walk; keep it if you like).

**B. Launch prep (any order; all owner-side)**
*(2026-08-31: B9, B11, B12, B13 are owner-managed on Robert's own schedule — no reminders needed; only B5 remains before launch day.)*
5. [ ] **CJ wallet top-up ~$150** — CJ dashboard → **My CJ → Wallet** (balance) → **Recharge** (card/PayPal; manual only, no API). 🔴 The first real order cannot be placed without it — the wallet monitor pages you below $20.
6. [x] **Policy pages into Shopify** — Shopify admin → **Settings → Policies** → paste Shipping, Returns & refunds, Privacy, Terms. → **Claude prints the exact plain text on request** ("print POLICY_COPY") so you paste, not retype. The storefront already renders the same text; the agent quotes it.
7. [x] **Shopify Payments** — Settings → **Payments** → **Activate Shopify Payments** (business details, bank account, ID check). Keep the test gateway active until launch day (step 15).
8. [x] **US sales tax** — Settings → **Taxes and duties → United States** → add the states where you're registered to collect (Shopify Tax is free to $100k lifetime); register in your nexus state first if you haven't.
9. [ ] **General liability insurance for the LLC** — recommended, outside Shopify.
10. [x] **Shopify anti-spam settings** — Settings → **Notifications → Staff notifications** → turn off every notification you don't want (new customer sign-ups etc.); Settings → **Customer accounts** → keep the passwordless "new" accounts (bots can only trigger codes to themselves).
11. [ ] **Store-transfer re-verification** (only if you transfer the store to the LLC's merchant account before launch) — after the transfer: `pnpm --filter @doge-buddy/ops verify-live` must still print `SHOPIFY OK` (app + Admin API token survived), `dogebuddy.com` still points at Oxygen, Shopify Payments still active. If the app didn't survive, re-create `doge-buddy` in the Dev Dashboard and re-issue credentials → **Claude updates `.env` + Railway vars with you.**
12. [ ] **DMARC tightening (in ~2 weeks)** — once the daily aggregate reports to support@ have shown clean alignment for about two weeks: DNS `_dmarc.dogebuddy.com` → `v=DMARC1; p=quarantine; rua=mailto:support@dogebuddy.com`. Helps Outlook.com deliverability (see the 🟡 item below). → **Ask Claude to read the reports first** (they're zip attachments in the mailbox; I can parse them).
13. [ ] *(cosmetic, optional)* FunkyDori webfont license — Lilita One is the stand-in until then.
14. [ ] 🔴 **Catalog P0 go-live (Claude + Robert, ~30 min).** The catalog-p0 branch is built and
    tested (see `docs/LAUNCH-BACKLOG.md` P0 1–5) but never run against the real store. Live-tier
    steps, in order:
    (a) ✅ 2026-08-31 merged (`db5096b`) and pushed. Railway redeployed ops; Oxygen the storefront.
    (b) ✅ 2026-08-31 — all four collections live, rules `TAG EQUALS category:<tag>`, published to
    all 4 publications (verified by Admin API probe). Original step: From the main checkout: `pnpm --filter @doge-buddy/ops seed-collections` (reads
    `apps/ops/.env`) → expect `created=4 skipped=0 published=16` (16 = 4 collections × 4
    publications: Online Store, Shop, POS, `doge-buddy`). Then on the storefront preview URL:
    `/collections/toys-play`, `/walks-travel`, `/beds-comfort`, `/grooming-care` all return 200
    (empty — no products tagged yet) and `/collections` shows four tiles.
    (c) ⚠️ **Must run against the RAILWAY database, not localhost.** The script walks the DB's
    product rows and writes each variant's `shopify_inventory_item_gid` back — the deployed
    `inventory.sync` reads that column on Railway. `apps/ops/.env` has `DATABASE_URL=localhost`
    (only the Snuff Pad row exists there), so a plain run touches 1 product and stores the gid in
    the wrong DB. Prefix the Railway URL (an env var set on the command line beats `.env`):
    `DATABASE_URL='<railway postgres url>' pnpm --filter @doge-buddy/ops backfill-listings --dry-run`
    → expect `2 active product(s)`; then the same command **without** `--dry-run` → expect
    `products=2 updated=2 partial=0 failures=0`. Use the Railway Postgres service's public/proxy
    URL (Variables → `DATABASE_PUBLIC_URL`) — the internal `railway.internal` host is not reachable
    from your laptop. `FULFILLMENT_SUPPLIER=cj` is already set in `apps/ops/.env` (checked) — the
    script refuses to push inventory otherwise. Don't run it in the minute after a `:00` 6-hourly
    sync tick (00/06/12/18 UTC) — the two are not serialized.
    **First real run (2026-08-31, inside Railway):** `products=2 updated=0 partial=1 failures=2`:
    (1) clipper — catalog fields landed (slug/tag/type/SEO ✅), inventory push rejected because
    the 2026-07 API REQUIRES `changeFromQuantity` (fixed in code, commit below — the sync job had
    the same bug; rerun after the push); (2) Snuff Pad — the Railway row `e10022af…` points at
    Shopify product `8947876659288`, which no longer exists (the live Snuff Pad is
    `8947799064664`, listed from the LOCAL machine under proposal `f0b3f371`, not the deployed
    worker's `263e41a3`). Repoint the Railway row, then rerun the backfill:
    ```sql
    UPDATE products SET shopify_product_gid = 'gid://shopify/Product/8947799064664'
      WHERE id = 'e10022af-357a-4a59-be02-1911922b2d38';
    UPDATE product_variants SET shopify_variant_gid = 'gid://shopify/ProductVariant/44650188144728',
      shopify_inventory_item_gid = 'gid://shopify/InventoryItem/46758880641112'
      WHERE product_id = 'e10022af-357a-4a59-be02-1911922b2d38';
    ```
    (If the Snuff Pad is not a real CJ product — sku `DB-SNUFFPAD-01` doesn't look like one — skip
    the SQL, archive it in Shopify admin and `UPDATE products SET status='deprecated' WHERE id=
    'e10022af-…'` instead; the backfill then reports its CJ read as failed and leaves it alone.)
    **Second run (2026-08-31, after the fix + SQL): `updated=1 partial=1 failures=1`** — the
    clipper is DONE (slug, `category:grooming`, type, SEO, `tracked=true`, **16 in stock** —
    verified by Admin API probe); the Snuff Pad got its slug/tag/type but CJ answered *"Variant
    has been removed from shelves"* (vid `1952308304731430913`) — CJ has delisted it, so it must
    come OFF sale, not be repaired. Step (c) is otherwise ✅. Deprecate the Snuff Pad through the
    normal path (inside Railway):
    `pnpm --filter @doge-buddy/ops deprecate-product --product e10022af-357a-4a59-be02-1911922b2d38 --reason "CJ removed the variant from shelves"`
    → approve it on Telegram → the worker flips it to DRAFT, unpublishes it, marks the row
    `deprecated`. Until then the backfill (and the 6-hourly sync) keep reporting that one read as
    failed — expected. The two live products get
    human URLs (`/products/dog-snuff-pad-<8hex>`, `/products/low-noise-pet-hair-clipper-<8hex>`),
    land in the right category (Grooming & Care for the clipper, etc.), and show tracked stock.
    ✅ 2026-08-31 Snuff Pad deprecated (DRAFT, unpublished) via `deprecate-product` + Telegram approve.
    (d) ✅ 2026-08-31 verified by Admin API probe: clipper in `grooming-care` (1), tag/type/SEO set.
    (e) ✅ 2026-08-31 — manual run + approve produced `automatic-dog-ball-launcher-adjustable-fetch-machine-with-6-d02dda59`:
    `category:toys`, "Dog Toys", `tracked=true`, 126 in stock, published to all 4 channels, listed
    in `toys-play`. Exit criterion 3 met. Original step: One manual-mode sourcing run, proving exit criterion 3: `pnpm --filter @doge-buddy/ops
    run-sourcing --force --max-winners 2 --keywords "dog chew toy"` → approve the winner on your
    phone (Telegram or `/admin/proposals`) → the new product arrives slugged, tagged, typed, with
    tracked inventory equal to CJ's largest single US-warehouse stock.
    (f) ⚪ (not verified by Claude — Railway DB/logs are yours) Force a sync check: watch the Railway ops logs for `inventory.synced` right after that
    listing (the post-listing job enqueues automatically) — or wait for the next 6-hourly cron. A
    variant whose CJ stock is 0 should show "Sold out" on the storefront within one cycle.
    (g) **Build-week runs:** on `/admin/settings`, flip `workflow.sourcing.mode` to `auto`. Leave
    the four `sourcing.*` settings alone — the CLI flags in the block below carry the build-week
    numbers (overrides beat settings), so nothing has to be set here and nothing is left changed
    afterwards. Then run the block below, Tue–Thu, ~10 min apart (each run costs
    ≈$3–5 CJ points + Anthropic spend; Claude watches `/admin` and the wallet). **Flip
    `workflow.sourcing.mode` back to `manual` after the last run.**
    ```
    pnpm --filter @doge-buddy/ops run-sourcing --force --keywords "dog chew toy,dog plush toy,dog puzzle toy,dog fetch ball" --max-winners 8 --budget 5 --candidates 40 --pages 20
    pnpm --filter @doge-buddy/ops run-sourcing --force --keywords "dog harness,dog leash,dog travel bowl,dog car seat cover" --max-winners 8 --budget 5 --candidates 40 --pages 20
    pnpm --filter @doge-buddy/ops run-sourcing --force --keywords "orthopedic dog bed,calming dog bed,dog blanket,dog crate mat" --max-winners 8 --budget 5 --candidates 40 --pages 20
    pnpm --filter @doge-buddy/ops run-sourcing --force --keywords "dog nail grinder,dog brush,dog shampoo,dog clipper" --max-winners 8 --budget 5 --candidates 40 --pages 20
    # repeat a category with fresh keywords if it came back short; Claude watches /admin and the wallet.
    ```
    (h) *(optional polish)* Upload one image per collection: Shopify admin → Products →
    Collections → each collection → Image.

**C. Launch day**
15. [ ] **Publish the storefront** — Shopify admin → **Online Store → Preferences** (or the Hydrogen channel's storefront settings) → remove the visitor password → confirm `https://dogebuddy.com` loads in a private window without a login wall.
16. [ ] **Swap off the test gateway** — Settings → **Payments** → deactivate "(for testing) Bogus Gateway"; Shopify Payments must be the active provider.
17. [ ] **Canary guardrails** — `https://doge-buddyops-production.up.railway.app/admin/settings`: set `fulfillment.spend_cap_per_order_cents` to `3000` (per-order ~$30, parent-spec risk #8), leave `fulfillment.wallet_alert_threshold_cents` at `2000`, keep every `workflow.*.mode` on **manual** for the first ~10 real orders.
18. [ ] **Self-purchase** — one real order from your own (non-test) address with a real card → tell Claude before you place it → **Claude watches** `orders/paid` → CJ order placed → tracking synced to Shopify → the package arrives (the physical loop). While that supplier order exists, **Claude closes Tier-2 #4** (`openCjDispute` against a real supplier order) and live-validates scoring's order→variant join.
19. [ ] **After ~10 clean real orders** — flip `workflow.sourcing.mode`, `workflow.support_reply.mode`, `workflow.deprecation.mode` to **auto** one at a time on `/admin/settings` (refunds stay manual — hard-locked in code). Before flipping deprecation to auto, ask Claude to build the auto-mode digest FYI (deferred on purpose).

---

## Now / this week

- [x] ✅ **Admin control center shipped (2026-09-01).** `/admin` is mobile-first for the Fold: bottom tabs
  with badges (pending proposals, escalated tickets) on the cover screen, a left rail on the inner
  screen/desktop; the home page is a card board — Needs you · Money · Switches · Agents & jobs ·
  Catalog — and the switches (kill switch, fulfillment, the four workflow modes) flip settings in one
  tap (the kill switch asks first). Every table stacks into cards under 640 px; Approve/Reject and
  Escalate/Resolve sit in a sticky bar; irreversible posts confirm. Dark by default, light follows
  the phone. **What to do:** open `/admin` on the cover screen and the inner screen; tap through a
  proposal and a ticket; report anything that overflows, is too small to tap, or reads wrong.
  (Verified at 380/800/1280 px by screenshot; the raw text health strip still lives under
  "System status (text)".)
- [ ] ⚪ **Catalog P0 — follow-ups (none block go-live; from the branch review).** (1) `inventory.sync` holds a DB connection + row lock per variant across the CJ read and Shopify push, and neither client has a request timeout — bounded to 2 of 10 pool connections, fine for the canary; queue `SET LOCAL idle_in_transaction_session_timeout = '30s'` in that transaction + request timeouts on the CJ/Shopify clients. (2) Don't run `backfill-listings` while the 6-hourly sync is mid-cycle — it is a manual one-shot and is NOT row-lock serialized (fix the `operations.ts` comment that says otherwise). (3) Comment nits: ~~`proposal-apply.test.ts` still explains a withdrawn CAS~~ (fixed with the changeFromQuantity fix); the sync's points guard can never fire before the variant cap; `skipped` lumps out-of-scope variants with "needs backfill" ones. (4) `usQuantity` = largest single US warehouse (not the sum) — matches the fulfillment planner; revisit only if the planner ever learns multi-warehouse splits.
- [x] ~~Tap APPROVE on a proposal on your phone.~~ **Done (2026-08-25) — and it closed BOTH open live tiers.** You approved the *Low Noise Pet Hair Clipper* **from the admin dashboard** (Telegram login-link → `/admin/proposals` → approve — exactly Phase 4B's walk) and rejected the *Plush Round Dog Bed* via the Telegram link. The apply worker created ACTIVE Shopify product `gid://shopify/Product/8949329592408` ($54.99, SKU `CJJJCWGY01635-Style D`) with its CJ fulfillment mapping 6 seconds after the tap. **Phase 5 is closed on every tier.**
- [x] ~~Migration 0008 on Railway FIRST, then push.~~ **Done 2026-08-31** (0008 + 0009 migrated, pushed, verified from outside: origin==main, fresh `/healthz`, `/public/contact` armed). *Original item:* Local main is ahead of origin with the Tier-2 sign-off (re-recorded Gmail fixtures — tests only) **and the pre-triage spam short-circuit, which adds `support_tickets.gmail_spam` (migration `0008_flat_lionheart`)**. Same drill as 0005/0006/0007 — the STRICT order matters: the new ingest code writes that column on every inbound message, so a redeploy before the migration throws on every poll while `/healthz` stays green (a silent mail outage). (1) From this checkout: `DATABASE_URL='<Railway PUBLIC postgres url>' pnpm --filter @doge-buddy/db migrate` → expect `migrations applied` (9/9). (2) Then `git push origin main` and let Railway redeploy. Nothing else to configure — the short-circuit's only knob (`support.spam_shortcircuit.always`) defaults off and lives on `/admin/settings`.
- [x] ~~🔴 Contact form go-live.~~ **DONE 2026-08-31 — live walk PASSED** via `robert@closingbrackets.com`: ack 22:34:24Z → approved reply 22:36:26Z threaded on the ack's real Message-ID with the marker → your Gmail reply 22:38:42Z ingested into the same thread/ticket. Two findings became the two items right below. *(The first attempt from the Outlook address tripped `repeat_complainant` — 3rd ticket in 30 days, correct behaviour, re-armed with the walk-#2 SQL — and Microsoft then silently dropped both messages.)* *Original walk-through, kept for the next env setup:* Order only matters in ONE place: **step 4 (migrations) must happen BEFORE step 5 (push)** — the new code writes the `gmail_spam`/`source` columns on every poll cycle and form submission, so a redeploy before the migration is a silent mail outage behind a green `/healthz` (same trap as 0005/0006/0007). Steps 1–3 are safe in any order, any time.
  1. **Get the Oxygen preview hostname** (you need it for the Turnstile widget):
     Shopify admin → left sidebar **Sales channels → Hydrogen** → storefront **doge-buddy** → **Deployments** → the latest deployment's URL looks like `https://<something>.o2.myshopify.dev`. Copy just the hostname (no `https://`, no path).
  2. **Create the Turnstile widget** (free, ~2 min):
     - Go to `dash.cloudflare.com` and log in (or create a free account — Turnstile does NOT require adding your domain to Cloudflare; it's a standalone product).
     - Left sidebar → **Turnstile** → **Add widget**.
     - Widget name: `dogebuddy contact`. **Hostnames** → add `dogebuddy.com`, then add the `…o2.myshopify.dev` hostname from step 1 (subdomains are covered automatically, so `www.dogebuddy.com` rides on the first entry).
     - Widget Mode: **Managed**. Leave everything else at defaults. Create.
     - The widget page now shows a **Site Key** (public) and a **Secret Key** (click to reveal/copy). Keep this tab open for steps 3–4.
  3. **Railway — the secret**:
     - `railway.app` → the doge-buddy project → click the **ops service** (doge-buddyops) → **Variables** tab → **New Variable** → name `TURNSTILE_SECRET_KEY`, value = the **Secret Key** → save.
     - Railway STAGES variable edits: watch for the easy-to-miss **Apply**/Deploy banner at the top and click it (same trap as the DB-password rotation). This redeploys the currently-deployed OLD code, which simply ignores the new var — harmless.
  4. **Oxygen — the two public vars**:
     - Shopify admin → **Sales channels → Hydrogen** → storefront **doge-buddy** → **Storefront settings** → **Environments and variables**.
     - For EVERY environment listed (Production AND Preview): add `PUBLIC_TURNSTILE_SITE_KEY` = the **Site Key**, and `OPS_BASE_URL` = `https://doge-buddyops-production.up.railway.app` (no trailing slash). Neither is a secret.
     - These only take effect on the NEXT storefront deployment — step 6's push covers that; nothing else to click here.
  5. **Migrations on Railway — BEFORE the push**:
     - Railway → the **Postgres service** → **Variables** (or the Connect tab) → copy **`DATABASE_PUBLIC_URL`** — the PUBLIC one (host like `…proxy.rlwy.net`). The `…railway.internal` one will not work from your machine.
     - In a terminal, from `~/Desktop/code/ClosingBrackets/doge-buddy`:
       `DATABASE_URL='<paste the public url>' pnpm --filter @doge-buddy/db migrate`
     - Expected output ends with `migrations applied`. Optional double-check: `psql '<same url>' -c 'select count(*) from drizzle.__drizzle_migrations;'` → **10**.
     - No need to paste the URL into chat this time (every paste is another exposure — the rotation item below is still queued).
  6. **Push**:
     - Same terminal: `git push origin main`.
     - Ops: Railway auto-redeploys — service → **Deployments** → newest → **View logs** → look for the line **`contact form endpoint ARMED`**. If it says `DISABLED (needs GMAIL_* + TURNSTILE_SECRET_KEY)`, step 3's Apply banner was missed.
     - Storefront: GitHub → repo → **Actions** shows the Oxygen workflow running; the new deployment appears under Hydrogen → Deployments and carries step 4's vars.
  7. **Live walk (~5 min — tell Claude when you start; Claude watches the DB and the mailbox):**
     - (a) Open the storefront preview URL from step 1 (signed in past the password wall, as usual) and go to **`/contact`**. The form should render with the small Turnstile box (it may briefly show a spinner/check). If you see "The contact form is temporarily unavailable" instead, step 4's vars didn't reach THIS environment's latest deployment.
     - (b) Fill it in as `CollinsContracting509@outlook.com` with a real-ish question (mention order #1001 if you like) → **Send** → you should get the "Sent!" page.
     - (c) `https://doge-buddyops-production.up.railway.app/admin/tickets` (Telegram magic-link login) → the new ticket shows **via contact form** next to its subject.
     - (d) Outlook INBOX (check Junk too — the domain is still new): **"We got your message — Doge Buddy Support"** from support@dogebuddy.com, within about a minute.
     - (e) Wait ~1–2 min for the agent's draft → **Approve** from the Telegram buttons → the reply must land **in the SAME Outlook conversation** as the ack.
     - (f) Reply to that conversation from Outlook (thread replies only — the repeat-complainant rule counts tickets) → tell Claude → it must attach to the SAME ticket, no duplicate.
     - (g) Claude then verifies the wire side: marker header on the sent reply, the placeholder→real thread swap, and `rfc822msgid:` finding the ack (spec exit criteria 1–6).
  8. **Housekeeping**: the build's local verification sent one real acknowledgement from support@ to robert@closingbrackets.com (subject "We got your message — Doge Buddy Support") — delete that thread from the support mailbox whenever.
- [ ] 🟡 **Outlook.com deliverability — first-contact mail from support@ is silently dropped (found 2026-08-31).** Facts: Google Admin → Reporting → Email Log Search shows both the ack and the reply to `collinscontracting509@outlook.com` as `Delivered to an SMTP server 52.101.73.122 (TLS)`; nothing in Inbox/Junk/Other/Deleted; no bounce. The earlier walks' replies to that mailbox landed only because it had emailed support@ first (known correspondent). SPF/DKIM/DMARC all pass — this is Microsoft's reputation filter on a brand-new domain, not a config error. Before launch: (1) your own Outlook test account: ⚙️ Settings → Mail → **Junk email → Safe senders and domains** → add `dogebuddy.com` (so future walks are visible there); (2) once the daily DMARC aggregate reports have shown clean alignment for ~2 weeks, tighten `_dmarc.dogebuddy.com` from `p=none` to `p=quarantine` (Microsoft weights it); (3) warm the domain — a handful of genuine low-volume conversations with Outlook/Hotmail addresses that reply back; (4) know the limit: some Outlook.com customers won't receive the ack (or the reply) until reputation builds — the storefront success page now hedges ("should arrive within a few minutes — check junk/spam"), and such a customer can always write in by email instead.
- [ ] ⚪ **Message-ID finding — recorded so nobody "fixes" the wrong thing.** Gmail rewrites the ack's client-supplied `Message-ID` on send (spec finding A). The job already stores the real id, threading is correct, and duplicate protection is the claim sentinel; the `rfc822msgid:` crash-recovery search is simply inert. Optional code follow-up for a quiet day: search `to:<email> subject:"We got your message" newer_than:1h` instead.
- [ ] ⚪ **Contact form — follow-ups (none block go-live; from the branch's whole-branch review).** Design limits worth knowing: (1) a Turnstile-solving flood is bounded at 100 form tickets/UTC-day, but each one still costs a Haiku triage call + an agent run + an ack email from support@ and competes with real mail for the 200-call triage budget — form tickets are never spam-short-circuit candidates by design; (2) an *ambiguous* Gmail send failure (accepted, then the socket dropped) plus Gmail's search-index lag can still produce a duplicate ack — the claim/recovery mechanism closes the crash and concurrency cases, not that one; (3) a form ticket cannot carry a refund proposal until the customer replies by email (the DMARC gate needs an authenticated inbound — the validator now says so); (4) a ticket whose ack fails *permanently* has no terminal state — you get a `support_form_ack_thread_taken` / `support_form_ack_failed` page and fix `gmail_thread_id` by hand. Code polish queued for a quiet day: `retryCount` typed via `Pick<JobWithMetadata>` in the ack handler; aria-wiring of the form's field errors; a `.badge` CSS rule in admin; the `FORM_ACK_CLAIM_STALE_MS` comment should cite the Gmail client's 20s request timeout as the real guarantee; a few test-strength nits the review listed (ledger, now in git history via the plan).
- [x] ~~`git push origin main` (the `@idempotent` placement fix).~~ **Done (2026-08-30 evening)** — the push landed, the refund was re-seeded and approved, and walk #2 closed on it (live refund `999129448536`). *Original item:* carries the **`@idempotent` placement fix** (Shopify requires the directive on `refundCreate`/`inventorySetQuantities` but on the mutation FIELD — ours sat on the operation header, so the first live refund dead-lettered after 5 retries; live-probed both ways, fixed, re-probed accepted) + dead-letter pages now include the GraphQL `errors[]` + the Tier-2 helper scripts. *(Earlier in this item: the cross-thread reply fix)* (a reply Gmail files under a new thread id now attaches to its ticket via `In-Reply-To`/`References` instead of opening a duplicate — found live when your Outlook reply on the spam-foldered "Return request" thread became a 3rd ticket and tripped repeat-complainant) plus docs.
- [ ] 🟡 **Rotate the Railway Postgres password AGAIN before launch** (Settings on the Postgres service → regenerate) — the fresh URL was pasted into chat once on 2026-08-30 for the Tier-2 DB verifications. Same drill as 2026-08-27: after regenerating, check whether the ops service's `DATABASE_URL` is the reference `${{Postgres.DATABASE_URL}}` or a stale pasted literal (the literal is what broke ops last time), and remember Railway stages variable edits behind the easy-to-miss Apply banner + a manual redeploy. No rush today; required before real customer data flows.
- [ ] ⚪ **Publish the storefront — a LAUNCH-DAY switch, deliberately OFF.** `dogebuddy.com` now
  targets the Hydrogen storefront on Oxygen (done 2026-08-30), and Robert keeps it
  **password-protected on purpose**: his last published Shopify store was flooded with thousands of
  bot emails. This does NOT block any Tier-2 walk (checkout works signed-in; webhooks don't care).
  Before flipping it public, the anti-spam picture for THIS stack, audited 2026-08-30:
  - *Already true:* the Hydrogen storefront now has a `/contact` form — no newsletter signup, no
    `mailto:`, and the support address is never printed — but the form itself exists and is
    **Turnstile-gated + honeypotted + capped (100/day) + folded (5/sender/day)**. The classic
    Liquid-theme flood vector (a contact form → unbounded merchant notification emails) is closed
    by those four layers rather than by the form's absence. The only other forms are search (GET)
    and the signed-in account pages.
  - *Already built in ops:* Haiku triage auto-resolves spam (labeled, never escalates, never counts
    toward repeat-complainant); 5-tickets-per-sender-per-day flood fold; triage capped at
    **200 LLM calls/UTC-day** (20/cycle) with a once-a-day Telegram warning — so a flood costs
    at most ~200 Haiku calls/day. ~~Weak spot: at cap, REAL customer mail waits behind the spam
    until the next UTC day.~~ *Closed by the short-circuit below.*
  - [x] ~~*Do before publishing (Claude builds, ~1 task):* a pre-triage short-circuit.~~ **BUILT
    (2026-08-30 late; needs migration 0008 + a push — see the 🔴 item above).** A "spam candidate"
    = the ticket's latest inbound sat in Gmail's own SPAM folder (new `support_tickets.gmail_spam`,
    kept in step with `last_inbound_at` by ingest) from a sender with **no order on file** (none
    linked, none under that email in `orders`); tripwired tickets are escalated and never selected.
    Two things happen: **(1) candidates always sort BEHIND real mail** in the triage selection, so a
    flood can never delay a real ticket, and **(2) once the day's 200-call cap is reached they are
    resolved as spam + labeled `DogeBuddy/Spam` WITHOUT a model call** (audit
    `support.triage_spam_shortcircuit`), never spending the cap. **Deliberate deviation from the
    original wording ("always without an LLM call"):** while the cap has room a candidate still gets
    the cheap Haiku verdict, because the live walks showed Gmail spam-foldering a *legitimate*
    pre-purchase question from a new Outlook sender — exactly the "no order yet" case — and the
    literal rule would have auto-resolved it unseen. If you'd rather have zero spend on
    spam-foldered no-order mail regardless, flip **`support.spam_shortcircuit.always`** on at
    `/admin/settings` (default off) — it's one checkbox, no redeploy.
    *Original item:* Gmail-SPAM-labeled
    mail from a sender with no order and no tripwire hit auto-resolves as spam **without** an LLM
    call and without consuming the daily cap, so a flood can't starve real tickets.
  - [x] ~~*Decide before publishing:* the privacy policy still says "Email support@ (email address
    coming soon — see contact page)". Options: (a) a Turnstile+honeypot contact form that creates a
    ticket directly (no address exposed — recommended), or (b) print the address as text
    (scrapeable).~~ **Decided + BUILT (2026-08-31): option (a).** See the 🔴 "Contact form go-live"
    item above for the remaining owner keys + live walk.
  - *Shopify-side:* Settings → Notifications → turn off every staff notification you don't want
    (new customer sign-ups etc.); Settings → Customer accounts → keep the passwordless "new"
    accounts (bots can only trigger codes to THEMSELVES).
- [x] ~~Place a test order.~~ **Done (2026-08-30 16:05 PT): order #1001** (`gid://shopify/Order/6945615773784`, confirmation QRPCHQ42J) — Dog Snuff Pad $29.99 + $8 shipping = $37.99, gateway `bogus`, customer collinscontracting509@outlook.com. Landed in ops via `orders/paid` 6s after checkout with `is_test = true`, and the fulfillment planner audited `fulfillment.skipped_test` — no CJ order, no wallet spend, exactly as designed.
- [x] ~~`SERPAPI_KEY` → Railway variables.~~ **Done (2026-08-25, confirmed by you).** Trends stage fully working live: 1 request/run, real scores for all keywords.
- [x] ~~Fix `ADMIN_BASE_URL` in `apps/ops/.env`.~~ **Done — verified 2026-08-24 (follow-up session): `.env` now has the `https://` scheme, so plain `run-sourcing` no longer crashes `loadConfig`.**
- [x] ~~Phase 5 Tier-2 (first live sourcing run).~~ **DONE on the pipeline side (2026-08-25):** you pushed + pasted the Railway DB URL; Claude drove two live runs. Run #1 exposed the last real bug (the whole harvest pool was CN-warehoused — every winner died on the US-stock gate; also learned CJ freight quotes are NOT stock evidence). After `9affbc6`, run #2 went clean: **completed, submitted 2, dropped 0**, 46 turns, **$0.61**, Telegram sent. Only your approve-tap (item above) remains. Total spend across all 6 live runs: ~$1.95 Anthropic, ~4,200 CJ points, ~14 SerpApi credits.

- [x] ~~Merge the Phase 0 PR.~~ **Done differently (2026-08-18):** Phases 0, 1, and 2 were merged into local `main` directly at your request (all suites green). Pushed to origin and the stale feature branches are gone from the remote (verified 2026-08-23). *New, standing note:* local `main` accumulates commits between pushes and Claude's pushes are permission-blocked — run `git push origin main` when Claude asks so Railway/CI/Oxygen build current code. (As of 2026-08-24 the repo's **CI is green for the first time** and the **first Oxygen deploy succeeded** — preview URL lives in the Hydrogen channel UI under the storefront's Deployments.)

- [x] ~~Test Shopify store: API credentials.~~ **Done (2026-08-23):** Robert created a Shopify Partner account + client-transfer store (`doge-buddy-1b9crsev.myshopify.com`, custom domain `dogebuddy.com`), created custom-distribution app `doge-buddy` via the Dev Dashboard, and set scopes through Versions → Create version (the Dev Dashboard doesn't expose scopes as a direct settings toggle). `apps/ops/.env` is filled in. `verify-live` prints `SHOPIFY OK` (token round-trip, listPublications, scripted DRAFT-product create/cleanup all pass against the real store). Note: `SHOPIFY_SHOP_DOMAIN` must be the `*.myshopify.com` domain, not the custom domain — the custom domain 301-redirects `/admin/oauth/access_token`, which turns the POST into a GET and breaks the token exchange.

- [x] ~~CJ Dropshipping account + API key.~~ **Done (2026-08-23):** CJ moved API access behind an installable app (Apps → Install App → **API** app under "Others" → Add API → Type: API Key) — there's no direct "Authorization" menu anymore. `CJ_OPEN_ID` doesn't appear anywhere in the dashboard UI either; it's the account's numeric `openId`, only obtainable by authenticating with `CJ_API_KEY` and calling `GET /setting/get`. `apps/ops/.env` is filled in (`CJ_API_KEY`, `CJ_OPEN_ID=47491`). `verify-live` prints `CJ OK` (token round-trip + `getBalance`). Also had to `pnpm db:up` + `DATABASE_URL=... pnpm --filter @doge-buddy/db migrate` — local dev Postgres wasn't running yet, unrelated to the CJ credentials themselves.
  *Check:* once `.env` is filled in, run `pnpm --filter @doge-buddy/ops verify-live` — the CJ section should print `CJ OK`.

- [x] ~~CJ key → re-record `order/list` fixtures, then run the full-pipeline sandbox contract check (Phase 3 Tier 2).~~ **Done (2026-08-23):** all CJ fixtures re-recorded from real responses and the full 9-case contract suite now passes live against the CJ sandbox (place → confirm → pay → advance → track → dispute). The unverified fixtures turned out to be wrong in ways that mattered — see `docs/cj-api-notes.md` for the full list, including a **real-money bug**: `placeOrder` sent `sandbox: true`, which CJ ignores, so every "sandbox" order would have been a real chargeable order.
  *Re-run:* `CJ_CONTRACT=1 CJ_API_KEY=<from apps/ops/.env> CJ_OPEN_ID=47491 CJ_CONTRACT_VID=<a real CJ variant id> pnpm --filter @doge-buddy/supplier test` — the CJ_API_KEY/CJ_OPEN_ID exports are load-bearing: the supplier package does **not** read `apps/ops/.env`, and without `CJ_API_KEY` the suite silently skips and prints green. Places fresh sandbox orders each run.

- [x] ~~Ask Shopify support about the launch-store type.~~ **Skipped by choice (2026-08-23):** Robert created a Shopify Partner account and a client-transfer store directly, without confirming with Shopify support first — his call, his store, willing to eat any cost if the transfer assumption turns out wrong. This store is now doing double duty as both the dev/test store (item below) and the intended Phase 7 launch store.

## Phase 6B live bring-up (next)

Phase 6B — the support **agent** (per-ticket Agent SDK sessions, read-only tools, drafted replies
and refunds behind your approval) — is built and reviewed; everything below is its live tier.
Claude drives the technical steps with you; only the two ⚪ items need your hands on a browser.

- [x] ~~Run migrations 0005 + 0006 on Railway FIRST, THEN `git push`.~~ **Done (by 2026-08-29):** the
  6B code has been running in production since that push — real agent runs were created on 2026-08-29
  (the ones that exposed the `input_schema.type` 400, fixed in `3b55d25`), which is only possible
  with the 0005/0006 schema in place.
- [x] ~~Confirm migration 0007 is on Railway.~~ **Done 2026-08-30** (applied by Robert; the 2026-08-31 migrate run reported all 10 applied). *Original item:*
  `DATABASE_URL='<railway PUBLIC url>' pnpm --filter @doge-buddy/db migrate`. Your push of `6b26bb3`
  (reject-with-reason re-draft + `/admin/guidance`) deployed code that SELECTS the two new
  `support_tickets` columns (`owner_redraft_feedback`, `redraft_count`). If 0007 was NOT applied
  before that deploy, the support poll has been throwing on every cycle since (Railway showed ≈13.8h
  of uptime at 2026-08-30 ~09:50 PT) while `/healthz` stays green — exactly the silent-outage shape
  the 0005/0006 item warned about. Claude cannot check this (no Railway DB URL or CLI on this side) —
  tell Claude either way. If it was missed: run the migration, then look at `/admin/tickets` for
  mail that arrived during the gap (ingest resumes on the next poll; nothing is lost in Gmail).
  The three commits after `6b26bb3` add NO migration.
- [x] ~~Create the standing discount code in Shopify.~~ **Done (2026-08-30) as `SORRY10` (10% off,
  one use per customer)** — the no-refund strategy's only concession; the agent quotes it (the
  validator treats "we've issued/sent/applied you a code" as an unbacked promise, while quoting the
  existing code passes).
- [x] ~~Paste this into `/admin/guidance`.~~ **Done 2026-08-30** (guidance pasted; the live reply that afternoon quoted it). *Original item:* (edit freely — it's yours; the hard rules still win
  over it). It replaces whatever coupon wording you wrote earlier:
  > Our stance: we avoid refunds and returns. All sales are final for change of mind — never offer a
  > return or a refund for a product that arrived as described; decline politely and offer discount
  > code SORRY10 (10% off their next order, one use per customer). For damaged, defective, or wrong
  > items: ask for a photo of what they received, tell them we'll email return instructions, that
  > return shipping is at their cost, and that a replacement ships at no charge only after the
  > returned item has reached us and passed inspection (a return IS required; nothing ships before
  > inspection); do not offer a refund
  > unless the owner has said a replacement isn't possible. For
  > an order that never arrived: check tracking with get_order; if it's past the promised window, say
  > we'll reship it. Never bring up refunds unprompted. If a customer insists on a refund, mentions a
  > chargeback or dispute, or threatens legal action — escalate.
- [x] ~~Gmail "Send mail as" check.~~ **Moot (2026-08-30):** `support@dogebuddy.com` became the
  user's PRIMARY address during 6A bring-up, so there is no alias to add — and the mailbox now holds
  two live replies stamped `From: support@dogebuddy.com` (see the Tier-2 status below).
- [x] ~~An Outlook-reachable test address.~~ **Done:** `CollinsContracting509@outlook.com` — its
  first test email ("Shipping time + tracking?", 2026-08-29 20:48 PT) is in the support mailbox and
  was replied to. (Threading is the one behaviour Gmail-to-Gmail cannot prove: Gmail groups on its
  own thread id, Outlook on `In-Reply-To`/`References`.)
- [x] ~~**Tier-2 walk (spec §8 + the exit criteria).**~~ **SIGNED OFF 2026-08-30 (late evening).** #1/#1a/#2/#3 closed live (the running log is below), and the sign-off gate — the `GMAIL_CONTRACT=1` re-record — ran from this checkout the same night (`e0170eb`: 11 fixtures now carry real Gmail responses, 92/92 green, typecheck clean). The re-record surfaced five real-Gmail contract facts the hand-authored fixtures had wrong or never covered (empty history pages omit the `history` key; sent copies have no `Delivered-To`/`Authentication-Results` and come back with `Message-Id`, not `Message-ID`; inbound carries two look-alike `ARC-Authentication-Results` headers; the daily DMARC report is an attachment-only message; no mainstream client sends single-part text/plain any more) — **none was a production bug**, the client already handled every one; they are now pinned by tests. **The one deliberate carry-over is #4** (`openCjDispute` vs CJ): it needs a PLACED supplier order, which a test order never produces, so it rides on the canary's first real order (tracked in the canary section). *Original item:* Four checks, run with Claude. **Status 2026-08-30 EOD: #1, #1a, #2, #3 CLOSED.**
  **Status 2026-08-30 (read straight from the support mailbox via the Gmail API):** two agent
  replies have gone out, both `From: support@dogebuddy.com`, both in the customer's original Gmail
  thread with `In-Reply-To` + `References` = the customer's Message-ID and a `Re:` subject —
  "Delivery time question" → phucutube@gmail.com (2026-08-29 13:28 PT, marker
  `3fc075c8-cba7-…`) and "Shipping time + tracking?" → the outlook.com address (2026-08-29 20:51 PT,
  marker `65a8edf9-678b-…`). **Check 1a PASSES** — the `X-DogeBuddy-Proposal` header read back
  verbatim via `format=metadata` on both SENT copies. Earlier, you rejected a policy-faithful
  return-acceptance draft (→ the reject-WITH-REASON re-draft loop, up to 2 re-drafts per ticket,
  and the `/admin/guidance` page for standing guidance), and the promised-action screen escalated
  every return-policy answer (→ fixed in `a81da1e`, now deployed). Note: Gmail put the Outlook
  inbound in Spam; ingest deliberately reads spam (`includeSpamTrash: true`, Haiku triage decides),
  so the reply went out regardless — but expect OUR reply to land in Outlook's Junk too until the
  domain has reputation. **Update 2026-08-30 afternoon (verified against the
  Railway DB):** guidance pasted, the no-refund policy/validator push deployed, and the Outlook
  follow-up on the shipping thread ("Can I send it back for a refund?") produced a screen-passing
  draft Robert approved — sent 13:48 PT, marker `72b9da79-…`, full References chain, **landed in
  the Outlook INBOX (Robert confirmed)**. That same exchange closed TWO more items: **walk #3
  (follow-up resume across a redeploy) is FORMALLY CLOSED** — one session (`263cabaf-…`, 43
  transcript entries in Postgres) spans last night's first reply and today's follow-up, straight
  across the 13:42 PT redeploy — and the **reject-with-reason re-draft loop had its first real use
  last night** (proposal `c6193fd6` rejected with a reason 20:50 PT → re-draft `65a8edf9` 23s
  later → approved and sent). The "Return request" ticket's `agent_failed ×2` is diagnosed: both
  runs SUCCEEDED and drafted fine — the OLD promised-action screen rejected the drafts downstream
  (exactly the `a81da1e` bug, now deployed-fixed). **WALK #1 + 1a: CLOSED (2026-08-30).** Robert's
  screenshot shows the Outlook conversation view grouping his follow-up and the support reply as
  ONE conversation — the last outstanding piece. (The planned extra reply on the RETURN thread was
  dropped as redundant: the decline-on-a-refund-ask draft already passed the fixed screen on this
  very exchange, and 1a's marker round-trip was verified on three sent replies. The "Return
  request" ticket stays `resolved` — the customer got the decline+SORRY10 answer in this thread.
  Optional belt-and-braces, anytime: glance at the personal-Gmail "Delivery time question" thread —
  structurally it must group, References are correct.) **Remaining in Tier-2: #2 (Bogus-gateway
  refund delivered twice → exactly one refund) and #4 (`openCjDispute` vs the CJ sandbox)** — both
  need a test order through the test gateway first — plus the `GMAIL_CONTRACT=1` re-record and the
  two Shopify refund-schema checks (items below).
  1. **Email → approve-from-phone → threading.** Send a real support email → categorized ticket
     with an agent-drafted reply proposal on Telegram + `/admin/proposals` → approve from your
     phone → the reply lands in the customer mailbox, `From: support@dogebuddy.com`, **threaded as
     ONE conversation in Gmail AND in Outlook** (this is why the outlook.com address above exists).
  1a. **Marker header round-trip (send-recovery's only real-Gmail check).** Right after walk #1,
     fetch the sent message via Gmail `format=metadata` and assert its `X-DogeBuddy-Proposal` header
     equals the proposal id. This custom `X-` header is the ONLY thing that prevents a crash-retry
     from double-sending (the recovery scan reads it back to recognise our own prior send) — and it
     is FIXTURE-ONLY today (the recorder never records our sends). If Gmail drops or rewrites the
     header, a crash between send and the `applied` transition silently sends the customer a SECOND
     copy. This walk is its only live verification.
  **Walk #2 status (2026-08-30 evening):** test order #1001 exists; the refund-input schema bugs are
     fixed and deployed. Robert's Outlook reply about the order landed as a NEW Gmail thread (Gmail
     won't merge inbox mail into a spam-foldered conversation) → duplicate ticket `2052005c` →
     repeat-complainant escalation (order #1001 DID link — ownership check verified live). Root
     cause fixed on local main (References fallback in ingest). After the push deploys: Claude merges
     `2052005c` into the original ticket `784cac33` and reopens it → agent drafts the damaged-item
     reply → Robert rejects WITH reason "can't replace — refund $37.99" → refund proposal → approve →
     double delivery → one refund → `orderRefundState` read-back.
  **Walk #2 status, later that evening:** Robert ran the merge; the agent then ran on the merged
     ticket and **ESCALATED with a reasoned refusal** — order #1001 was created that day and never
     shipped (test orders skip fulfillment), so "arrived with split seams" is inconsistent, and the
     first email told a different (change-of-mind) story. That is correct behaviour — a
     fraud-shaped claim on an unshipped order must reach a human — and it means a TEST order can
     never yield an agent-drafted refund with a consistent story (nor a CJ dispute: walk #4 needs a
     real supplier order → canary). So the Shopify refund mechanics are exercised via
     `pnpm --filter @doge-buddy/ops seed-refund-proposal 1001 3799 <ticketId>` (the real
     `submitProposal` path: real Telegram buttons, DEPLOYED apply worker does the live
     `refundCreate`; refunds are hard-locked manual). Seeded proposal `114cbe79-…` is PENDING on
     Robert's phone. Baseline `read-refund-state` before approval: 0 refunds, parent SALE
     transaction `8771701014616`, gateway `bogus`, `refunds` is a plain list. After approval: verify
     exactly one refund in Shopify admin → `read-refund-state` shows the `db-proposal-114cbe79…` note
     verbatim → `redeliver-apply 114cbe79…` (second delivery → `proposal.apply_skipped`) → and, for
     the crash-window guard, Robert flips the row to `applying` (`UPDATE proposals SET
     status='applying', applied_at=NULL WHERE id='114cbe79-…'`) and Claude redelivers once more →
     the note pre-check must land on `applied` with NO second payout.
  **Walk #2, three approvals in (2026-08-30 ~17:00 PT):** (1) seeded proposal `114cbe79` — Robert
     REJECTED it reflexively (no reason → terminal). (2) `1cd6489c` on the escalated ticket —
     approved, and the executor refused with `ticket no longer accepting refund`: **a refund only
     pays out while its ticket is `awaiting_approval`/`waiting_on_customer`** — a late tap on an
     escalated ticket must not move money. Correct; live PASS of that guard. (3) `c84e3665` on the
     `waiting_on_customer` shipping ticket — approved, reached Shopify, and **dead-lettered after
     5 retries: the `@idempotent` directive was on the operation header, which the live API rejects
     (it must be on the mutation field, and it IS required)**. Fixed on local main, re-probed
     accepted (userError "Order does not exist" on a fake id — document valid, no money moved).
     Next: push → redeploy → re-seed on the shipping ticket → Approve → one refund → read-back →
     redeliver → crash-window re-entry.
  **WALK #2 — LIVE REFUND LANDED (2026-08-30 17:41 PT).** Robert re-armed the shipping ticket, the
     watcher auto-seeded `594b7211-…`, he approved, and 2 seconds later the deployed worker issued
     **`gid://shopify/Refund/999129448536` for $37.99** (`proposal.refund_issued` → `proposal.applied`,
     ticket left at `waiting_on_customer` as designed). **Read-back PASSES:** `orderRefundState`
     returns exactly one refund whose note is `db-proposal-594b7211-…` **verbatim** (the durable
     half of never-refund-twice), `totalRefundedCents` 3799, `refunds` a plain un-paginated list.
     **Second delivery PASSES:** `redeliver-apply` → deployed worker → `proposal.apply_skipped
     {status: applied}` — no second payout. **Crash-window re-entry PASSES (17:43 PT):** Robert flipped the row to
     `applying`, redelivery re-entered the executor, the note pre-check found `db-proposal-594b7211-…`
     on Shopify and completed as `proposal.applied {recovered: true}` — no `refundCreate` call; final
     read-back still exactly ONE refund, 3799 cents. **WALK #2: CLOSED.**
  2. ~~**Bogus-gateway refund, delivered twice.**~~ ✅ **CLOSED 2026-08-30** (status above). Place a test order through the test payment gateway
     → let the agent draft a refund → approve it → deliver the apply job a second time → **exactly
     one refund** in the Shopify admin (Shopify's idempotency key covers the fast duplicate; the
     `db-proposal-<id>` refund NOTE is the durable half, since those keys expire in ~24h).
  3. **Follow-up resume across a redeploy.** Reply again on an already-answered ticket, redeploy
     Railway in between, then let the next run go: the session id stays stable and the run's
     transcript shows the prior context (the transcript lives in Postgres, not on Railway's
     ephemeral disk — that separation is exactly what this check proves).
  4. **`openCjDispute` against the CJ sandbox.** A refund proposal that also opens a CJ dispute —
     dispute-WRITE bodies are CJ's only never-live-verified surface, and this closes them.
- [x] ~~Re-record the Gmail fixtures live (`GMAIL_CONTRACT=1`).~~ **Done (2026-08-30, `e0170eb`)** — nothing
  for you to do; the walk traffic already in the mailbox was the seed. Three recorder fixes rode
  along (the documented `env $(… | xargs)` invocation corrupts the PEM's `\n` — it now sources
  `.env` with `set -a`; the "single-part" pick was Google's DMARC zip; a stale scratch key crashed
  the write). Re-run any time with the command in the script's header; expect `client.test.ts`
  literals to move again. *Original item:* deferred from the 6B branch
  because `apps/ops/.env` is gitignored and exists only in the main checkout, so run it from there
  after the merge, with one owner-seeded test email in the mailbox first. Heads-up carried from the
  build: a live re-record changes the recorded message/thread ids, so `packages/gmail/test/client.test.ts`'s
  call-site id literals have to be updated in the same commit.
- [x] ~~BEFORE the first live refund: verify the mutation shape against the pinned 2026-07 schema.~~ **Done by live introspection (2026-08-30) — BOTH suspicions were real bugs, fixed on local main:** `OrderTransactionInput.orderId` is `ID!` per transaction entry (we omitted it — every live refund would have failed validation before any money moved), and `gateway` is `String!` on input while the parent transaction's `gateway` is nullable on output (a null now fails the proposal terminally instead of sending null). Also confirmed: `Order.refunds`/`Order.transactions` are plain lists (not page-capped connections) and `Refund.note` exists, so the read-back item below only needs the live round-trip. *Original item:* **verify the mutation shape against the pinned 2026-07 schema.** `RefundInput` / `OrderTransactionInput` are written from documentation, never yet
  executed against a real store. Two specific suspicions to settle first: whether `gateway` is
  nullable on a transaction entry (we send the parent transaction's gateway verbatim), and whether
  each transaction entry needs its own `orderId` alongside the top-level one. A wrong shape here
  fails loudly rather than silently, but it fails on a real order — check the schema first.
- [x] ~~Right after that test refund, read the state back.~~ **Done (2026-08-30):** on order #1001 after the live refund the `db-proposal-594b7211-…` note round-trips **verbatim**, `refunds` is a plain un-paginated list (1 entry), `totalRefundedCents` 3799. *Original item:* **read the state back.** Call `orderRefundState` on the order
  and confirm two things: the `db-proposal-<id>` note round-trips **verbatim** (it is the durable
  half of the never-refund-twice guarantee — if Shopify trims or rewrites it, that guarantee is
  gone), and the `refunds` list is **not page-capped** (we select it as a plain unpaginated list;
  if the live API paginates it instead, a busy order could hide our own prior refund and re-pay).

## Phase 7 scoring (built — nothing you must do)

The product-scoring subsystem is built and reviewed. What it means for you day one:

- **Nightly scoring is live and observing from launch.** Every night it writes one `product_scores`
  row per active product (keep / watch / deprecate) — pure measurement, it never acts on anything.
- **The weekly deprecation digest stays SILENT until your store's first real paid order.** A
  pre-revenue gate means no deprecation Telegram, no proposal, nothing, until real revenue exists —
  so a brand-new store is never told to deprecate the catalog it just launched.
- **Deprecation is manual-mode by default — nothing acts without your tap.** Once revenue exists, the
  Monday digest can flag an underperformer, but it only ever creates a *proposal*; the product is
  drafted + unpublished + its CJ webhook torn down solely after you approve it, exactly like every
  other proposal. (An `auto` mode exists in settings but is off.)
- **Optional, anytime:** a `scoring.nightly` dry-run against Railway just writes today's
  `product_scores` and takes no action — safe to trigger whenever you want to see the verdicts early.

## Phase 1–3 window

- [x] ~~Railway account + deploy ops.~~ **Done (2026-08-23):** ops + Postgres live at `https://doge-buddyops-production.up.railway.app` — healthz green (`db:ok, queue:ok`), demo job processed on the deployed instance (**Phase 0 exit criterion closed**), and the webhook-audit cron self-registered all three Shopify webhook topics (ORDERS_PAID, ORDERS_CANCELLED, REFUNDS_CREATE) at the Railway URL. *Follow-up closed same day:* CJ webhooks are registered and **proven end-to-end live** — the diagnostic capture revealed the signature rides in the `sign` header (fixed in 2a2e0e5), registration then succeeded, and real sandbox-order events flowed CJ → HMAC verified → recorded → processed on the deployed instance. Nothing on the CJ adapter remains unverified except dispute-write bodies and STOCK/PRODUCT event shapes.

- [x] ~~Hydrogen channel + Oxygen for the test store.~~ **Done (2026-08-24):** channel installed, storefront `doge-buddy` (id 1000173017) created, GitHub connected (Shopify auto-PR'd its Oxygen workflow — which assumed a single-repo npm project and was adapted to the pnpm monorepo in 8a0734d), env vars in gitignored `apps/storefront/.env`. **Verified live:** local storefront serves the real store, and the Phase-4-pipeline product (Dog Snuff Pad, `DB-SNUFFPAD-01`, $29.99) renders on its product page with Shopify-CDN images — closing Phase 4's storefront-visibility check in its local form. *All sub-items closed 2026-08-24:* `PUBLIC_CHECKOUT_DOMAIN` set (the store's own myshopify domain — standard for dev stores), the **test payment gateway activated** (Shopify's current name for the legacy "Bogus Gateway" — same thing), and the first Oxygen deploy succeeded on push.

- [x] ~~Phase 4 Tier-2 verification.~~ **Done (2026-08-24) — closed by Robert's thumb.** The full production path ran live: seeded proposal → Telegram message with buttons → phone tap → deployed confirm page → form POST → guarded approval (`decided_by: owner`) → deployed apply worker → real ACTIVE product `gid://shopify/Product/8947876659288` with its CJ fulfillment mapping. The first tap surfaced a real bug (Fastify has no urlencoded parser, so real browser form submits 415'd — invisible to tests/curl, which send no Content-Type; fixed in 7efd26f with a regression test). Second Dog Snuff Pad listing on the store is the proof artifact — delete either duplicate via admin whenever. **Phase 4 Plan A is complete on every tier.**

- [x] ~~Phase 4B Tier-2 verification.~~ **Done (2026-08-25), better than the script:** instead of a
  seeded proposal, Robert did the walk with a REAL one — Telegram login link requested and tapped
  (`admin.login_link_sent` → `admin.login` in the audit log), then approved the Pet Hair Clipper
  proposal from `/admin/proposals` (`proposal.approve {"via": "admin"}`) and the deployed apply
  worker listed it. Phase 4 Plan B's live tier is closed.

- [x] ~~Rotate the Railway Postgres password.~~ **Done (2026-08-27)** — it briefly broke the deployed ops service (a stale pasted `DATABASE_URL` literal → healthz `db:error`), fixed by updating the variable + a manual redeploy (Deployments → ⋮ → Redeploy; Railway stages variable edits behind an easy-to-miss Apply banner). Claude has never seen the new URL — paste it when locally-driven live DB work is needed. *Original note:* the connection string has now been pasted into Claude chat logs on 2026-08-23 AND twice on 2026-08-25 (internal + public URLs, same password). Still private logs, but three exposures says rotate once you've tapped approve and Tier-2 is closed. Railway re-injects the internal `DATABASE_URL` into the ops service automatically; Claude will need the new public URL only if you want more locally-driven live DB work afterward.

- [x] ~~Phase 6A live bring-up.~~ **DONE (2026-08-27) — every subsystem verified in production.** The saga: test emails first BOUNCED (support@ didn't exist as an address — the checklist had covered SPF/DKIM but the alias was never created); Robert fixed it by making `support@dogebuddy.com` the user's PRIMARY email (admin@ became the alias), `GMAIL_IMPERSONATE` updated to `support@` in Railway + local `.env`. Then live: real email → `order_issue` ticket with Haiku triage + ownership-checked order claim (correctly unlinked); "chargeback" → code tripwire → Telegram alert on the phone; two more emails tripped the repeat-complainant escalation; Google's own admin notice was spam-auto-resolved; admin resolve→escalate→resolve all audited with guarded transitions; Gmail draft autosaves produced ZERO junk rows and the sent reply landed as exactly one outbound message. Six tickets on `/admin/tickets` tell the whole story. *(Optional 30s completeness check, anytime: reply from the personal gmail to the resolved "Order #1002" thread — the ticket should flip back to `new`.)*

## Later phases (no action yet — listed so nothing surprises you)

- [x] ~~Anthropic API key.~~ **Done (2026-08-24):** key in `apps/ops/.env`, validated against the API (free `count_tokens` probe), **and added to Railway's variables same day**. *Optional remaining sub-step:* a workspace spend limit in the Anthropic console (~$15/mo hard cap comfortably covers the approved $2.00/run weekly sourcing budget).
- [x] ~~SerpApi account (Google Trends bridge for Phase 5).~~ **Done (2026-08-24):** free-tier account created, `SERPAPI_KEY` in gitignored `apps/ops/.env`, validated against the account endpoint (Free Plan, 250 searches/mo, 250 left — the weekly run uses ~18–45/wk). *Remaining sub-step before Phase 5's live runs on Railway:* add `SERPAPI_KEY` to Railway's variables.
- [x] ~~Domain name decision.~~ **Decided (2026-08-25): `dogebuddy.com`** (already the store's custom domain). Unblocks Phase 6. *Still needed for Phase 6:* DNS access to add email-auth records (SPF → DKIM 2048 → 48h wait → DMARC p=none) — the next Phase-6 session will hand you the exact record values.
- [x] ~~Phase 6A parallel setup — Google Workspace + GCP + DNS.~~ **Done (2026-08-25), with one owner decision:** Workspace created (`admin@dogebuddy.com`), SPF + DKIM published, GCP project `doge-buddy-support` + Gmail API + service account + key (required a self-granted org-role fix and an org-policy override on the project — new-org "Secure by Default" blocks SA keys), domain-wide delegation authorized, creds in `apps/ops/.env`, **delegation chain live-verified** (token + getProfile OK). **Decision: `support@` is an ALIAS on `admin@` (1 seat) instead of a dedicated user** — tradeoffs accepted, escape hatch documented in the 6A spec §5. Two follow-ups remain below.
- [x] ~~DMARC record in ~48h.~~ **Done — verified by DNS on 2026-08-30:** `_dmarc.dogebuddy.com` = `v=DMARC1; p=none; rua=mailto:support@dogebuddy.com` (Google's first aggregate report already arrived in the support mailbox). SPF (`include:_spf.google.com ~all`) and the `google` DKIM selector both resolve.
- [x] ~~Gmail "Send mail as" check.~~ **Moot since 2026-08-27** — `support@dogebuddy.com` is the Workspace user's PRIMARY address, and every live reply has gone out `From: support@`. *Original item:* in Gmail as `admin@` → Settings → Accounts → confirm `support@dogebuddy.com` is listed under "Send mail as" (add it if not — no verification step for your own alias). 6B's replies go out From: support@.

- [ ] ⚪ **FunkyDori webfont license check** (Phase 2). Not a blocker — Lilita One is the stand-in display face (the `--font-display` token in tailwind.css is the FunkyDori swap point); Poppins is the body face.
- [x] ~~Apply for the Google Trends official API alpha.~~ **Applied (2026-08-24).** Approval is slow (months-to-never per applicant reports) — SerpApi bridges it meanwhile; the Phase 5 trends adapter is swappable, so approval landing later is a drop-in.
- [ ] ⚪ **Local dev-DB hygiene (30 seconds):** run `psql "postgres://doge:doge@localhost:5433/doge_buddy" -c "DELETE FROM product_scores WHERE score_date = '2099-12-31';"` — two orphaned test-seed rows (leaked by a killed vitest run 2026-09-01) make exactly two full-suite tests fail (`admin-dashboard` test 13, `scoring-weekly-digest` freshness). Claude's DB deletes are classifier-blocked, so this one is yours; until then those two failures with exactly those signatures are known-benign.

- [ ] ⚪ **Sourcing market-price LIVE CHECK** (after `main` is pushed and Railway deploys; merged 2026-09-01). One run, from **inside the Railway ops service** (`railway ssh` into the service, then from `/app`) — a local run reads `apps/ops/.env`, whose `DATABASE_URL` is the localhost dev DB, so proposals/signals would land in the wrong database (same trap as the first backfill no-op):

  ```
  pnpm --filter @doge-buddy/ops run-sourcing --max-winners 2
  ```

  All flags (each optional): `--force` (bypass the same-day circuit breaker for a repeat run today) · `--keywords "a,b,c"` (≤ 8, replaces the default five for this run) · `--max-winners N` (1–12) · `--budget USD` (0.5–10, agent stop-loss) · `--candidates N` (3–80) · `--pages N` (1–40). Both `--flag value` and `--flag=value` work; unknown flags abort loudly. There is **no flag for the price ratio** — that's the `sourcing.max_price_to_market_bps` setting on `/admin/settings` (default 13000 = 1.3×; range 10000–20000).

  **Pass criteria:** (a) the script's closing `SerpApi requests made N (trends + market lookups)` line shows **N ≤ 25**; (b) at least one proposal summary carries `market $… median ×…` (visible in the Telegram notification and on the proposal page); (c) `SELECT keyword, score, snapshot->>'offerCount' AS offers FROM sourcing_signals WHERE source = 'market_price' ORDER BY created_at DESC LIMIT 5;` shows `offers ≥ 5`. Check (c) validates the Google Shopping response-shape FIXTURE-ASSUMPTION (spec §2) — `offers = 0` on every row means SerpApi's shape changed; tell Claude and the parser fixture gets corrected. If every winner drops with `sourcing_winner_no_market_price`/`price_above_market` instead, the run page's alerts carry the reason — also worth a look before re-running with `--force`. Prereqs: `SERPAPI_KEY` on the service + the quota check (footer).

- [ ] ⚪ **Product page v2 LIVE CHECK** (after `product-page-v2` is merged to `main` and pushed; branch built 2026-09-01 — all 17 plan tasks committed, code+tests green, typecheck clean). Two runs, both from **inside the Railway ops service** (same localhost-DB trap as B14/the sourcing check above — a local run writes to the dev DB, not the live one):

  1. ✅ **DONE 2026-09-02** — `backfill-listings --dry-run` then real, from the Railway shell. **v2 pass: 23 products, 30 variant images attached (all READY), 9 supplier_reviews metafields written, 0 failures** — live-verifies `productUpdate(product, media)` create+attach, `productVariantAppendMedia`, `metafieldsSet`, `metafieldDefinitionCreate` (Claude's read-only probe confirmed all four `dogebuddy` v2 definitions with `storefront=PUBLIC_READ`, distinct per-color media on the 3-variant leash, and real parsed reviews e.g. `average=5 count=1`), and the `product/productComments` wire shape (cj-api-notes updated; 14 products had no usable/rated reviews — info-alert degrade, by design). `fileDelete`-of-media was never exercised (zero media failures) — stays a fixture assumption, non-fatal path. Leftovers from this run: (a) pass 1 hit three CJ 429s on stock reads (`nylon-anti-grind` collar, `semi-enclosed-plush` bed, `human-size` bed) — **rerun `pnpm --filter @doge-buddy/ops backfill-listings` once** to retry (idempotent; the v2 pass will skip the 30 already-imaged variants, which also proves rerun idempotency); (b) points cost of productComments still unconfirmed — CJ dashboard when convenient; (c) observed: CJ reviews arrive in the buyer's language (Spanish seen live) and a count-of-1 aggregate renders "1 marketplace ratings" — judge both on the Fold eyeball and tell Claude if you want a language filter or singular/plural fix.

  2. One `pnpm --filter @doge-buddy/ops run-sourcing --max-winners 2` end-to-end (this may be the same run as the "Sourcing market-price LIVE CHECK" above — same command, both checks ride it). **Pass:** the proposal summary shows `N image(s)`; the admin proposal page shows the highlights/specs/what's-in-box preview (Task 4b's human gate); the listed product page shows gallery/highlights/specs/badges; switching variant changes the image. The per-variant `file` on `ProductVariantSetInput` was already introspection-verified at design time — this run exercises its *runtime* behavior. **Also record for observation** (not pass/fail): does `productSet` dedupe identical variant `file.originalSource` values, and where do variant files land in media order (the first media image drives `featuredImage` — collection cards and the OG image use it).

  3. Eyeball the product page on the Fold (mobile-first).

  4. After the probe: update `docs/cj-api-notes.md`'s "Still unverified" list with what the run proved (wire shape AND points cost) — it stays "Still unverified" until this runs; don't pre-claim it.

- [ ] ⚪ **CJ wallet top-up ~$150** (Phase 7 canary). 🔴 blocks the first real order. Top-up is manual only — no API.
- [ ] ⚪ **Policy pages → Shopify Settings** (Phase 7). Paste the `POLICY_COPY` text (`packages/core/src/policies.ts` — single-sourced; the storefront renders it and the agent quotes it) into Shopify Settings → Policies and review/finalize before launch. **Rewritten 2026-08-30 to match your no-refund stance:** returns = *All sales are final* (change of mind: keep it, discount code at our discretion) + *Damaged, defective, or wrong items* (photo within 14 days → return instructions, customer pays return shipping → replacement only after the return is received AND inspected, refund only if we can't replace); shipping = reship for non-delivery, refund only if we can't reship. Legally load-bearing: a no-refund policy is only enforceable when conspicuously posted (CA Civ. Code §1723 / NY GBL §218-a default to a 30-day return right otherwise), and non-delivery must still end in reship-or-refund (FTC Mail/Internet Order Rule) — refusing those turns into chargebacks that cost more than the refund.
- [ ] ⚪ **Business checks before launch** (Phase 7): Shopify Payments setup, US tax registrations in Shopify Tax, general liability insurance for the LLC (recommended), policy pages review.

- [ ] ⚪ **Store-transfer gotchas to re-verify at Phase 7 cutover** (carried from the never-sent Shopify support question, since the client-transfer path was taken unconfirmed): whether app installs + Admin API credentials, custom domains, and Shopify Payments configuration survive the transfer to your merchant account — budget time to re-create the `doge-buddy` app and re-issue credentials if they don't.

---

*Maintained by Claude; last updated 2026-08-31 (catalog P0 BUILT, branch `catalog-p0`; runway B14
is its live tier — canary is still next after that). When you complete an item, check it off and
tell Claude — especially the credential items, so live verification can run.*

**Next build session starts here →** **Product page v2 BUILT 2026-09-01 on branch
`product-page-v2` (worktree) — spec + plan in
`docs/superpowers/{specs,plans}/2026-09-01-product-page-v2*`, all 17 tasks committed, code+tests
green (typecheck clean; the two known-benign dev-DB failures noted above). Next: Robert's
merge/push call, then the two live checks (the `backfill-listings` v2 run, then one
`run-sourcing --max-winners 2` — see "Product page v2 LIVE CHECK" above), THEN sourcing upgrade
#2's spec (Google Trends rising related queries) after the market-price live check.**
Also pending: sourcing upgrade 1 (market-price tool + 1.3× gate) is **MERGED to `main` 2026-09-01** (spec `2026-09-01-sourcing-market-price-design.md`; push is Robert's) — its **LIVE CHECK is the "Sourcing market-price LIVE CHECK" item above** (full command, flags, Railway-shell gotcha, pass criteria). Owner items before it: `SERPAPI_KEY` on the Railway ops service, and the SerpApi plan's monthly search quota (design assumed 250/mo; if it's 100, lower `SERPAPI_MAX_REQUESTS_PER_RUN` to 15 before a build week). Upgrade (2) — Google Trends rising related queries — gets its spec after the live check. Still queued behind it: runway **B14** (`seed-collections` → `backfill-listings --dry-run` then real →
one manual `run-sourcing --max-winners 2` → force an `inventory.sync` check → flip
`workflow.sourcing.mode` to `auto` for the build-week runs → back to `manual` after). Once the
build-week runs land ~40+ products, next is `docs/LAUNCH-BACKLOG.md` **P1** (product page image
gallery + structured content, related products, home page category tiles, kill the skeleton
blog, SEO fields at listing time, About page). Older reactive jobs still pending in the
meantime: print `POLICY_COPY` as plain text when asked (runway B6), parse the DMARC aggregate
reports before the `p=quarantine` flip (B12), watch the self-purchase end-to-end and close
Tier-2 #4 (`openCjDispute` on the real supplier order) during the canary (C18), and build the
auto-mode deprecation digest FYI before C19. Tools on hand: `inspect-mailbox`,
`seed-refund-proposal`, `read-refund-state`, `redeliver-apply` (all `pnpm --filter
@doge-buddy/ops …`); Claude's raw writes to the Railway DB are classifier-blocked — hand Robert
the SQL. Test-address rule: repeat-complainant counts tickets (the form too), so from any test
address only ever reply on existing threads; Outlook.com silently drops first-contact mail from
support@ until reputation builds. Contact form: LIVE 2026-08-31 (spec
`2026-08-31-contact-form-design.md`, findings A/B/C at its end).
