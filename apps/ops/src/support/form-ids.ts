import { randomUUID } from 'node:crypto'

/**
 * Contact-form tickets (spec §3) have no Gmail message behind their first inbound and no Gmail
 * thread until the ack job creates one. Both ids use this prefix so every Gmail-touching path can
 * tell them apart with one check — `gmail_message_id`/`gmail_thread_id` stay NOT NULL UNIQUE.
 */
export const FORM_ID_PREFIX = 'form:'

export function isGmailMessageId(id: string): boolean {
  return !id.startsWith(FORM_ID_PREFIX)
}

export function formPlaceholderThreadId(ticketId: string): string {
  return `${FORM_ID_PREFIX}${ticketId}`
}

export function isFormPlaceholder(threadId: string): boolean {
  return threadId.startsWith(FORM_ID_PREFIX)
}

export function formMessageId(): string {
  return `${FORM_ID_PREFIX}${randomUUID()}`
}

/**
 * The ack job's CLAIM marker (final review C1). Written over the plain placeholder in a guarded
 * UPDATE *before* `gmail.sendNew`, so a second worker (pg-boss can re-queue a `created` job behind
 * an `active` one) finds a value that no longer matches the guard and stops instead of sending a
 * second acknowledgement.
 *
 * It deliberately keeps the `form:` prefix: `isFormPlaceholder`, the reply worker's hold and the
 * sweep's `LIKE 'form:%'` all still recognise a ticket whose process died mid-send, and the next
 * attempt recovers the already-sent copy through the deterministic `rfc822msgid:` search. The
 * random suffix keeps `gmail_thread_id`'s UNIQUE constraint satisfiable for concurrent claims.
 *
 * The embedded CLAIM TIMESTAMP is what makes the claim recoverable rather than terminal (re-review
 * critical). A process killed between the claim and `sendNew` returning — a Railway redeploy, an
 * OOM, a pg-boss expiry — leaves a sentinel no one owns any more: the retry's `rfc822msgid:` search
 * finds nothing (never sent, or the index still lags) and a claim guarded only on the plain
 * placeholder matches 0 rows forever. `parseSendingSentinel` lets the next attempt see HOW OLD the
 * claim is and take it over once no live worker could still be holding it.
 */
export function formSendingSentinel(ticketId: string, nowMs: number = Date.now()): string {
  return `${FORM_ID_PREFIX}${ticketId}:sending:${nowMs}:${randomUUID()}`
}

const SENDING_SENTINEL_RE = /^form:.+:sending:(\d+):[0-9a-f-]{36}$/

/**
 * Reads the claim timestamp back out of a sending sentinel — `null` for a plain placeholder, a real
 * Gmail thread id, or any shape this version did not write (so an in-flight sentinel from the
 * PREVIOUS deploy, which carried no timestamp, is treated as "not parseable" and left alone rather
 * than reclaimed on a guess; its ticket is recovered by the `rfc822msgid:` search or reported by
 * the sweep, exactly as before).
 */
export function parseSendingSentinel(threadId: string): { claimedAtMs: number } | null {
  const m = SENDING_SENTINEL_RE.exec(threadId)
  if (!m) return null
  const claimedAtMs = Number(m[1])
  return Number.isFinite(claimedAtMs) ? { claimedAtMs } : null
}

/** Matches the plain placeholder AND every sending sentinel for one ticket — the guard the ack's
 * thread swap uses, so a swap still lands after a crash-and-recover on the sentinel. */
export function formThreadIdLikePattern(ticketId: string): string {
  return `${FORM_ID_PREFIX}${ticketId}%`
}
