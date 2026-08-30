import type { SessionStore } from '@anthropic-ai/claude-agent-sdk'
import {
  adminSessions,
  agentRunEvents,
  agentRuns,
  auditLog,
  createDb,
  gmailSyncState,
  proposals,
  supportMessages,
  supportTickets,
} from '@doge-buddy/db'
import { createMockGmail, type GmailClient, type MockGmail } from '@doge-buddy/gmail'
import type { DisputeOptions } from '@doge-buddy/supplier'
import { and, asc, desc, eq, inArray, like } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueryFn } from '../src/agents/run-harness.ts'
import type { SupportOutput } from '../src/agents/support-output-schema.ts'
import { SUPPORT_MODEL } from '../src/agents/support-run.ts'
import type { AdminDeps } from '../src/http/admin/routes.ts'
import {
  AGENT_NO_ACTION_ACTION,
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
import { PROPOSAL_APPLIED_ACTION, type ApplyProposalDeps, type ProposalShopifyOps } from '../src/proposals/apply-shared.ts'
import { executeApplyProposal } from '../src/proposals/run-apply.ts'
import { buildServer } from '../src/server.ts'
import { createSettings, SETTINGS_DEFAULTS } from '../src/settings.ts'
import { selectAndEnqueueAgentRuns, type AgentSelectDeps } from '../src/support/agent-select.ts'
import { SUPPORT_REDRAFT_MAX } from '../src/support/redraft.ts'
import type { TriageVerdict } from '../src/support/triage.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

const SUPPORT_ADDRESS = 'support@dogebuddy.test'
const CUSTOMER = 'jane@example.com'
const ADMIN_BASE_URL = 'https://admin.test'
const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' }

const DMARC_PASS = 'spf=pass smtp.mailfrom=example.com; dkim=pass header.i=@example.com; dmarc=pass header.from=example.com'

/** Passes every §3 screen: no HTML, no domains, no phone-like digit runs, no promised action. */
const CLEAN_BODY =
  'Hi Jane,\n\nThanks for reaching out — your package is moving through the carrier network and should be with you shortly.\n\nDoge Buddy Support'
/** The "corrected" re-draft — deliberately different text from CLEAN_BODY so an assertion that
 * checks the SENT body actually proves the SECOND (post-feedback) draft shipped, not the first. */
const CORRECTED_BODY =
  'Hi Jane,\n\nThanks for the extra detail — I have taken another look, and your order is progressing normally and should reach you soon.\n\nDoge Buddy Support'

/** See support-agent.e2e.test.ts's own note: MockGmail mints internalDate off this epoch, so the
 * whole file runs on an injected clock pinned to the mock's own era. */
const MOCK_EPOCH_MS = 1_700_000_000_000

/** Decodes one MockGmail `sentMessages()` entry back into its raw RFC 2822 text. */
function decodeRaw(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8')
}

/**
 * Task 10 E2E: proves the reject-with-reason re-draft loop (Tasks 7-9) and the owner-guidance
 * system-prompt section (Tasks 1-3) work TOGETHER, wired through the real HTTP admin surface, the
 * real `selectAndEnqueueAgentRuns` selection predicate, and the real `executeSupportAgentRun`
 * claim/resume/outcome machinery — not just unit calls into `resolveRejectAction`/
 * `onSupportProposalRejectedForRedraft` (already covered by `redraft.test.ts` and
 * `support-guidance-redraft.test.ts`) or a stubbed `runFn` (already covered by
 * `support-agent-run.test.ts`). Harness copied from `support-agent.e2e.test.ts`: only the SDK
 * `queryFn` seam and Gmail (MockGmail) are doubled; everything else — ingest, triage, selection,
 * claim, the real admin reject/approve routes, the real apply worker — is the production code.
 */
describe('support guidance + redraft E2E: reject-with-reason loop, redraft cap, and owner guidance', () => {
  const { db, pool } = createDb(url)
  const settings = createSettings(db)

  let app: FastifyInstance
  let sessionCookie: string

  let gmail: MockGmail
  let alert: ReturnType<typeof vi.fn>
  let notifications: OwnerNotification[] = []
  let enqueued: { name: string; data: Record<string, unknown> }[] = []

  let clockMs = MOCK_EPOCH_MS
  const now = (): Date => new Date(clockMs)

  let verdict: TriageVerdict
  /** Consumed in order, one per `queryFn` call — the agent's scripted structured output. */
  let scriptedOutputs: SupportOutput[] = []
  /** Every `{ prompt, options }` the stubbed SDK seam was handed, in call order. */
  let queryCalls: { prompt: string; options: Record<string, unknown> }[] = []
  /** Task 10's own seam (not in the parent harness): when true, the NEXT `queryFn` call that
   * carries a `resume` option throws instead of yielding — forcing exactly the "primary resume
   * attempt" failure path (spec §2 / Task 3's fresh-session retry), so the resume-failure case can
   * be driven through the real SDK seam instead of a stubbed `runFn`. */
  let forceResumeFailureOnce = false

  const E2E_SESSION_ID = 'e2e-guidance-session-1'

  const notify = async (n: OwnerNotification): Promise<boolean> => {
    notifications.push(n)
    return true
  }
  const enqueue = async (name: string, data: object): Promise<void> => {
    enqueued.push({ name, data: data as Record<string, unknown> })
  }

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
    // Settings hygiene (support-guidance-redraft.test.ts's own idiom): `settings` is a table shared
    // across the whole suite, so leave the guidance key exactly as this file found it.
    await settings.set('support.agent_guidance', SETTINGS_DEFAULTS['support.agent_guidance'])
    await app.close()
    await pool.end()
  })

  beforeEach(async () => {
    gmail = createMockGmail({ selfAddress: SUPPORT_ADDRESS })
    alert = vi.fn(async () => {})
    notifications = []
    enqueued = []
    queryCalls = []
    scriptedOutputs = []
    forceResumeFailureOnce = false
    clockMs = MOCK_EPOCH_MS
    verdict = { category: 'shipping', order_number: null, sentiment: 'neutral', is_spam: false, escalation_flags: [] }
    resetSupportPollOnceFlags()
    await settings.set('killswitch.global', SETTINGS_DEFAULTS['killswitch.global'])
    await settings.set('workflow.support.enabled', SETTINGS_DEFAULTS['workflow.support.enabled'])
    await settings.set('workflow.support_reply.mode', 'manual')
    await settings.set('workflow.refund.mode', 'manual')
    await settings.set('support.agent_guidance', SETTINGS_DEFAULTS['support.agent_guidance'])
  })

  afterEach(async () => {
    const ticketRows = await db
      .select({ id: supportTickets.id })
      .from(supportTickets)
      .where(like(supportTickets.gmailThreadId, 'mock-%'))
    const ticketIds = ticketRows.map((r) => r.id)

    const proposalIds =
      ticketIds.length > 0
        ? (await db.select({ id: proposals.id }).from(proposals).where(inArray(proposals.ticketId, ticketIds))).map(
            (r) => r.id,
          )
        : []

    if (ticketIds.length > 0) {
      const runRows = await db.select({ id: agentRuns.id }).from(agentRuns).where(inArray(agentRuns.triggerRef, ticketIds))
      const runIds = runRows.map((r) => r.id)
      if (runIds.length > 0) {
        await db.delete(agentRunEvents).where(inArray(agentRunEvents.runId, runIds))
        await db.delete(agentRuns).where(inArray(agentRuns.id, runIds))
      }
      await db.delete(supportMessages).where(inArray(supportMessages.ticketId, ticketIds))
    }
    if (proposalIds.length > 0) await db.delete(proposals).where(inArray(proposals.id, proposalIds))
    if (ticketIds.length > 0) await db.delete(supportTickets).where(inArray(supportTickets.id, ticketIds))

    const auditEntityIds = [...ticketIds, ...proposalIds]
    if (auditEntityIds.length > 0) await db.delete(auditLog).where(inArray(auditLog.entityId, auditEntityIds))
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
  // Seams
  // -------------------------------------------------------------------------

  const triageCall = async (): Promise<TriageVerdict> => verdict

  const queryFn: QueryFn = (args) => {
    // Task 10's forced-resume-failure seam: fires ONCE, only on a call that is actually resuming a
    // session — a fresh (non-resumed) call must never be affected by it.
    if (forceResumeFailureOnce && 'resume' in args.options) {
      forceResumeFailureOnce = false
      queryCalls.push(args)
      throw new Error('E2E: forced resume failure (exercises the support_resume_failed retry path)')
    }
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
        structured_output: { decision: output },
      }
    })()
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

  async function pollOnce(nowOverride?: () => Date): Promise<void> {
    await executeSupportPoll(pollDeps(nowOverride))
  }

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

  function selectDeps(): AgentSelectDeps {
    return { db, enqueue, alert: alert as unknown as AgentSelectDeps['alert'], now }
  }

  /** One real re-arm-to-resumed-run cycle: reset the job log, run the REAL selection predicate
   * (`selectAndEnqueueAgentRuns`), then run whatever it enqueued for this ticket through the REAL
   * claim/resume/outcome machinery (`executeSupportAgentRun`). Mirrors the parent harness's own
   * `enqueued = []` reset convention before every fresh selection cycle. */
  async function selectAndRun(ticketId: string): Promise<number> {
    enqueued = []
    await selectAndEnqueueAgentRuns(selectDeps())
    return runAgentJobsFor(ticketId)
  }

  function applyDeps(overrides: Partial<ApplyProposalDeps> = {}): ApplyProposalDeps {
    const shopifyUnused = new Proxy({} as ProposalShopifyOps, {
      get: (_t, prop) => () => {
        throw new Error(`this file's flows must not touch the shopify ops (called ${String(prop)})`)
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

  /** The real session-authed decision route — approve/plain-reject, no reason. */
  async function decideViaAdmin(proposalId: string, decision: 'approve' | 'reject'): Promise<number> {
    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${proposalId}/${decision}`,
      headers: { ...FORM_HEADERS, cookie: sessionCookie },
      payload: '',
    })
    return res.statusCode
  }

  /** The real session-authed reject-with-reason route (spec §3's redraft loop): the SAME
   * `/admin/proposals/:id/reject` route as `decideViaAdmin`, this time carrying the owner's
   * `reason` and `action=redraft` form fields the route reads to call `resolveRejectAction`. */
  async function rejectWithReason(proposalId: string, reason: string, action: string): Promise<number> {
    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${proposalId}/reject`,
      headers: { ...FORM_HEADERS, cookie: sessionCookie },
      payload: new URLSearchParams({ reason, action }).toString(),
    })
    return res.statusCode
  }

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function seedSyncState(): Promise<void> {
    await pollOnce()
  }

  function deliverInbound(opts: { subject?: string; bodyText: string; threadId?: string }): { id: string; threadId: string } {
    return gmail.receiveInbound({
      from: `Jane Doe <${CUSTOMER}>`,
      to: [SUPPORT_ADDRESS],
      subject: opts.subject ?? 'Where is my order?',
      bodyText: opts.bodyText,
      ...(opts.threadId ? { threadId: opts.threadId } : {}),
      authenticationResults: DMARC_PASS,
    })
  }

  async function ticketByThread(threadId: string) {
    const [row] = await db.select().from(supportTickets).where(eq(supportTickets.gmailThreadId, threadId))
    return row!
  }

  async function ticketRow(ticketId: string) {
    const [row] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticketId))
    return row!
  }

  async function proposalsOfTicket(ticketId: string) {
    return db.select().from(proposals).where(eq(proposals.ticketId, ticketId)).orderBy(asc(proposals.createdAt))
  }

  async function pendingProposalOf(ticketId: string) {
    const rows = await proposalsOfTicket(ticketId)
    const pending = rows.find((r) => r.status === 'pending')
    if (!pending) throw new Error(`E2E: no pending proposal for ticket ${ticketId}`)
    return pending
  }

  async function auditActionsFor(entityId: string): Promise<string[]> {
    const rows = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.entityId, entityId))
      .orderBy(asc(auditLog.createdAt))
    return rows.map((r) => r.action)
  }

  /** The shared opening move: one customer email walked through ingest -> triage -> selection ->
   * the agent run, leaving a `pending` support_reply proposal on an `awaiting_approval` ticket. */
  async function draftReplyForNewEmail(
    body: string = CLEAN_BODY,
  ): Promise<{ ticketId: string; threadId: string; proposalId: string }> {
    await seedSyncState()
    const inbound = deliverInbound({ bodyText: 'I ordered a week ago and have heard nothing since.' })

    await pollOnce()
    await syncClockPastIngestedMail()

    const ticket = await ticketByThread(inbound.threadId)
    scriptedOutputs = [{ outcome: 'propose', reply: { body }, rationale: 'drafted from the thread' }]
    await runAgentJobsFor(ticket.id)

    const proposal = await pendingProposalOf(ticket.id)
    return { ticketId: ticket.id, threadId: inbound.threadId, proposalId: proposal.id }
  }

  function optionsOf(call: { options: Record<string, unknown> } | undefined): Record<string, unknown> {
    return call?.options ?? {}
  }

  function systemPromptOf(call: { options: Record<string, unknown> } | undefined): string {
    const sp = optionsOf(call).systemPrompt
    return typeof sp === 'string' ? sp : ''
  }

  const GUIDANCE_HEADING = '## Owner operating guidance (AUTHORITATIVE — overrides the public store policy wherever they conflict)'
  const FEEDBACK_HEADING = '## Owner feedback on your previous draft (AUTHORITATIVE — follow it exactly)'

  // =========================================================================
  // 1. Full loop: propose -> reject-with-reason -> resumed re-draft (feedback
  //    verbatim in the prompt) -> approve -> §3 validator -> apply -> ONE send.
  // =========================================================================

  it('full loop: reject-with-reason re-arms the ticket, the resumed run carries the owner feedback verbatim, and the corrected draft ships exactly once', async () => {
    const { ticketId, threadId, proposalId } = await draftReplyForNewEmail()
    expect((await ticketRow(ticketId)).status).toBe('awaiting_approval')
    expect(queryCalls).toHaveLength(1)
    expect('resume' in queryCalls[0]!.options).toBe(false) // the ORIGINAL draft is a fresh run

    // --- Owner taps "Re-draft" with a reason (the real admin reject-with-reason route) ---
    const reason = 'decline: no returns for dislike'
    notifications = []
    expect(await rejectWithReason(proposalId, reason, 'redraft')).toBe(303)

    const [rejected] = await proposalsOfTicket(ticketId)
    expect(rejected!.status).toBe('rejected')

    const rearmed = await ticketRow(ticketId)
    expect(rearmed.status).toBe('triaged')
    expect(rearmed.ownerRedraftFeedback).toBe(reason)
    expect(rearmed.redraftCount).toBe(1)
    expect(rearmed.agentSessionId).toBe(E2E_SESSION_ID) // KEPT for the resume
    expect(rearmed.lastAgentRunAt).toBeNull() // re-armed for selection

    // --- selectAndEnqueueAgentRuns picks it up (never-run since the re-arm), then the resumed run ---
    scriptedOutputs = [{ outcome: 'propose', reply: { body: CORRECTED_BODY }, rationale: 'redrafted per owner feedback' }]
    expect(await selectAndRun(ticketId)).toBe(1)

    expect(queryCalls).toHaveLength(2)
    const redraftCall = queryCalls[1]!
    expect(redraftCall.options.resume).toBe(E2E_SESSION_ID)
    // THE assertion: the resumed prompt carries the owner's correction verbatim.
    expect(redraftCall.prompt).toContain(FEEDBACK_HEADING)
    expect(redraftCall.prompt).toContain(reason)

    const afterRedraft = await ticketRow(ticketId)
    expect(afterRedraft.status).toBe('awaiting_approval')
    const corrected = await pendingProposalOf(ticketId)
    expect(corrected.id).not.toBe(proposalId)
    expect(corrected.payload).toMatchObject({ body: CORRECTED_BODY })

    // --- Owner approves the corrected draft: §3 validator re-runs, then the apply worker sends ---
    expect(await decideViaAdmin(corrected.id, 'approve')).toBe(303)
    await executeApplyProposal(applyDeps(), corrected.id)

    const sent = gmail.sentMessages()
    expect(sent).toHaveLength(1) // exactly ONE outbound send across the whole loop
    expect(decodeRaw(sent[0]!.raw)).toContain(CORRECTED_BODY.split('\n')[0]!)
    expect(sent[0]!.threadId).toBe(threadId)

    const final = await ticketRow(ticketId)
    expect(final.status).toBe('waiting_on_customer')
    expect(final.ownerRedraftFeedback).toBeNull() // cleared on ship
    expect(final.redraftCount).toBe(0) // reset on ship
    expect(await auditActionsFor(corrected.id)).toContain(PROPOSAL_APPLIED_ACTION)
  })

  // =========================================================================
  // 2. no_action on a redraft-resume ESCALATES instead of stranding.
  // =========================================================================

  it('no_action on a redraft-resume ESCALATES (redraft_unfulfilled, paging), not left stranded in triaged', async () => {
    const { ticketId, proposalId } = await draftReplyForNewEmail()

    expect(await rejectWithReason(proposalId, 'be more concise and skip the apology', 'redraft')).toBe(303)
    const rearmed = await ticketRow(ticketId)
    expect(rearmed.status).toBe('triaged')
    expect(rearmed.redraftCount).toBe(1)

    scriptedOutputs = [{ outcome: 'no_action', rationale: 'nothing more useful to add' }]
    expect(await selectAndRun(ticketId)).toBe(1)

    const escalated = await ticketRow(ticketId)
    expect(escalated.status).toBe('escalated')
    expect(escalated.escalationReason).toBe('redraft_unfulfilled')
    expect(escalated.escalationNotifiedAt).toBeNull() // NOT pre-stamped -> notifyPendingEscalations pages
    expect(escalated.agentSessionId).toBeNull()
    expect(escalated.ownerRedraftFeedback).toBeNull()
    expect(escalated.redraftCount).toBe(0)
    expect(await auditActionsFor(ticketId)).toContain(AGENT_NO_ACTION_ACTION)

    // Terminal: a later selection cycle must not pick this ticket up again.
    enqueued = []
    await selectAndEnqueueAgentRuns(selectDeps())
    expect(enqueued.filter((j) => j.data.ticketId === ticketId)).toHaveLength(0)
  })

  // =========================================================================
  // 3. Redraft cap = 2: the 3rd reject-with-reason resolves to escalate_limit,
  //    and the 3 runs (1 original + 2 redrafts) fit under the daily per-ticket
  //    cap without tripping agent_run_cap first.
  // =========================================================================

  it(`redraft cap = ${SUPPORT_REDRAFT_MAX}: the 3rd reject-with-reason escalates redraft_limit_reached, and all ${1 + SUPPORT_REDRAFT_MAX} runs fit under the per-ticket cap`, async () => {
    const { ticketId } = await draftReplyForNewEmail()
    let proposalId = (await pendingProposalOf(ticketId)).id

    for (let cycle = 1; cycle <= SUPPORT_REDRAFT_MAX; cycle += 1) {
      expect(await rejectWithReason(proposalId, `redraft feedback #${cycle}`, 'redraft')).toBe(303)
      const rearmed = await ticketRow(ticketId)
      expect(rearmed.status).toBe('triaged')
      expect(rearmed.redraftCount).toBe(cycle)

      scriptedOutputs = [{ outcome: 'propose', reply: { body: CLEAN_BODY }, rationale: `redraft cycle ${cycle}` }]
      expect(await selectAndRun(ticketId)).toBe(1)

      // Each redraft run must land on a real proposal, NOT an `agent_run_cap` escalation — proving
      // the run cap (3/day) was not tripped early by these 2 redraft runs.
      const afterRun = await ticketRow(ticketId)
      expect(afterRun.status).toBe('awaiting_approval')
      expect(afterRun.escalationReason).not.toBe('agent_run_cap')
      proposalId = (await pendingProposalOf(ticketId)).id
    }

    // original + SUPPORT_REDRAFT_MAX redrafts = the daily per-ticket cap, exactly.
    expect(queryCalls).toHaveLength(1 + SUPPORT_REDRAFT_MAX)

    // The (SUPPORT_REDRAFT_MAX + 1)-th reject-with-reason: redraftCount is now at the cap, so
    // resolveRejectAction routes to escalate_limit instead of another redraft.
    expect(await rejectWithReason(proposalId, 'please try once more', 'redraft')).toBe(303)

    const final = await ticketRow(ticketId)
    expect(final.status).toBe('escalated')
    expect(final.escalationReason).toBe('redraft_limit_reached')
    expect(final.escalationNotifiedAt).toBeNull() // pages (not the owner's own silent reject)
    expect(final.agentSessionId).toBeNull()
    expect(final.ownerRedraftFeedback).toBeNull()
    expect(final.redraftCount).toBe(0)

    // No agent run was ever triggered by that 3rd reject — the escalate path never runs the agent.
    expect(queryCalls).toHaveLength(1 + SUPPORT_REDRAFT_MAX)
  })

  // =========================================================================
  // 4. Owner operating guidance shows up (AUTHORITATIVE) in a fresh run's system prompt.
  // =========================================================================

  it('owner guidance: a fresh run\'s system prompt carries the AUTHORITATIVE guidance section verbatim', async () => {
    const guidance = 'Never offer store credit above $50 without escalating; always mention the 30-day return window.'
    await settings.set('support.agent_guidance', guidance)

    await draftReplyForNewEmail()

    expect(queryCalls).toHaveLength(1)
    const systemPrompt = systemPromptOf(queryCalls[0])
    expect(systemPrompt).toContain(GUIDANCE_HEADING)
    expect(systemPrompt).toContain(guidance)
  })

  it('empty guidance (the default) reproduces today\'s behavior — no guidance section at all', async () => {
    expect(await settings.get('support.agent_guidance')).toBe('')

    await draftReplyForNewEmail()

    expect(systemPromptOf(queryCalls[0])).not.toContain('Owner operating guidance')
  })

  // =========================================================================
  // 5. Resume-failure retry keeps the owner guidance (Task 3's fresh-session
  //    retry / second buildContext call site), forced through the real SDK seam.
  // =========================================================================

  it('resume-failure retry: when the primary resumed call fails, the fresh-session retry still carries the owner guidance', async () => {
    const guidance = 'Escalate anything mentioning a chargeback immediately.'
    await settings.set('support.agent_guidance', guidance)

    const { ticketId, threadId } = await draftReplyForNewEmail()
    const [proposal] = await proposalsOfTicket(ticketId)
    await decideViaAdmin(proposal!.id, 'approve')
    await executeApplyProposal(applyDeps(), proposal!.id)
    expect((await ticketRow(ticketId)).status).toBe('waiting_on_customer')
    expect((await ticketRow(ticketId)).agentSessionId).toBe(E2E_SESSION_ID)

    // A follow-up on the SAME thread reopens + re-triages the ticket, so the next run RESUMES the
    // stored session id (support-agent.e2e.test.ts's own "follow-up" case establishes this path).
    deliverInbound({ threadId, bodyText: 'One more question, please.' })
    enqueued = []
    await pollOnce()
    await syncClockPastIngestedMail()
    expect((await ticketByThread(threadId)).agentSessionId).toBe(E2E_SESSION_ID)

    forceResumeFailureOnce = true
    scriptedOutputs = [{ outcome: 'no_action', rationale: 'already answered' }]
    const callsBefore = queryCalls.length
    expect(await runAgentJobsFor(ticketId)).toBe(1)

    const calls = queryCalls.slice(callsBefore)
    expect(calls).toHaveLength(2) // the forced-failed primary resume, then the fresh-session retry
    expect(calls[0]!.options.resume).toBe(E2E_SESSION_ID)
    expect('resume' in calls[1]!.options).toBe(false) // the retry is a FRESH session, not a resume

    expect(alert.mock.calls.filter((c) => c[1] === 'support_resume_failed')).toHaveLength(1)

    // Both the failed primary attempt's prompt AND — the load-bearing one — the retry's prompt
    // must carry the guidance section; Task 3's second `buildContext` call site is what's under test.
    for (const call of calls) {
      const systemPrompt = systemPromptOf(call)
      expect(systemPrompt).toContain(GUIDANCE_HEADING)
      expect(systemPrompt).toContain(guidance)
    }

    const after = await ticketByThread(threadId)
    expect(after.agentSessionId).toBe(E2E_SESSION_ID) // the retry's own result session id
  })
})
