# Phase 3 pre-work (carried out of the Phase 1 final review)

Deferred items the Phase 1 whole-branch review triaged as fine-to-defer but scheduled before/during Phase 3 (the fulfillment money path). None block the Phase 1 merge.

1. **Stranded-webhook sweep (must land before real webhook traffic).** If `enqueue` fails after the dedup insert, the event row stays `processed_at IS NULL` and the sender's retry is classified duplicate (never re-enqueued). The Phase 3 reconciliation job must sweep `processed_at IS NULL` rows older than N minutes.
2. **`confirmOrder` unit test.** Money-path CJ call currently has zero direct coverage (method/URL/body unasserted). Add in the first Phase 3 task touching ordering.
3. **CJ auth-failure recovery.** A revoked-but-unexpired CJ token throws `CjApiError` with no invalidate-and-retry (Shopify client does this on 401). Add retry-once-after-reauth.
4. **CJ rate limiter is not a mutex; points ledger is in-memory.** Concurrent requests can violate 1 rps; `pointsSpentToday` resets on restart. Fine for Phase 1-3 sequential use; needs a queue/persisted ledger before Phase 5 sourcing volume.
5. **Webhook-audit stale-subscription pruning.** The audit creates missing subs but never removes stale wrong-URL ones (list grows on every URL change; stale endpoints keep receiving).
6. **`webhookProcessHandler` per-job error isolation.** A throwing job fails the whole pg-boss batch; retry duplicates audit rows for already-processed jobs. Phase 3's real routing should process per-job with isolation.
7. **First live CJ `verify-live` run: re-record `order/list` fixtures first.** The `orderNumbers` query param and list-entry field shape are the only money-path FIXTURE-ASSUMPTIONs whose failure mode the sandbox contract harness structurally cannot detect (client-side orderNumber matching now guards mis-returns, but re-record early).
8. **Small cleanups when convenient:** `centsToUsd` helper in core (symmetry with `usdToCents`); dedupe `UserErrorEntry` type in shopify-admin; `mapCjDisputeStatus` table test; mock adapter unknown-id strictness; `usdToCents(1.0049)` double-rounding doc note.

## Reviewer corrections to earlier ledger items (recorded so they don't resurface)

- The T5 "cents÷100 float artifact in query strings" concern is **wrong**: `String(cents/100)` on integer cents always yields the exact shortest decimal — no artifact possible.
- The T11 `||` vs `??` concern is **wrong**: `||` is deliberate — an empty-string external id must fall back to the body hash.
