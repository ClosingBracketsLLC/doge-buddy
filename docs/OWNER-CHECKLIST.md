# Robert's Checklist

Things only you can do, with **explicit blocker status**. Build work continues regardless — nothing here stops Claude from writing and testing code against fixtures and the mock supplier. Items are ordered by when they'll be needed.

Legend: 🔴 **BLOCKER** (something specific stalls until done) · 🟡 soon (needed to *verify live*, not to build) · ⚪ later phase.

---

## Now / this week

- [x] ~~Tap APPROVE on a proposal on your phone.~~ **Done (2026-08-25) — and it closed BOTH open live tiers.** You approved the *Low Noise Pet Hair Clipper* **from the admin dashboard** (Telegram login-link → `/admin/proposals` → approve — exactly Phase 4B's walk) and rejected the *Plush Round Dog Bed* via the Telegram link. The apply worker created ACTIVE Shopify product `gid://shopify/Product/8949329592408` ($54.99, SKU `CJJJCWGY01635-Style D`) with its CJ fulfillment mapping 6 seconds after the tap. **Phase 5 is closed on every tier.**
- [ ] 🟡 **`git push origin main`** — local main is at `a81da1e`, 3 commits ahead of origin: the **refund hard-lock** (refunds are ALWAYS manual — your 2026-08-30 ruling; no setting can auto-approve one any more) and the **promised-action screen fix** (the agent could not answer a return-policy question without the screen escalating it — found on the first real live drafts). **No migration in these three** — but do the 🔴 migration-0007 item under "Phase 6B live bring-up" before or with this push. Railway redeploys on push.
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
- [ ] 🔴 **Confirm migration 0007 is on Railway — run it now if unsure (it's idempotent):**
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
- [ ] 🔴 **Paste this into `/admin/guidance`** (edit freely — it's yours; the hard rules still win
  over it). It replaces whatever coupon wording you wrote earlier:
  > Our stance: we avoid refunds and returns. All sales are final for change of mind — never offer a
  > return or a refund for a product that arrived as described; decline politely and offer discount
  > code SORRY10 (10% off their next order, one use per customer). For damaged, defective, or wrong
  > items: ask for a photo of what arrived and say we'll arrange a replacement at no charge (no
  > return needed); do not offer a refund unless the owner has said a replacement isn't possible. For
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
- [ ] 🟡 **Tier-2 walk (spec §8 + the exit criteria).** Four checks, run with Claude. **Before
  sign-off:** the live `GMAIL_CONTRACT=1` re-record (the item below) must run FIRST — Tier-2 is not
  signed off against stale fixtures, and the re-record updates `client.test.ts`'s call-site id
  literals in the same commit.
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
  domain has reputation. **Left on walk #1:** (a) you confirm ONE conversation in the personal
  Gmail and in Outlook (check Junk); (b) one more email — a return-policy question from the
  outlook.com address — to prove a policy answer now survives the screen.
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
  2. **Bogus-gateway refund, delivered twice.** Place a test order through the test payment gateway
     → let the agent draft a refund → approve it → deliver the apply job a second time → **exactly
     one refund** in the Shopify admin (Shopify's idempotency key covers the fast duplicate; the
     `db-proposal-<id>` refund NOTE is the durable half, since those keys expire in ~24h).
  3. **Follow-up resume across a redeploy.** Reply again on an already-answered ticket, redeploy
     Railway in between, then let the next run go: the session id stays stable and the run's
     transcript shows the prior context (the transcript lives in Postgres, not on Railway's
     ephemeral disk — that separation is exactly what this check proves).
  4. **`openCjDispute` against the CJ sandbox.** A refund proposal that also opens a CJ dispute —
     dispute-WRITE bodies are CJ's only never-live-verified surface, and this closes them.
- [ ] 🟡 **Re-record the Gmail fixtures live** (`GMAIL_CONTRACT=1`) — deferred from the 6B branch
  because `apps/ops/.env` is gitignored and exists only in the main checkout, so run it from there
  after the merge, with one owner-seeded test email in the mailbox first. Heads-up carried from the
  build: a live re-record changes the recorded message/thread ids, so `packages/gmail/test/client.test.ts`'s
  call-site id literals have to be updated in the same commit.
- [ ] 🟡 **BEFORE the first live refund: verify the mutation shape against the pinned 2026-07
  schema.** `RefundInput` / `OrderTransactionInput` are written from documentation, never yet
  executed against a real store. Two specific suspicions to settle first: whether `gateway` is
  nullable on a transaction entry (we send the parent transaction's gateway verbatim), and whether
  each transaction entry needs its own `orderId` alongside the top-level one. A wrong shape here
  fails loudly rather than silently, but it fails on a real order — check the schema first.
- [ ] 🟡 **Right after that test refund, read the state back.** Call `orderRefundState` on the order
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
- [ ] ⚪ **Gmail "Send mail as" check (needed by 6B, not 6A):** in Gmail as `admin@` → Settings → Accounts → confirm `support@dogebuddy.com` is listed under "Send mail as" (add it if not — no verification step for your own alias). 6B's replies go out From: support@.

- [ ] ⚪ **FunkyDori webfont license check** (Phase 2). Not a blocker — Lilita One is the stand-in display face (the `--font-display` token in tailwind.css is the FunkyDori swap point); Poppins is the body face.
- [x] ~~Apply for the Google Trends official API alpha.~~ **Applied (2026-08-24).** Approval is slow (months-to-never per applicant reports) — SerpApi bridges it meanwhile; the Phase 5 trends adapter is swappable, so approval landing later is a drop-in.
- [ ] ⚪ **CJ wallet top-up ~$150** (Phase 7 canary). 🔴 blocks the first real order. Top-up is manual only — no API.
- [ ] ⚪ **Policy pages → Shopify Settings** (Phase 7). Paste the `POLICY_COPY` text (`packages/core/src/policies.ts` — single-sourced; the storefront renders it and the agent quotes it) into Shopify Settings → Policies and review/finalize before launch. **Rewritten 2026-08-30 to match your no-refund stance:** returns = *All sales are final* (change of mind: keep it, discount code at our discretion) + *Damaged, defective, or wrong items* (photo within 14 days → replacement, refund only if we can't replace); shipping = reship for non-delivery, refund only if we can't reship. Legally load-bearing: a no-refund policy is only enforceable when conspicuously posted (CA Civ. Code §1723 / NY GBL §218-a default to a 30-day return right otherwise), and non-delivery must still end in reship-or-refund (FTC Mail/Internet Order Rule) — refusing those turns into chargebacks that cost more than the refund.
- [ ] ⚪ **Business checks before launch** (Phase 7): Shopify Payments setup, US tax registrations in Shopify Tax, general liability insurance for the LLC (recommended), policy pages review.

- [ ] ⚪ **Store-transfer gotchas to re-verify at Phase 7 cutover** (carried from the never-sent Shopify support question, since the client-transfer path was taken unconfirmed): whether app installs + Admin API credentials, custom domains, and Shopify Payments configuration survive the transfer to your merchant account — budget time to re-create the `doge-buddy` app and re-issue credentials if they don't.

---

*Maintained by Claude; last updated 2026-08-30 (refund hard-lock + promised-action screen fix merged to local main; migration-0007 confirmation added; stale items reconciled). When you complete an item, check it off and tell Claude — especially the credential items, so live verification can run.*

**Next build session starts here →** **Finish the 6B live Tier-2 walk; then Phase 7 (canary launch).** Everything is built and reviewed: 6B (the support agent), the reject-with-reason re-draft loop + `/admin/guidance` (`6b26bb3` — pushed and deployed), Phase 7 scoring (nightly + revenue-gated digest, manual mode), and the refund hard-lock + promised-action screen fix (`a81da1e` — local main, UNPUSHED). First: the 🔴 migration-0007 confirmation under "Phase 6B live bring-up" (the `6b26bb3` deploy selects columns only 0007 adds — if it was missed, support ingest is silently down), then Robert pushes `a81da1e`. Then re-run Tier-2 walk #1 from a fresh support email: the agent should now answer a return-policy question without the screen escalating; approve from the phone; verify threading in Gmail AND the outlook.com address; do the 1a marker-header read-back. Walks #2–4 (Bogus-gateway refund delivered twice → one refund; follow-up resume across a redeploy; `openCjDispute` vs the CJ sandbox) and the three carried verifications (`GMAIL_CONTRACT=1` re-record from the main checkout; the `RefundInput`/`OrderTransactionInput` schema check BEFORE the first live refund; the `orderRefundState` read-back after it) follow. **Phase 7** = the canary launch per parent spec §(c)5 — needs the CJ wallet top-up and the policy-page paste (both under "Later phases"). DMARC DNS record still open.
