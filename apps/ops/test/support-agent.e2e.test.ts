import type { SessionStore } from '@anthropic-ai/claude-agent-sdk'
import {
  adminSessions,
  agentRunEvents,
  agentRuns,
  auditLog,
  createDb,
  gmailSyncState,
  orders,
  proposals,
  supportMessages,
  supportTickets,
} from '@doge-buddy/db'
import { createMockGmail, PROPOSAL_MARKER_HEADER, type GmailClient, type MockGmail } from '@doge-buddy/gmail'
import type { DisputeOptions } from '@doge-buddy/supplier'
import { and, asc, desc, eq, inArray, like } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueryFn } from '../src/agents/run-harness.ts'
import type { SupportOutput } from '../src/agents/support-output-schema.ts'
import { SUPPORT_MODEL } from '../src/agents/support-run.ts'
import type { AdminDeps } from '../src/http/admin/routes.ts'
import {
  executeSupportAgentRun,
  SUPPORT_AGENT_QUEUE,
  type SupportAgentJobDeps,
} from '../src/jobs/support-agent-run.ts'
import {
  executeSupportPoll,
  resetSupportPollOnceFlags,
  type SupportPollDeps,
} from '../src/jobs/support-poll-gmail.ts'
import type { OwnerNotification } from '../src/notify/notify.ts'
import { PROPOSAL_REFUND_ISSUED_ACTION } from '../src/proposals/apply-refund.ts'
import {
  PROPOSAL_APPLIED_ACTION,
  PROPOSAL_APPLY_FAILED_ACTION,
  STALE_APPLY_ERROR,
  type ApplyProposalDeps,
  type OrderRefundState,
  type ProposalShopifyOps,
  type RefundOps,
} from '../src/proposals/apply-shared.ts'
import { executeApplyProposal } from '../src/proposals/run-apply.ts'
import { buildServer } from '../src/server.ts'
import { notifyPendingEscalations } from '../src/support/escalate.ts'
import type { TriageVerdict } from '../src/support/triage.ts'
import { createSettings, SETTINGS_DEFAULTS } from '../src/settings.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

const SUPPORT_ADDRESS = 'support@dogebuddy.test'
const CUSTOMER = 'jane@example.com'
const ADMIN_BASE_URL = 'https://admin.test'
const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' }

/** What Gmail stamps on a genuinely-authenticated inbound message — the refund gate's precondition. */
const DMARC_PASS = 'spf=pass smtp.mailfrom=example.com; dkim=pass header.i=@example.com; dmarc=pass header.from=example.com'

/** Passes every §3 screen: no HTML, no domains, no phone-like digit runs, no promised action. */
const CLEAN_BODY =
  'Hi Jane,\n\nThanks for reaching out — your package is moving through the carrier network and should be with you shortly.\n\nDoge Buddy Support'
/** Deliberately DOES promise a resolved action — legal only because the same run carries a refund. */
const REFUND_BODY =
  'Hi Jane,\n\nSorry your order arrived broken. Your refund has been approved for the full amount you paid.\n\nDoge Buddy Support'

/**
 * MockGmail mints every message an `internalDate` of `1_700_000_000_000 + n * 1000` (see its own
 * `BASE_INTERNAL_DATE_MS`), so mock mail lives in November 2023 while a real `new Date()` does not.
 * Every watermark this pipeline turns on — `last_inbound_at > last_agent_run_at` (selection),
 * `sent_at > threadSnapshotAt` (staleness), `last_agent_finished_at` vs `last_agent_run_at` (the
 * stuck gate) — compares a MESSAGE time against a WALL-CLOCK time, and in production those two are
 * the same era. Handing these stages a real clock instead would make every mock message read as
 * ancient: a follow-up email would never satisfy `last_inbound_at > last_agent_run_at`, and the
 * resume case below could not exist at all. So the whole suite runs on an injected clock pinned to
 * the mock's own era, stepped forward past the newest ingested message after each poll
 * (`syncClockPastIngestedMail`). The one exception is the orphan backstop, whose anchor is a DB
 * `created_at` written by `now()` in Postgres — that test injects a real-clock-relative time
 * instead, and says so where it does it.
 */
const MOCK_EPOCH_MS = 1_700_000_000_000

let uidCounter = 0
function uid(): string {
  uidCounter += 1
  return `${Date.now()}-${uidCounter}`
}

/** Decodes one MockGmail `sentMessages()` entry back into its raw RFC 2822 text. */
function decodeRaw(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8')
}

/** The raw message's header block, split into lines (headers end at the first blank line). */
function headerLines(raw: string): string[] {
  return decodeRaw(raw).split('\r\n\r\n')[0]!.split('\r\n')
}

/**
 * Phase 6B end-to-end: the FULL WIRING, once, through every real module in the support pipeline.
 *
 * Real: `runIngest` (against MockGmail), `runTriage` (real selection/precedence/order-linking, with
 * only the model CALL stubbed), `selectAndEnqueueAgentRuns`, `executeSupportAgentRun` (real claim,
 * caps, context assembly, validator, outcome handling) driving the real `runSupportAgent`/harness
 * over a scripted SDK stream, real `submitProposal`, the real session-authed admin approve/reject
 * routes over a real Fastify instance, and the real `executeApplyProposal` dispatch into the real
 * `applySupportReply`/`applyRefund` executors. Only three seams are doubled: Gmail (MockGmail),
 * the two model calls (`TriageCall`, `queryFn`), and Shopify's refund ops.
 *
 * Jobs are driven by calling the executors directly rather than through a real pg-boss queue —
 * the same convention `fulfillment-e2e.test.ts` established for everything but its one drill that
 * genuinely needs pg-boss's own retry timing. `queue.test.ts`/`support-poll-job.test.ts` already
 * prove a sent job reaches these same executors; what is novel here is that one module's committed
 * output is the next module's input.
 *
 * Deliberately NOT duplicated here — each already has a dedicated test that drives the same code
 * path with far tighter control than an end-to-end flow can: poll gating and stage isolation
 * (`support-poll-job.test.ts`), per-ticket/global run caps, kill levers, the hard-kill stuck
 * re-claim and its failure accounting (`support-agent-run.test.ts`), selection-predicate and
 * orphan-anchor edge cases (`agent-select.test.ts`), apply dead-lettering (`proposal-apply.test.ts`),
 * and every per-screen validator rule (`support-validator.test.ts`).
 */
describe('support agent E2E: mailbox -> agent -> owner -> mailbox', () => {
  const { db, pool } = createDb(url)
  const settings = createSettings(db)

  let app: FastifyInstance
  let sessionCookie: string

  let gmail: MockGmail
  let alert: ReturnType<typeof vi.fn>
  let notifications: OwnerNotification[] = []
  let enqueued: { name: string; data: Record<string, unknown> }[] = []

  /** The injected clock every stage shares — see MOCK_EPOCH_MS's note. */
  let clockMs = MOCK_EPOCH_MS
  const now = (): Date => new Date(clockMs)

  /** What the stubbed TriageCall returns for every ticket this cycle. */
  let verdict: TriageVerdict
  /** Consumed in order, one per `queryFn` call — the agent's scripted structured output. */
  let scriptedOutputs: SupportOutput[] = []
  /** Every `{ prompt, options }` the stubbed SDK seam was handed, in call order. */
  let queryCalls: { prompt: string; options: Record<string, unknown> }[] = []

  /** The one session id the scripted SDK stream reports — resumes return the same id, as the SDK's do. */
  const E2E_SESSION_ID = 'e2e-session-1'

  const notify = async (n: OwnerNotification): Promise<boolean> => {
    notifications.push(n)
    return true
  }
  const enqueue = async (name: string, data: object): Promise<void> => {
    enqueued.push({ name, data: data as Record<string, unknown> })
  }

  /** Non-null `load` = "the durable mirror still has this session", so the resume pre-flight keeps it. */
  const sessionStore = {
    append: vi.fn(async () => {}),
    load: vi.fn(async () => []),
    listSubkeys: vi.fn(async () => []),
  } as unknown as SessionStore

  beforeAll(async () => {
    app = buildServer({
      pool,
      isQueueReady: () => true,
      admin: {
        db,
        settings,
        notify,
        enqueue,
        alert: (async () => {}) as AdminDeps['alert'],
        adminBaseUrl: ADMIN_BASE_URL,
      },
    })
    await app.ready()

    // One login for the whole file (LOGIN_SENDS_HOURLY_CAP is 5/hour) — the session TTL is 30 days,
    // so one cookie covers every test below.
    await app.inject({ method: 'POST', url: '/admin/login', headers: FORM_HEADERS, payload: '' })
    const loginUrl = notifications[notifications.length - 1]!.actions![0]!.url
    const token = loginUrl.match(/[?&]t=([^&]+)/)![1]!
    const consumed = await app.inject({ method: 'POST', url: `/admin/login/consume?t=${token}` })
    const setCookie = consumed.headers['set-cookie']
    sessionCookie = (Array.isArray(setCookie) ? setCookie[0]! : (setCookie as string)).split(';')[0]!
  })

  afterAll(async () => {
    await db.delete(auditLog).where(inArray(auditLog.action, ['admin.login_link_sent', 'admin.login']))
    await db.delete(adminSessions)
    await app.close()
    await pool.end()
  })

  beforeEach(async () => {
    // selfAddress mirrors production: the impersonated mailbox IS the support address, so the mock's
    // own SENT copies carry `From: support@` and ingest classifies them as outbound.
    gmail = createMockGmail({ selfAddress: SUPPORT_ADDRESS })
    alert = vi.fn(async () => {})
    notifications = []
    enqueued = []
    queryCalls = []
    scriptedOutputs = []
    clockMs = MOCK_EPOCH_MS
    verdict = { category: 'shipping', order_number: null, sentiment: 'neutral', is_spam: false, escalation_flags: [] }
    resetSupportPollOnceFlags()
    await settings.set('killswitch.global', SETTINGS_DEFAULTS['killswitch.global'])
    await settings.set('workflow.support.enabled', SETTINGS_DEFAULTS['workflow.support.enabled'])
    // Both default to 'manual'; pinned here so a stray row from another test file cannot flip these
    // runs into auto mode and skip the owner-approval half of every flow below.
    await settings.set('workflow.support_reply.mode', 'manual')
    await settings.set('workflow.refund.mode', 'manual')
  })

  /**
   * Everything this file creates hangs off a MockGmail thread id (`mock-thread-*`) or an
   * `e2e-support-` order gid, so this sweep is both complete and scoped to this file (vitest runs
   * files serially — see vitest.config.ts). `gmail_sync_state` is a SINGLE shared row keyed 1, so it
   * must be dropped too: leaving this file's mock history id behind would make the next file's
   * ingest walk from a position its own mock knows nothing about.
   */
  afterEach(async () => {
    const ticketRows = await db
      .select({ id: supportTickets.id })
      .from(supportTickets)
      .where(like(supportTickets.gmailThreadId, 'mock-%'))
    const ticketIds = ticketRows.map((r) => r.id)
    const orderRows = await db
      .select({ id: orders.id })
      .from(orders)
      .where(like(orders.shopifyOrderGid, '%e2e-support-%'))
    const orderIds = orderRows.map((r) => r.id)

    const proposalRows = [
      ...(ticketIds.length > 0
        ? await db.select({ id: proposals.id }).from(proposals).where(inArray(proposals.ticketId, ticketIds))
        : []),
      ...(orderIds.length > 0
        ? await db.select({ id: proposals.id }).from(proposals).where(inArray(proposals.orderId, orderIds))
        : []),
    ]
    const proposalIds = [...new Set(proposalRows.map((r) => r.id))]

    if (ticketIds.length > 0) {
      const runRows = await db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(inArray(agentRuns.triggerRef, ticketIds))
      const runIds = runRows.map((r) => r.id)
      if (runIds.length > 0) {
        await db.delete(agentRunEvents).where(inArray(agentRunEvents.runId, runIds))
        await db.delete(agentRuns).where(inArray(agentRuns.id, runIds))
      }
      await db.delete(supportMessages).where(inArray(supportMessages.ticketId, ticketIds))
    }
    if (proposalIds.length > 0) await db.delete(proposals).where(inArray(proposals.id, proposalIds))
    if (ticketIds.length > 0) await db.delete(supportTickets).where(inArray(supportTickets.id, ticketIds))
    if (orderIds.length > 0) await db.delete(orders).where(inArray(orders.id, orderIds))

    const auditEntityIds = [...ticketIds, ...proposalIds]
    if (auditEntityIds.length > 0) await db.delete(auditLog).where(inArray(auditLog.entityId, auditEntityIds))
    // Entity-less rows (the per-day cap warnings) carry no id to sweep by.
    await db
      .delete(auditLog)
      .where(
        inArray(auditLog.action, [
          'support.triage',
          'support.triage_capped',
          'support.agent_run_capped',
          'support.escalation_notified',
          'support.escalation_capped',
        ]),
      )
    await db.delete(gmailSyncState).where(eq(gmailSyncState.id, 1))
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Seams: the three doubles (Gmail is MockGmail; these are the model + Shopify)
  // -------------------------------------------------------------------------

  const triageCall = async (): Promise<TriageVerdict> => verdict

  /**
   * The scripted SDK stream. Shaped exactly like a real `query()` iteration — an assistant message
   * (so the harness's `failedBeforeFirstAssistant` reads false) then the authoritative `result` with
   * `structured_output` — so the REAL harness, the REAL parser, and the REAL outcome handling all
   * run against it.
   */
  const queryFn: QueryFn = (args) => {
    queryCalls.push(args)
    const output = scriptedOutputs.shift()
    if (!output) throw new Error('E2E: the SDK seam was called with no scripted output left')
    return (async function* () {
      yield { type: 'assistant', message: { model: SUPPORT_MODEL, usage: { input_tokens: 120, output_tokens: 40 } } }
      yield {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.02,
        modelUsage: { [SUPPORT_MODEL]: { costUSD: 0.02 } },
        num_turns: 2,
        session_id: E2E_SESSION_ID,
        // The real API/harness receives the ENVELOPE ({ decision: <union> }); the runner unwraps it.
        structured_output: { decision: output },
      }
    })()
  }

  interface FakeRefundOps extends RefundOps {
    refundCalls: { input: Record<string, unknown>; idempotencyKey: string }[]
    state: OrderRefundState
  }

  /**
   * Stands in for Shopify's refund surface, `gateway: 'bogus'` — the same test gateway the live
   * Tier-2 walk uses. `refundCreate` mutates `state` the way a real refund would (the note lands in
   * `refunds[]`, the amount in `totalRefundedCents`), so a re-entered apply sees exactly what a
   * re-entry against the live store would see.
   */
  function fakeRefundOps(): FakeRefundOps {
    const ops: FakeRefundOps = {
      refundCalls: [],
      state: {
        totalRefundedCents: 0,
        refunds: [],
        parentTransactionId: 'gid://shopify/OrderTransaction/e2e-1',
        gateway: 'bogus',
      },
      orderRefundState: async () => ({ ...ops.state, refunds: [...ops.state.refunds] }),
      refundCreate: async (input, idempotencyKey) => {
        ops.refundCalls.push({ input, idempotencyKey })
        const note = (input as { note?: string }).note ?? null
        const amount = ((input as { transactions?: { amount?: string }[] }).transactions ?? [])[0]?.amount ?? '0'
        const refundId = `gid://shopify/Refund/e2e-${ops.refundCalls.length}`
        ops.state.refunds.push({ id: refundId, note })
        ops.state.totalRefundedCents += Math.round(Number.parseFloat(amount) * 100)
        return { refundId }
      },
    }
    return ops
  }

  // -------------------------------------------------------------------------
  // Stage drivers
  // -------------------------------------------------------------------------

  function pollDeps(nowOverride?: () => Date): SupportPollDeps {
    return {
      db,
      gmail,
      supportAddress: SUPPORT_ADDRESS,
      settings,
      alert: alert as unknown as SupportPollDeps['alert'],
      notify,
      adminBaseUrl: ADMIN_BASE_URL,
      triageCall,
      enqueue,
      now: nowOverride ?? now,
    }
  }

  /** One real `support.poll-gmail` cycle: ingest -> triage -> escalate -> agent-select. */
  async function pollOnce(nowOverride?: () => Date): Promise<void> {
    await executeSupportPoll(pollDeps(nowOverride))
  }

  /**
   * Steps the injected clock to just past the newest INBOUND message ingested so far, mirroring the
   * production relationship between "when the customer wrote" and "what time it is now". Deliberately
   * ignores outbound rows: `completeSend` stamps those with a real `new Date()` it does not take from
   * this clock, and following that value would jump the clock out of the mock's era entirely.
   */
  async function syncClockPastIngestedMail(): Promise<void> {
    const [newest] = await db
      .select({ sentAt: supportMessages.sentAt })
      .from(supportMessages)
      .where(eq(supportMessages.direction, 'inbound'))
      .orderBy(desc(supportMessages.sentAt))
      .limit(1)
    if (newest?.sentAt) clockMs = Math.max(clockMs, newest.sentAt.getTime() + 1)
  }

  function agentDeps(overrides: Partial<SupportAgentJobDeps> = {}): SupportAgentJobDeps {
    return {
      db,
      settings,
      alert: alert as unknown as SupportAgentJobDeps['alert'],
      notify,
      adminBaseUrl: ADMIN_BASE_URL,
      adapter: { getDisputeOptions: vi.fn(async (): Promise<DisputeOptions> => ({}) as DisputeOptions) },
      enqueue,
      sessionStore,
      anthropicConfigured: true,
      queryFn,
      now,
      ...overrides,
    }
  }

  /** "The worker picks up the `support.agent-run` job the selection stage just enqueued." */
  async function runAgentJobsFor(ticketId: string): Promise<number> {
    const jobs = enqueued.filter((j) => j.name === SUPPORT_AGENT_QUEUE && j.data.ticketId === ticketId)
    for (const _job of jobs) await executeSupportAgentRun(agentDeps(), ticketId)
    return jobs.length
  }

  function applyDeps(overrides: Partial<ApplyProposalDeps> = {}): ApplyProposalDeps {
    const shopifyUnused = new Proxy({} as ProposalShopifyOps, {
      get: (_t, prop) => () => {
        throw new Error(`the support executors must not touch the new_listing shopify ops (called ${String(prop)})`)
      },
    })
    return {
      db,
      alert: alert as unknown as ApplyProposalDeps['alert'],
      shopify: shopifyUnused,
      adapter: {
        subscribeProductWebhook: async () => {},
        getDisputeOptions: vi.fn(async (): Promise<DisputeOptions> => ({}) as DisputeOptions),
        openDispute: async () => ({ disputeId: 'unused' }),
      } as unknown as ApplyProposalDeps['adapter'],
      gmail: gmail as GmailClient,
      refundOps: null,
      supportAddress: SUPPORT_ADDRESS,
      notify,
      enqueue,
      adminBaseUrl: ADMIN_BASE_URL,
      ...overrides,
    }
  }

  /** The real session-authed decision route — the surface the owner's phone actually posts to. */
  async function decideViaAdmin(proposalId: string, decision: 'approve' | 'reject'): Promise<number> {
    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${proposalId}/${decision}`,
      headers: { ...FORM_HEADERS, cookie: sessionCookie },
      payload: '',
    })
    return res.statusCode
  }

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  /** Seeds gmail_sync_state from the mock's current history id — the first poll ingests nothing. */
  async function seedSyncState(): Promise<void> {
    await pollOnce()
  }

  function deliverInbound(opts: {
    subject?: string
    bodyText: string
    threadId?: string
    authenticated?: boolean
  }): { id: string; threadId: string } {
    return gmail.receiveInbound({
      from: `Jane Doe <${CUSTOMER}>`,
      to: [SUPPORT_ADDRESS],
      subject: opts.subject ?? 'Where is my order?',
      bodyText: opts.bodyText,
      ...(opts.threadId ? { threadId: opts.threadId } : {}),
      ...(opts.authenticated === false ? {} : { authenticationResults: DMARC_PASS }),
    })
  }

  async function ticketByThread(threadId: string) {
    const [row] = await db.select().from(supportTickets).where(eq(supportTickets.gmailThreadId, threadId))
    return row!
  }

  async function proposalsOfTicket(ticketId: string) {
    return db.select().from(proposals).where(eq(proposals.ticketId, ticketId)).orderBy(asc(proposals.createdAt))
  }

  async function messagesOfTicket(ticketId: string, direction?: 'inbound' | 'outbound') {
    return db
      .select()
      .from(supportMessages)
      .where(
        direction
          ? and(eq(supportMessages.ticketId, ticketId), eq(supportMessages.direction, direction))
          : eq(supportMessages.ticketId, ticketId),
      )
      .orderBy(asc(supportMessages.sentAt))
  }

  async function auditActionsFor(entityId: string): Promise<string[]> {
    const rows = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.entityId, entityId))
      .orderBy(asc(auditLog.createdAt))
    return rows.map((r) => r.action)
  }

  /**
   * The shared opening move of most flows below: one customer email walked all the way through
   * ingest -> triage -> selection -> the agent run, leaving a `pending` support_reply proposal on an
   * `awaiting_approval` ticket. Returns everything the caller needs to carry on from there.
   */
  async function draftReplyForNewEmail(
    body: string = CLEAN_BODY,
  ): Promise<{ ticketId: string; threadId: string; proposalId: string; inboundId: string }> {
    await seedSyncState()
    const inbound = deliverInbound({ bodyText: 'I ordered a week ago and have heard nothing since.' })

    await pollOnce()
    await syncClockPastIngestedMail()

    const ticket = await ticketByThread(inbound.threadId)
    scriptedOutputs = [{ outcome: 'propose', reply: { body }, rationale: 'drafted from the thread' }]
    await runAgentJobsFor(ticket.id)

    const rows = await proposalsOfTicket(ticket.id)
    return { ticketId: ticket.id, threadId: inbound.threadId, proposalId: rows[0]!.id, inboundId: inbound.id }
  }

  // -------------------------------------------------------------------------
  // 1. Happy path
  // -------------------------------------------------------------------------

  it('happy path: inbound email -> triage -> agent draft -> Telegram -> admin approve -> one threaded reply, one outbound row, waiting_on_customer', async () => {
    await seedSyncState()
    const inbound = deliverInbound({ bodyText: 'I ordered a week ago and have heard nothing since.' })

    // --- Stages 1-4 of the real poll ---
    await pollOnce()
    await syncClockPastIngestedMail()

    const triaged = await ticketByThread(inbound.threadId)
    expect(triaged.status).toBe('triaged')
    expect(triaged.category).toBe('shipping')
    expect(enqueued.filter((j) => j.name === SUPPORT_AGENT_QUEUE && j.data.ticketId === triaged.id)).toHaveLength(1)

    // --- The agent run ---
    scriptedOutputs = [{ outcome: 'propose', reply: { body: CLEAN_BODY }, rationale: 'drafted from the thread' }]
    expect(await runAgentJobsFor(triaged.id)).toBe(1)

    const afterRun = await ticketByThread(inbound.threadId)
    expect(afterRun.status).toBe('awaiting_approval')
    expect(afterRun.agentSessionId).toBe(E2E_SESSION_ID)
    expect(afterRun.lastAgentPromptedAt).toEqual(triaged.lastInboundAt)

    const [proposal] = await proposalsOfTicket(triaged.id)
    expect(proposal!.type).toBe('support_reply')
    expect(proposal!.status).toBe('pending')
    expect(proposal!.payload).toMatchObject({ type: 'support_reply', ticketId: triaged.id, body: CLEAN_BODY })

    // --- The owner's Telegram message (spec §5) ---
    const telegram = notifications.find((n) => n.title === 'New support_reply proposal')!
    expect(telegram).toBeDefined()
    expect(telegram.body).toContain('Where is my order?')
    expect(telegram.body).toContain(CUSTOMER)
    expect(telegram.body).toContain('auth: dmarc=pass')
    expect(telegram.body).toContain(CLEAN_BODY.slice(0, 40))
    expect(telegram.actions!.map((a) => a.label)).toEqual(['Approve', 'Reject'])

    // --- The owner taps Approve (the real session-authed admin route) ---
    expect(await decideViaAdmin(proposal!.id, 'approve')).toBe(303)
    const [approved] = await proposalsOfTicket(triaged.id)
    expect(approved!.status).toBe('approved')
    expect(approved!.decidedBy).toBe('owner')
    expect(enqueued.filter((j) => j.name === 'proposal.apply' && j.data.proposalId === proposal!.id)).toHaveLength(1)

    // --- The apply worker ---
    await executeApplyProposal(applyDeps(), proposal!.id)

    // --- The mailbox: exactly one reply, threaded byte-exactly, carrying the recovery marker ---
    const sent = gmail.sentMessages()
    expect(sent).toHaveLength(1)
    const lines = headerLines(sent[0]!.raw)
    const inboundRfcId = `<${inbound.id}@mock.gmail>`
    expect(lines).toContain(`To: ${CUSTOMER}`)
    expect(lines).toContain(`From: ${SUPPORT_ADDRESS}`)
    // `buildReplyRaw` adds the `Re: ` prefix; the ticket subject itself is unprefixed.
    expect(lines).toContain('Subject: Re: Where is my order?')
    expect(lines).toContain(`In-Reply-To: ${inboundRfcId}`)
    expect(lines).toContain(`References: ${inboundRfcId}`)
    expect(lines).toContain(`${PROPOSAL_MARKER_HEADER}: ${proposal!.id}`)
    expect(decodeRaw(sent[0]!.raw)).toContain(CLEAN_BODY.split('\n')[0]!)
    expect(sent[0]!.threadId).toBe(inbound.threadId)

    const [applied] = await proposalsOfTicket(triaged.id)
    expect(applied!.status).toBe('applied')
    expect(await auditActionsFor(proposal!.id)).toContain(PROPOSAL_APPLIED_ACTION)

    const parked = await ticketByThread(inbound.threadId)
    expect(parked.status).toBe('waiting_on_customer')

    // --- 6A's one-outbound-row invariant, proved against the REAL ingest: the next poll sees the
    // SENT copy of our own reply and must upsert onto the row `completeSend` already wrote. ---
    expect(await messagesOfTicket(triaged.id, 'outbound')).toHaveLength(1)
    await pollOnce()
    const outbound = await messagesOfTicket(triaged.id, 'outbound')
    expect(outbound).toHaveLength(1)
    expect(outbound[0]!.gmailMessageId).toBe(sent[0]!.id)
    expect(outbound[0]!.fromEmail).toBe(SUPPORT_ADDRESS)
  })

  // -------------------------------------------------------------------------
  // 2. Follow-up -> reopen -> resume
  // -------------------------------------------------------------------------

  it('follow-up email reopens the replied ticket, re-triages it, and the second run resumes the STORED session id', async () => {
    const { ticketId, threadId } = await draftReplyForNewEmail()
    const [proposal] = await proposalsOfTicket(ticketId)
    await decideViaAdmin(proposal!.id, 'approve')
    await executeApplyProposal(applyDeps(), proposal!.id)
    expect((await ticketByThread(threadId)).status).toBe('waiting_on_customer')
    expect(queryCalls).toHaveLength(1)
    expect('resume' in queryCalls[0]!.options).toBe(false)

    // The customer writes again ON THE SAME THREAD.
    deliverInbound({ threadId, bodyText: 'Following up — any update on this?' })
    enqueued = []

    await pollOnce()
    await syncClockPastIngestedMail()

    // Reopened by ingest (waiting_on_customer -> new), re-triaged, and re-selected.
    const reopened = await ticketByThread(threadId)
    expect(reopened.status).toBe('triaged')
    expect(reopened.agentSessionId).toBe(E2E_SESSION_ID)
    expect(enqueued.filter((j) => j.name === SUPPORT_AGENT_QUEUE && j.data.ticketId === ticketId)).toHaveLength(1)

    scriptedOutputs = [{ outcome: 'no_action', rationale: 'already answered; waiting on the carrier' }]
    await runAgentJobsFor(ticketId)

    // THE assertion: the second SDK call carried `resume` set to the session id run 1 stored.
    expect(queryCalls).toHaveLength(2)
    expect(queryCalls[1]!.options.resume).toBe(E2E_SESSION_ID)
    expect(queryCalls[1]!.options.persistSession).toBe(true)
    // A resumed run is prompted with ONLY the new messages, and says so.
    expect(queryCalls[1]!.prompt).toContain('Continue from your prior session')
    expect(queryCalls[1]!.prompt).toContain('Following up — any update on this?')
    expect(queryCalls[1]!.prompt).not.toContain('I ordered a week ago')

    // `no_action` leaves the ticket exactly where triage put it, with the finish stamp advanced.
    const afterSecondRun = await ticketByThread(threadId)
    expect(afterSecondRun.status).toBe('triaged')
    expect(afterSecondRun.lastAgentFinishedAt).not.toBeNull()
  })

  // -------------------------------------------------------------------------
  // 3. Stale approve
  // -------------------------------------------------------------------------

  it('stale approve: a customer message lands between draft and tap — nothing is sent, the ticket goes back to the agent', async () => {
    const { ticketId, threadId } = await draftReplyForNewEmail()
    const [proposal] = await proposalsOfTicket(ticketId)

    // The customer writes again while the proposal sits pending in the owner's Telegram.
    deliverInbound({ threadId, bodyText: 'Actually it just turned up, please ignore this.' })
    await pollOnce()
    await syncClockPastIngestedMail()
    // The ticket is `awaiting_approval`, so the new message bumps its watermark without reopening it.
    const chased = await ticketByThread(threadId)
    expect(chased.status).toBe('awaiting_approval')

    enqueued = []
    notifications = []
    expect(await decideViaAdmin(proposal!.id, 'approve')).toBe(303)
    await executeApplyProposal(applyDeps(), proposal!.id)

    expect(gmail.sentMessages()).toHaveLength(0)
    const [failed] = await proposalsOfTicket(ticketId)
    expect(failed!.status).toBe('failed')
    expect(failed!.applyError).toBe(STALE_APPLY_ERROR)
    expect(await auditActionsFor(proposal!.id)).toContain(PROPOSAL_APPLY_FAILED_ACTION)

    // Handed back: `triaged` with the claim stamp cleared, so the next selection re-runs it at once.
    const handedBack = await ticketByThread(threadId)
    expect(handedBack.status).toBe('triaged')
    expect(handedBack.lastAgentRunAt).toBeNull()
    expect(enqueued.filter((j) => j.name === SUPPORT_AGENT_QUEUE && j.data.ticketId === ticketId)).toHaveLength(1)

    const owner = notifications.find((n) => n.title === 'Approved support_reply was NOT sent')!
    expect(owner).toBeDefined()
    expect(owner.body).toContain('re-approve after the agent re-drafts')
  })

  // -------------------------------------------------------------------------
  // 4. Reject -> SILENT escalation
  // -------------------------------------------------------------------------

  it('owner reject escalates the ticket SILENTLY: the next escalate cycle notifies nothing for it', async () => {
    const { ticketId } = await draftReplyForNewEmail()
    const [proposal] = await proposalsOfTicket(ticketId)

    notifications = []
    expect(await decideViaAdmin(proposal!.id, 'reject')).toBe(303)

    const [rejected] = await proposalsOfTicket(ticketId)
    expect(rejected!.status).toBe('rejected')

    const escalated = await ticketRow(ticketId)
    expect(escalated.status).toBe('escalated')
    expect(escalated.escalationReason).toBe('owner_rejected_draft')
    expect(escalated.agentSessionId).toBeNull()
    // PRE-STAMPED: the owner caused this escalation with their own tap, so the notifier must never
    // page them about their own click. This stamp is the whole mechanism.
    expect(escalated.escalationNotifiedAt).not.toBeNull()

    const stampBefore = escalated.escalationNotifiedAt!
    const result = await notifyPendingEscalations({
      db,
      notify,
      alert: alert as unknown as Parameters<typeof notifyPendingEscalations>[0]['alert'],
      adminBaseUrl: ADMIN_BASE_URL,
      now,
    })

    expect(notifications.filter((n) => n.body.includes(ticketId))).toHaveLength(0)
    expect(result.notified).toBe(0)
    const after = await ticketRow(ticketId)
    expect(after.escalationNotifiedAt).toEqual(stampBefore)
  })

  // -------------------------------------------------------------------------
  // 5. Orphan backstop, driven by the ADMIN PAGE's bulk-expiry writer
  // -------------------------------------------------------------------------

  it('orphan backstop: a proposal expired by the ADMIN PAGE sweep strands the ticket; the poll escalates it, and only the NEXT cycle notifies', async () => {
    const { ticketId } = await draftReplyForNewEmail()
    const [proposal] = await proposalsOfTicket(ticketId)

    // Age the proposal past its expiry, then let the ADMIN PROPOSALS PAGE be the writer that flips
    // it — `sweepExpiredOnLoad`, not `proposal-expire-sweep`'s cron and not the agent's own
    // supersede step. That the backstop fires all the same is the point: it keys on ticket state,
    // never on which writer produced it.
    await db
      .update(proposals)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(proposals.id, proposal!.id))

    const page = await app.inject({ method: 'GET', url: '/admin/proposals', headers: { cookie: sessionCookie } })
    expect(page.statusCode).toBe(200)
    const [swept] = await proposalsOfTicket(ticketId)
    expect(swept!.status).toBe('expired')
    expect(await auditActionsFor(proposal!.id)).toContain('proposal.expired')
    expect((await ticketRow(ticketId)).status).toBe('awaiting_approval') // stranded: no live proposal

    // The backstop's anchor is `COALESCE(newest proposal created_at, last_agent_run_at, updated_at)`,
    // and that proposal row's `created_at` is a Postgres `now()` — real wall clock, not this file's
    // mock-era clock. So this one stage is driven 20 real minutes into the future instead.
    const twentyMinutesOn = (): Date => new Date(Date.now() + 20 * 60_000)

    notifications = []
    await pollOnce(twentyMinutesOn)

    const orphaned = await ticketRow(ticketId)
    expect(orphaned.status).toBe('escalated')
    expect(orphaned.escalationReason).toBe('orphaned_awaiting_approval')
    // Cleared for the notifier — but the escalate stage already ran EARLIER in this same cycle, so
    // nothing about this ticket has gone out yet.
    expect(orphaned.escalationNotifiedAt).toBeNull()
    expect(notifications.filter((n) => n.body.includes(ticketId))).toHaveLength(0)

    // Next cycle, one minute later in production: the escalate stage picks it up.
    await pollOnce(twentyMinutesOn)
    expect(notifications.filter((n) => n.body.includes(ticketId))).toHaveLength(1)
    expect((await ticketRow(ticketId)).escalationNotifiedAt).not.toBeNull()
  })

  // -------------------------------------------------------------------------
  // 6. Double apply delivery -> single send
  // -------------------------------------------------------------------------

  it('double apply delivery — and a crash-window re-entry — still send exactly ONE email', async () => {
    const { ticketId, threadId } = await draftReplyForNewEmail()
    const [proposal] = await proposalsOfTicket(ticketId)
    await decideViaAdmin(proposal!.id, 'approve')

    await executeApplyProposal(applyDeps(), proposal!.id)
    expect(gmail.sentMessages()).toHaveLength(1)

    // (a) A plain redelivery of the same job: the shell's status dispatch refuses an `applied` row.
    await executeApplyProposal(applyDeps(), proposal!.id)
    expect(gmail.sentMessages()).toHaveLength(1)
    expect(await auditActionsFor(proposal!.id)).toContain('proposal.apply_skipped')

    // (b) The genuine crash window: the send landed but the `applying -> applied` transition never
    // committed, so a retry re-enters with the row still `applying`. The ONLY thing that can prove
    // the mail already went out is the X-DogeBuddy-Proposal marker read back off the live thread —
    // which is exactly what MockGmail round-trips here.
    await db.update(proposals).set({ status: 'applying', appliedAt: null }).where(eq(proposals.id, proposal!.id))
    await executeApplyProposal(applyDeps(), proposal!.id)

    expect(gmail.sentMessages()).toHaveLength(1)
    const [recovered] = await proposalsOfTicket(ticketId)
    expect(recovered!.status).toBe('applied')
    const appliedRows = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, proposal!.id), eq(auditLog.action, PROPOSAL_APPLIED_ACTION)))
      .orderBy(asc(auditLog.createdAt))
    expect(appliedRows).toHaveLength(2)
    expect(appliedRows[0]!.detail).toMatchObject({ recovered: false })
    expect(appliedRows[1]!.detail).toMatchObject({ recovered: true })

    expect(await messagesOfTicket(ticketId, 'outbound')).toHaveLength(1)
    expect((await ticketByThread(threadId)).status).toBe('waiting_on_customer')
  })

  // -------------------------------------------------------------------------
  // 7. Refund + reply pair
  // -------------------------------------------------------------------------

  it('refund pair: refund is submitted BEFORE the reply, and approving it moves money exactly once across two deliveries', async () => {
    const orderGid = `gid://shopify/Order/e2e-support-${uid()}`
    await db.insert(orders).values({
      shopifyOrderGid: orderGid,
      // Bare, no `#` — the webhook path stores order numbers this way, and the customer/model will
      // quote it WITH a hash below, which is exactly what `normalizeOrderNumber` exists to reconcile.
      shopifyOrderNumber: '7001',
      email: CUSTOMER,
      isTest: true,
      financialStatus: 'PAID',
      totalCents: 10_000,
    })

    await seedSyncState()
    const inbound = deliverInbound({
      subject: 'My order arrived broken',
      bodyText: 'Order 7001 turned up smashed in the box. I would like my money back please.',
    })
    // The model claims the order number; `runTriage` is what actually verifies ownership against the
    // orders table before linking it (a claimed number alone never links).
    verdict = { category: 'order_issue', order_number: '#7001', sentiment: 'negative', is_spam: false, escalation_flags: [] }

    await pollOnce()
    await syncClockPastIngestedMail()

    const ticket = await ticketByThread(inbound.threadId)
    expect(ticket.status).toBe('triaged')
    expect(ticket.orderId).not.toBeNull() // ownership-verified link, not a claimed number
    expect(ticket.claimedOrderNumber).toBeNull()

    scriptedOutputs = [
      {
        outcome: 'propose',
        reply: { body: REFUND_BODY },
        refund: { amountCents: 10_000, reason: 'arrived damaged', openCjDispute: false },
        rationale: 'damaged on arrival, within the returns window',
      },
    ]
    notifications = []
    await runAgentJobsFor(ticket.id)

    // Refund FIRST, then the reply (spec §3 as amended): a crash between the two submits must leave
    // money-without-an-email, never a promise with nothing behind it. The notify order is the
    // observable proof of the submit order.
    const supportNotifies = notifications.filter((n) => n.title.startsWith('New '))
    expect(supportNotifies.map((n) => n.title)).toEqual(['New refund proposal', 'New support_reply proposal'])
    expect(supportNotifies[0]!.body).toContain('$100.00 on order #7001')
    expect(supportNotifies[0]!.body).toContain('auth: dmarc=pass')
    // The reply's own body warns the owner the two are paired.
    expect(supportNotifies[1]!.body).toContain('paired refund proposal')

    const rows = await proposalsOfTicket(ticket.id)
    expect(rows.map((r) => r.type)).toEqual(['refund', 'support_reply'])
    const refund = rows[0]!
    expect(refund.orderId).toBe(ticket.orderId)
    expect(refund.payload).toMatchObject({ type: 'refund', amountCents: 10_000, shopifyOrderGid: orderGid })
    expect((await ticketRow(ticket.id)).status).toBe('awaiting_approval')

    // The owner approves the refund. The approve-time validator re-runs `validateRefundIntent` with
    // this row EXCLUDED from its own accumulation bound — a 100%-of-total refund proves that.
    expect(await decideViaAdmin(refund.id, 'approve')).toBe(303)

    const refundOps = fakeRefundOps()
    await executeApplyProposal(applyDeps({ refundOps }), refund.id)

    expect(refundOps.refundCalls).toHaveLength(1)
    expect(refundOps.refundCalls[0]!.idempotencyKey).toBe(refund.id)
    expect(refundOps.refundCalls[0]!.input).toMatchObject({
      orderId: orderGid,
      note: `db-proposal-${refund.id}`,
      notify: true,
      transactions: [
        { parentId: 'gid://shopify/OrderTransaction/e2e-1', amount: '100.00', kind: 'REFUND', gateway: 'bogus' },
      ],
    })
    const refundAudit = await auditActionsFor(refund.id)
    expect(refundAudit).toContain(PROPOSAL_REFUND_ISSUED_ACTION)
    expect(refundAudit).toContain(PROPOSAL_APPLIED_ACTION)

    // A second delivery of the same apply — and then a crash-window re-entry with the row still
    // `applying` — must both land on the durable note pre-check, never a second payout.
    await executeApplyProposal(applyDeps({ refundOps }), refund.id)
    await db.update(proposals).set({ status: 'applying', appliedAt: null }).where(eq(proposals.id, refund.id))
    await executeApplyProposal(applyDeps({ refundOps }), refund.id)

    expect(refundOps.refundCalls).toHaveLength(1)
    expect(refundOps.state.totalRefundedCents).toBe(10_000)
    const [finalRefund] = await proposalsOfTicket(ticket.id)
    expect(finalRefund!.status).toBe('applied')
    // A refund never touches ticket status — the paired reply owns the customer communication.
    expect((await ticketRow(ticket.id)).status).toBe('awaiting_approval')
  })

  /** Reads one ticket back by id (the thread-id lookup's sibling, for flows that only hold an id). */
  async function ticketRow(ticketId: string) {
    const [row] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticketId))
    return row!
  }
})
