import { gmailSyncState, supportMessages, supportTickets, type createDb } from '@doge-buddy/db'
import {
  GmailApiError,
  HistoryExpiredError,
  isMessageGone,
  type GmailClient,
  type HistoryRecord,
  type NormalizedMessage,
} from '@doge-buddy/gmail'
import { and, count, desc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm'
import { clearRedraftCycle } from './redraft.ts'

type Db = ReturnType<typeof createDb>['db']
/** The type of the callback's `tx` parameter inside `db.transaction(async (tx) => {...})` — the
 * helpers below (`findTicketByThread`, `createTicket`, `findFloodFoldTarget`) run under either a
 * plain `Db` (nothing to be atomic with) or this transaction-scoped handle (IMPORTANT 3). */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type DbOrTx = Db | Tx
export type Alert = (
  severity: 'info' | 'warning' | 'critical',
  kind: string,
  detail: Record<string, unknown>,
) => Promise<void>

/**
 * The deterministic escalation floor (spec §2.6). A plain case-insensitive substring screen over
 * subject+body — deliberately dumb: it cannot be starved by the triage cap or steered by prompt
 * injection. Over-matching (e.g. "vet" inside "velvet") is the safe direction: it escalates to a
 * human, it never suppresses.
 */
export const TRIPWIRE_KEYWORDS = [
  'chargeback', 'dispute', 'lawsuit', 'attorney', 'legal action', 'injury', 'hurt', 'vet', 'recall',
] as const

export const NEW_LABEL = 'DogeBuddy/New'
/** Applied by triage (spec §3), not here — kept alongside NEW_LABEL so the two label names live together. */
export const SPAM_LABEL = 'DogeBuddy/Spam'

/**
 * Per-sender flood bound (spec §3): once one `customer_email` has created this many tickets in a
 * UTC day, further NEW threads from that sender fold into their newest existing ticket as messages
 * instead of creating more. An attacker must not be able to starve triage's per-cycle budget or
 * page the owner's phone at will just by opening threads.
 */
export const MAX_TICKETS_PER_SENDER_PER_DAY = 5
/** Newest N `<message-id>` tokens of In-Reply-To + References consulted by the thread-id fallback. */
const REFERENCE_LOOKUP_MAX_TOKENS = 20

/** The single-row primary key of `gmail_sync_state`. */
const SYNC_STATE_ID = 1

export interface IngestDeps {
  db: Db
  gmail: GmailClient
  supportAddress: string
  alert: Alert
  now?: () => Date
}

export interface IngestResult {
  /** Message rows this run actually inserted (both directions) — re-seen messages never count. */
  insertedMessages: number
  /** Tickets that received a first-inserted INBOUND message this run. */
  newInboundTicketIds: string[]
  /** Tickets this run's tripwire actually flipped to `escalated`. */
  tripwiredTicketIds: string[]
}

/** Returns the first TRIPWIRE_KEYWORDS entry present in subject+body, or null. */
export function tripwireHit(subject: string | null, body: string | null): string | null {
  const haystack = `${subject ?? ''}\n${body ?? ''}`.toLowerCase()
  for (const keyword of TRIPWIRE_KEYWORDS) {
    if (haystack.includes(keyword)) return keyword
  }
  return null
}

interface IngestContext {
  deps: IngestDeps
  supportAddress: string
  labels: LabelCache
  result: IngestResult
  newInboundTicketIds: Set<string>
  now: () => Date
  /** Senders already warned about this poll — the flood alert is one per sender per poll, not per message. */
  floodAlerted: Set<string>
}

/**
 * One incremental Gmail poll (spec §2 steps 1–8): walk history since the stored id, fetch metadata
 * for each added message, filter to support mail, and upsert tickets/messages with EVERY side
 * effect keyed on the message row actually inserting — which is what makes crash replay (and the
 * resync path) free of reopen storms, duplicate escalations, and label churn.
 *
 * `HistoryExpiredError` from the incremental walk is caught and answered with a bounded resync
 * (see `runResync`); any other error propagates.
 */
export async function runIngest(deps: IngestDeps): Promise<IngestResult> {
  const now = deps.now ?? (() => new Date())
  const supportAddress = deps.supportAddress.toLowerCase()
  const result: IngestResult = { insertedMessages: 0, newInboundTicketIds: [], tripwiredTicketIds: [] }

  // Step 1: seed-on-null. A fresh mailbox ingests nothing — it only remembers where to start.
  const [state] = await deps.db
    .select({ lastHistoryId: gmailSyncState.lastHistoryId })
    .from(gmailSyncState)
    .where(eq(gmailSyncState.id, SYNC_STATE_ID))

  if (state?.lastHistoryId == null) {
    const profile = await deps.gmail.getProfile()
    const seeded = BigInt(profile.historyId)
    await deps.db
      .insert(gmailSyncState)
      .values({ id: SYNC_STATE_ID, lastHistoryId: seeded })
      .onConflictDoUpdate({ target: gmailSyncState.id, set: { lastHistoryId: seeded, updatedAt: now() } })
    return result
  }

  const ctx: IngestContext = {
    deps,
    supportAddress,
    labels: createLabelCache(deps.gmail),
    result,
    newInboundTicketIds: new Set(),
    now,
    floodAlerted: new Set(),
  }

  try {
    // Step 2: walk every history page from the stored id. Nothing is processed until every page
    // has been fetched, so a HistoryExpiredError here (even on a later page) never leaves a
    // partially-applied incremental batch behind — there is nothing to unwind.
    const records: HistoryRecord[] = []
    let pageToken: string | undefined
    do {
      const page = await deps.gmail.listHistory({ startHistoryId: state.lastHistoryId.toString(), pageToken })
      records.push(...page.records)
      pageToken = page.nextPageToken
    } while (pageToken)

    const seen = new Set<string>()
    for (const record of records) {
      for (const added of record.messagesAdded) {
        if (seen.has(added.id)) continue
        seen.add(added.id)
        await ingestMessageId(ctx, added.id)
      }
    }

    // Step 8: advance to the max history-RECORD id (BigInt compare — historyIds are uint64 strings,
    // so a lexicographic max corrupts state), and only after this batch's upserts have committed.
    // The guard is defence against any residual overlap with a concurrent poll.
    let maxRecordId: bigint | null = null
    for (const record of records) {
      const id = BigInt(record.id)
      if (maxRecordId == null || id > maxRecordId) maxRecordId = id
    }
    if (maxRecordId != null) {
      await deps.db
        .update(gmailSyncState)
        .set({ lastHistoryId: maxRecordId, updatedAt: now() })
        .where(and(eq(gmailSyncState.id, SYNC_STATE_ID), lt(gmailSyncState.lastHistoryId, maxRecordId)))
    }
  } catch (err) {
    if (!(err instanceof HistoryExpiredError)) throw err
    await runResync(ctx, now)
  }

  result.newInboundTicketIds = [...ctx.newInboundTicketIds]
  return result
}

/**
 * The bounded, resumable resync (spec §2 step 2). `listHistory` 404s once its start id has aged
 * out of Gmail's retention window — there is no incremental diff to recover at that point, so this
 * rebuilds from a scoped mailbox scan instead: support-addressed mail, plus every already-known
 * ticket thread (for follow-ups that dropped the address from every header).
 *
 * Ordering is load-bearing, per the spec:
 *   1. Capture `getProfile().historyId` FIRST, before touching the DB at all. Anything that lands
 *      in the mailbox from this instant forward is still covered by the NEXT poll's incremental
 *      walk starting from this id — the resync only has to account for what happened before it.
 *   2. `listMessages({ q, includeSpamTrash: true })`, page-by-page: each page's ids run through the
 *      SAME per-message path as the incremental walk (`ingestMessageId`), and that path's insert
 *      gate is what makes a page safe to redo — a message already ingested (including by a prior,
 *      interrupted resync attempt) is a no-op, never a reopen or a re-label. Each page's writes are
 *      durable before the next page is even requested, so a failure here needs nothing to be
 *      unwound — only the caller retrying.
 *   3. Then every already-known ticket thread's LIVE messages via `getThread` — `q` cannot see a
 *      follow-up that dropped `SUPPORT_ADDRESS` from every header, but its thread is already ours.
 *      Ids already processed by step 2 are skipped, so a thread whose messages also matched the
 *      q-filter is never double-fetched. A `getThread` failure (e.g. a thread the owner deleted
 *      from Gmail entirely, 404ing) is caught PER THREAD and skipped — never allowed to fail the
 *      whole resync. An uncaught failure here would be a poison pill: the sync-state UPDATE (step
 *      4) would never run, so every subsequent poll would hit `HistoryExpiredError` again, re-enter
 *      this same resync, and die on the same dead thread forever. Skipped threads are reported in
 *      one aggregate warning alert (mirroring §2.7's label-failure pattern) rather than failing the
 *      job.
 *   4. Only THEN store the PRE-captured historyId, guarded by the same comparator as the normal
 *      path. Storing last is what makes step 1's early capture safe: if the resync itself is
 *      interrupted, nothing is stored, so the next poll either sees history-expired again (and
 *      redoes the bounded scan) or, if the id turned out still valid, resumes incrementally — and
 *      either way nothing already-committed gets a side effect twice.
 */
async function runResync(ctx: IngestContext, now: () => Date): Promise<void> {
  const { deps, supportAddress } = ctx

  const profile = await deps.gmail.getProfile()
  const preCapturedHistoryId = BigInt(profile.historyId)

  const seen = new Set<string>()

  const q = `to:${supportAddress} OR cc:${supportAddress} OR deliveredto:${supportAddress}`
  let pageToken: string | undefined
  do {
    const page = await deps.gmail.listMessages({ q, pageToken, includeSpamTrash: true })
    for (const { id } of page.ids) {
      if (seen.has(id)) continue
      seen.add(id)
      await ingestMessageId(ctx, id)
    }
    pageToken = page.nextPageToken
  } while (pageToken)

  const ticketThreads = await deps.db
    .selectDistinct({ gmailThreadId: supportTickets.gmailThreadId })
    .from(supportTickets)
  const skippedThreads: { threadId: string; error: unknown }[] = []
  for (const { gmailThreadId } of ticketThreads) {
    let thread: { messages: { id: string }[] }
    try {
      thread = await deps.gmail.getThread(gmailThreadId)
    } catch (err) {
      // A thread the owner deleted from Gmail entirely (or any other getThread failure) must not
      // wedge the resync: an uncaught throw here would skip the step-4 store below, so the NEXT
      // poll would hit HistoryExpiredError again, re-enter this resync, and die on the same thread
      // forever. Skip it and keep going — the rest of the mailbox still needs to be swept.
      skippedThreads.push({ threadId: gmailThreadId, error: err })
      continue
    }
    for (const { id } of thread.messages) {
      if (seen.has(id)) continue
      seen.add(id)
      await ingestMessageId(ctx, id)
    }
  }

  if (skippedThreads.length > 0) {
    await deps.alert('warning', 'support_resync_thread_failed', {
      threadIds: skippedThreads.map((s) => s.threadId),
      errors: skippedThreads.map((s) => (s.error instanceof Error ? s.error.message : String(s.error))),
    })
  }

  await deps.db
    .update(gmailSyncState)
    .set({ lastHistoryId: preCapturedHistoryId, updatedAt: now() })
    .where(and(eq(gmailSyncState.id, SYNC_STATE_ID), lt(gmailSyncState.lastHistoryId, preCapturedHistoryId)))
}

/** What one message's transaction actually committed — enough for the caller to fire the
 * (necessarily post-commit) external calls and update in-memory bookkeeping accordingly. */
interface MessageOutcome {
  ticketId: string
  inserted: boolean
  direction: 'inbound' | 'outbound'
  /** True iff this message folded onto an existing ticket under the flood bound. */
  folded: boolean
  /** The tripwire keyword that actually flipped the ticket to escalated this call, or null. */
  tripwireKeyword: string | null
}

/**
 * Steps 3–7 for a single message id. Idempotent and side-effect-safe on re-seen messages, so the
 * resync path can reuse it verbatim.
 */
async function ingestMessageId(ctx: IngestContext, messageId: string): Promise<void> {
  // Step 3: metadata first — bodies are read ONLY for mail that passes the support filter.
  const meta = await getMessageOrSkip(ctx, messageId, 'metadata')
  if (!meta) return

  // Gmail autosaves a new DRAFT message id per revision; TRASH is deleted mail. Neither is a
  // support event, and ingesting drafts would flood the thread with unsent snapshots.
  if (meta.labelIds.includes('DRAFT') || meta.labelIds.includes('TRASH')) return

  const addressed = [...meta.to, ...meta.cc, ...meta.deliveredTo].includes(ctx.supportAddress)
  // Thread id first; then the RFC 2822 chain. Gmail's thread id is NOT a reliable conversation key
  // across the spam boundary — a customer whose first email was spam-foldered gets a brand-new
  // thread id on their (INBOX) follow-up, so thread-keyed lookup alone opens a second ticket for the
  // same conversation, which then counts toward repeat-complainant (seen live 2026-08-30). A reply
  // that names a message we already hold belongs to that message's ticket.
  const existingTicket =
    (await findTicketByThread(ctx.deps.db, meta.threadId)) ?? (await findTicketByReferences(ctx.deps.db, meta))
  if (!addressed && !existingTicket) return

  const full = await getMessageOrSkip(ctx, messageId, 'full')
  if (!full) return

  // Step 4: the SENT label is the SOLE outbound signal. From-header claims are attacker-forgeable
  // (DMARC is p=none) and are never used for direction.
  const direction = full.labelIds.includes('SENT') ? 'outbound' : 'inbound'

  // IMPORTANT 3: everything from here through the tripwire write is a DB side effect that must be
  // atomic with the message insert — a crash between the insert and the tripwire update used to
  // lose the escalation permanently (the insert gate makes a replay see the message as already
  // seen, so the tripwire that would have caught it on that same message never runs again). One
  // transaction makes "the message exists" and "the ticket reflects it" a single fact.
  //
  // The flood alert and applyLabel are deliberately NOT in here even though the spec's fix
  // description lists "flood handling" alongside the DB writes: both are external network calls
  // (a Telegram alert, a Gmail API call), and holding a Postgres transaction open across either
  // one is exactly the kind of thing this fix exists to avoid doing more of — a slow/hung external
  // call would hold the transaction (and whatever it's touched) open for no reason. They run after
  // commit instead, gated on what the transaction actually committed.
  const outcome = await ctx.deps.db.transaction(async (tx) => {
    let ticket = existingTicket
    let folded = false

    // Per-sender flood bound: a new thread from a sender who has already opened
    // MAX_TICKETS_PER_SENDER_PER_DAY tickets today lands on their newest ticket instead of
    // opening another one. Inbound-only — an outbound-first thread is the owner mailing out.
    if (!ticket && direction === 'inbound') {
      const foldTarget = await findFloodFoldTarget(tx, ctx.now(), full.fromAddr)
      if (foldTarget) {
        ticket = foldTarget
        folded = true
      }
    }
    if (!ticket) {
      ticket = await createTicket(tx, full, direction)
    }

    // Step 5: the insert IS the side-effect gate. No row returned = seen before = do nothing.
    const [inserted] = await tx
      .insert(supportMessages)
      .values({
        ticketId: ticket.id,
        gmailMessageId: full.id,
        direction,
        fromEmail: full.fromAddr,
        bodyText: full.bodyText,
        rfcMessageId: full.rfcMessageId,
        authResults: full.authenticationResults,
        sentAt: full.internalDate,
      })
      .onConflictDoNothing({ target: supportMessages.gmailMessageId })
      .returning({ id: supportMessages.id })

    if (!inserted) return { ticketId: ticket.id, inserted: false, direction, folded, tripwireKeyword: null }
    if (direction === 'outbound') return { ticketId: ticket.id, inserted: true, direction, folded, tripwireKeyword: null }

    // GREATEST, not assignment: history can hand us an older message after a newer one, and the
    // ticket's "latest customer contact" must never move backwards. (GREATEST ignores NULLs.)
    // `gmail_spam` moves in step: it describes the message that WINS last_inbound_at, so it only
    // takes this message's Gmail-folder fact when this message is that latest one. Both columns
    // are set in the ONE statement so the CASE reads the row's pre-update last_inbound_at.
    const inboundAt = full.internalDate.toISOString()
    await tx
      .update(supportTickets)
      .set({
        lastInboundAt: sql`greatest(${supportTickets.lastInboundAt}, ${inboundAt}::timestamptz)`,
        gmailSpam: sql`case
          when ${inboundAt}::timestamptz >= coalesce(${supportTickets.lastInboundAt}, '-infinity'::timestamptz)
          then ${full.labelIds.includes('SPAM')}
          else ${supportTickets.gmailSpam}
        end`,
      })
      .where(eq(supportTickets.id, ticket.id))

    // Guarded reopen — an `escalated` ticket is the owner's and stays escalated. Runs BEFORE the
    // tripwire so a reopened ticket with escalation-class content still ends up escalated.
    // The triage AND agent failure budgets reset with the reopen (spec §3): a new conversation
    // gets its own attempts rather than inheriting a stale count from the last one.
    await tx
      .update(supportTickets)
      // redraft-cycle clear (see support/redraft.ts): defense-in-depth. Both source states
      // (`resolved`/`waiting_on_customer`) already had these columns cleared on entry, so this is
      // redundant today — but including it makes the "a `new` ticket never carries a stale redraft
      // cycle" invariant self-contained here rather than relying on transitivity through every
      // upstream writer that parked the ticket.
      .set({ status: 'new', triageFailureCount: 0, agentFailureCount: 0, ...clearRedraftCycle() })
      .where(and(eq(supportTickets.id, ticket.id), inArray(supportTickets.status, ['resolved', 'waiting_on_customer'])))

    // Step 6: the code tripwire.
    const keyword = tripwireHit(full.subject, full.bodyText)
    let tripwireFlipped = false
    if (keyword) {
      // CRITICAL 1: every UPDATE that transitions a ticket INTO 'escalated' must clear
      // escalation_notified_at, or a ticket that was already escalated+notified once, then
      // resolved, then re-escalated by a fresh tripwire hit stays permanently invisible to
      // notifyPendingEscalations' `escalation_notified_at IS NULL` selection — the owner is never
      // paged for the reopened case. The admin Escalate POST is the one exception (routes.ts).
      const escalated = await tx
        .update(supportTickets)
        // redraft-cycle clear (see support/redraft.ts) — keep beside escalationNotifiedAt.
        .set({
          status: 'escalated',
          escalationReason: `tripwire: ${keyword}`,
          escalationNotifiedAt: null,
          ...clearRedraftCycle(),
        })
        .where(and(eq(supportTickets.id, ticket.id), ne(supportTickets.status, 'escalated')))
        .returning({ id: supportTickets.id })
      tripwireFlipped = escalated.length > 0
    }

    const outcome: MessageOutcome = {
      ticketId: ticket.id,
      inserted: true,
      direction,
      folded,
      tripwireKeyword: tripwireFlipped ? keyword : null,
    }
    return outcome
  })

  if (!outcome.inserted) return
  ctx.result.insertedMessages += 1
  if (outcome.direction === 'outbound') return

  ctx.newInboundTicketIds.add(outcome.ticketId)

  // Keyed on the insert like every other side effect, and deduped per sender per poll so a sender
  // opening 50 threads in one minute pages the owner once, not 50 times.
  if (outcome.folded && full.fromAddr && !ctx.floodAlerted.has(full.fromAddr)) {
    ctx.floodAlerted.add(full.fromAddr)
    await ctx.deps.alert('warning', 'support_sender_flood', {
      customerEmail: full.fromAddr,
      foldedOntoTicketId: outcome.ticketId,
      maxPerDay: MAX_TICKETS_PER_SENDER_PER_DAY,
    })
  }

  if (outcome.tripwireKeyword) ctx.result.tripwiredTicketIds.push(outcome.ticketId)

  // Step 7.
  await applyLabel(ctx.deps.gmail, ctx.labels, ctx.deps.alert, full.id, NEW_LABEL)
}

/** A 404 here is routine (deleted drafts and mail) — skip the message, never fail the poll. */
async function getMessageOrSkip(
  ctx: IngestContext,
  messageId: string,
  format: 'metadata' | 'full',
): Promise<NormalizedMessage | null> {
  try {
    return await ctx.deps.gmail.getMessage(messageId, { format })
  } catch (err) {
    if (isMessageGone(err)) return null
    throw err
  }
}

/**
 * The RFC 2822 fallback for `findTicketByThread`: every `<…>` token in `In-Reply-To` and
 * `References` is looked up against the message ids we have already ingested; a hit means this
 * message continues that ticket's conversation regardless of the Gmail thread id it arrived under.
 * Newest matching message wins (a `References` chain can span several of ours). Tokens are capped
 * so a hostile 10KB `References` header cannot turn into a 10KB `IN (...)` list.
 */
async function findTicketByReferences(
  db: DbOrTx,
  meta: { inReplyTo: string | null; references: string | null },
): Promise<{ id: string } | undefined> {
  const tokens = [...`${meta.inReplyTo ?? ''} ${meta.references ?? ''}`.matchAll(/<[^<>\s]+>/g)]
    .map((m) => m[0])
    .slice(-REFERENCE_LOOKUP_MAX_TOKENS)
  if (tokens.length === 0) return undefined
  const [row] = await db
    .select({ id: supportMessages.ticketId })
    .from(supportMessages)
    .where(inArray(supportMessages.rfcMessageId, tokens))
    .orderBy(desc(supportMessages.sentAt))
    .limit(1)
  return row ? { id: row.id } : undefined
}

async function findTicketByThread(db: DbOrTx, threadId: string): Promise<{ id: string } | undefined> {
  const [row] = await db
    .select({ id: supportTickets.id })
    .from(supportTickets)
    .where(eq(supportTickets.gmailThreadId, threadId))
  return row
}

/**
 * The flood bound's lookup (spec §3): null means "create the ticket normally". Non-null is the
 * sender's NEWEST ticket, which this message joins instead of opening yet another one — the
 * message itself is never dropped, so the tripwire, the reopen, and the label all still run on it.
 * Runs inside `ingestMessageId`'s transaction (IMPORTANT 3), so it takes `tx` and the already-read
 * `now` directly rather than pulling them off `ctx`.
 */
async function findFloodFoldTarget(tx: Tx, now: Date, customerEmail: string | null): Promise<{ id: string } | null> {
  if (!customerEmail) return null

  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const [today] = await tx
    .select({ value: count() })
    .from(supportTickets)
    .where(and(eq(supportTickets.customerEmail, customerEmail), gte(supportTickets.createdAt, midnight)))

  if ((today?.value ?? 0) < MAX_TICKETS_PER_SENDER_PER_DAY) return null

  const [newest] = await tx
    .select({ id: supportTickets.id })
    .from(supportTickets)
    .where(eq(supportTickets.customerEmail, customerEmail))
    .orderBy(desc(supportTickets.createdAt))
    .limit(1)
  return newest ?? null
}

/**
 * `customer_email` is the parsed From addr-spec; a thread whose first ingested message is OUTBOUND
 * (the owner mailed the customer first, or ingest started mid-thread) takes it from the To instead.
 * `onConflictDoNothing` + re-read covers a concurrent poll creating the same thread's ticket.
 */
async function createTicket(
  db: DbOrTx,
  message: NormalizedMessage,
  direction: 'inbound' | 'outbound',
): Promise<{ id: string }> {
  const customerEmail = direction === 'inbound' ? message.fromAddr : (message.to[0] ?? null)
  const [created] = await db
    .insert(supportTickets)
    .values({
      gmailThreadId: message.threadId,
      customerEmail,
      subject: message.subject,
      status: 'new',
    })
    .onConflictDoNothing({ target: supportTickets.gmailThreadId })
    .returning({ id: supportTickets.id })

  if (created) return created

  const existing = await findTicketByThread(db, message.threadId)
  if (!existing) throw new Error(`support ticket for thread ${message.threadId} vanished after conflict`)
  return existing
}

export interface LabelCache {
  resolve(name: string): Promise<string>
  invalidate(): void
}

/** Shared with triage (spec §3's `DogeBuddy/Spam`), so both label writers use one id cache shape. */
export function createLabelCache(gmail: GmailClient): LabelCache {
  let byName: Map<string, string> | null = null

  async function list(): Promise<Map<string, string>> {
    const labels = await gmail.listLabels()
    byName = new Map(labels.map((l) => [l.name, l.id]))
    return byName
  }

  return {
    async resolve(name) {
      const cached = byName ?? (await list())
      const hit = cached.get(name)
      if (hit) return hit
      try {
        const created = await gmail.createLabel(name)
        cached.set(created.name, created.id)
        return created.id
      } catch (err) {
        // A duplicate-name error means someone else created it — re-list for its id.
        const relisted = await list()
        const id = relisted.get(name)
        if (id) return id
        throw err
      }
    },
    invalidate() {
      byName = null
    },
  }
}

/**
 * Label failures are warning alerts, never job failures (spec §2.7). A 400/404 from `modifyMessage`
 * means the cached label id is stale (the owner deleted/recreated the label): invalidate and retry
 * exactly once. Exported because triage applies `DogeBuddy/Spam` under exactly these rules.
 */
export async function applyLabel(
  gmail: GmailClient,
  labels: LabelCache,
  alert: Alert,
  messageId: string,
  name: string,
): Promise<void> {
  try {
    await gmail.modifyMessage(messageId, { addLabelIds: [await labels.resolve(name)] })
    return
  } catch (err) {
    if (!isStaleLabelError(err)) {
      await warnLabelFailure(alert, messageId, name, err)
      return
    }
    labels.invalidate()
  }

  try {
    await gmail.modifyMessage(messageId, { addLabelIds: [await labels.resolve(name)] })
  } catch (err) {
    await warnLabelFailure(alert, messageId, name, err)
  }
}

function isStaleLabelError(err: unknown): boolean {
  return err instanceof GmailApiError && (err.status === 400 || err.status === 404)
}

async function warnLabelFailure(alert: Alert, messageId: string, name: string, err: unknown): Promise<void> {
  await alert('warning', 'support_label_failed', {
    messageId,
    label: name,
    error: err instanceof Error ? err.message : String(err),
  })
}
