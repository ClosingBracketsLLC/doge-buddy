import { gmailSyncState, supportMessages, supportTickets, type createDb } from '@doge-buddy/db'
import {
  GmailApiError,
  HistoryExpiredError,
  isMessageGone,
  type GmailClient,
  type HistoryRecord,
  type NormalizedMessage,
} from '@doge-buddy/gmail'
import { and, eq, inArray, lt, ne, sql } from 'drizzle-orm'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

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
  let ticket = await findTicketByThread(ctx.deps.db, meta.threadId)
  if (!addressed && !ticket) return

  const full = await getMessageOrSkip(ctx, messageId, 'full')
  if (!full) return

  // Step 4: the SENT label is the SOLE outbound signal. From-header claims are attacker-forgeable
  // (DMARC is p=none) and are never used for direction.
  const direction = full.labelIds.includes('SENT') ? 'outbound' : 'inbound'

  if (!ticket) {
    ticket = await createTicket(ctx.deps.db, full, direction)
  }

  // Step 5: the insert IS the side-effect gate. No row returned = seen before = do nothing.
  const [inserted] = await ctx.deps.db
    .insert(supportMessages)
    .values({
      ticketId: ticket.id,
      gmailMessageId: full.id,
      direction,
      fromEmail: full.fromAddr,
      bodyText: full.bodyText,
      rfcMessageId: full.rfcMessageId,
      sentAt: full.internalDate,
    })
    .onConflictDoNothing({ target: supportMessages.gmailMessageId })
    .returning({ id: supportMessages.id })

  if (!inserted) return
  ctx.result.insertedMessages += 1
  if (direction === 'outbound') return

  ctx.newInboundTicketIds.add(ticket.id)

  // GREATEST, not assignment: history can hand us an older message after a newer one, and the
  // ticket's "latest customer contact" must never move backwards. (GREATEST ignores NULLs.)
  await ctx.deps.db
    .update(supportTickets)
    .set({
      lastInboundAt: sql`greatest(${supportTickets.lastInboundAt}, ${full.internalDate.toISOString()}::timestamptz)`,
    })
    .where(eq(supportTickets.id, ticket.id))

  // Guarded reopen — an `escalated` ticket is the owner's and stays escalated. Runs BEFORE the
  // tripwire so a reopened ticket with escalation-class content still ends up escalated.
  await ctx.deps.db
    .update(supportTickets)
    .set({ status: 'new' })
    .where(and(eq(supportTickets.id, ticket.id), inArray(supportTickets.status, ['resolved', 'waiting_on_customer'])))

  // Step 6: the code tripwire.
  const keyword = tripwireHit(full.subject, full.bodyText)
  if (keyword) {
    const escalated = await ctx.deps.db
      .update(supportTickets)
      .set({ status: 'escalated', escalationReason: `tripwire: ${keyword}` })
      .where(and(eq(supportTickets.id, ticket.id), ne(supportTickets.status, 'escalated')))
      .returning({ id: supportTickets.id })
    if (escalated.length > 0) ctx.result.tripwiredTicketIds.push(ticket.id)
  }

  // Step 7.
  await applyLabel(ctx, full.id, NEW_LABEL)
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

async function findTicketByThread(db: Db, threadId: string): Promise<{ id: string } | undefined> {
  const [row] = await db
    .select({ id: supportTickets.id })
    .from(supportTickets)
    .where(eq(supportTickets.gmailThreadId, threadId))
  return row
}

/**
 * `customer_email` is the parsed From addr-spec; a thread whose first ingested message is OUTBOUND
 * (the owner mailed the customer first, or ingest started mid-thread) takes it from the To instead.
 * `onConflictDoNothing` + re-read covers a concurrent poll creating the same thread's ticket.
 */
async function createTicket(
  db: Db,
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

interface LabelCache {
  resolve(name: string): Promise<string>
  invalidate(): void
}

function createLabelCache(gmail: GmailClient): LabelCache {
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
 * exactly once.
 */
async function applyLabel(ctx: IngestContext, messageId: string, name: string): Promise<void> {
  try {
    await ctx.deps.gmail.modifyMessage(messageId, { addLabelIds: [await ctx.labels.resolve(name)] })
    return
  } catch (err) {
    if (!isStaleLabelError(err)) {
      await warnLabelFailure(ctx, messageId, name, err)
      return
    }
    ctx.labels.invalidate()
  }

  try {
    await ctx.deps.gmail.modifyMessage(messageId, { addLabelIds: [await ctx.labels.resolve(name)] })
  } catch (err) {
    await warnLabelFailure(ctx, messageId, name, err)
  }
}

function isStaleLabelError(err: unknown): boolean {
  return err instanceof GmailApiError && (err.status === 400 || err.status === 404)
}

async function warnLabelFailure(ctx: IngestContext, messageId: string, name: string, err: unknown): Promise<void> {
  await ctx.deps.alert('warning', 'support_label_failed', {
    messageId,
    label: name,
    error: err instanceof Error ? err.message : String(err),
  })
}
