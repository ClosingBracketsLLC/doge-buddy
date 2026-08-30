import type { SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentRuns,
  auditLog,
  createDb,
  orders,
  proposals,
  settings as settingsTable,
  supportMessages,
  supportTickets,
} from '@doge-buddy/db'
import { createMockGmail, type GmailClient, type MockGmail } from '@doge-buddy/gmail'
import { and, eq, inArray, like, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { HarnessResult } from '../src/agents/run-harness.ts'
import type { SupportOutput } from '../src/agents/support-output-schema.ts'
import type { SupportRunContext, SupportRunInput } from '../src/agents/support-run.ts'
import type { AdminDeps } from '../src/http/admin/routes.ts'
import {
  AGENT_NO_ACTION_ACTION,
  executeSupportAgentRun,
  type SupportAgentJobDeps,
} from '../src/jobs/support-agent-run.ts'
import { createCaptureNotifier } from '../src/notify/capture.ts'
import { applySupportReply } from '../src/proposals/apply-support-reply.ts'
import type { ApplyProposalDeps, ProposalShopifyOps } from '../src/proposals/apply-shared.ts'
import { buildServer } from '../src/server.ts'
import { SETTINGS_DEFAULTS, createSettings } from '../src/settings.ts'
import { runIngest, type IngestDeps } from '../src/support/ingest.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

describe('migration 0007: support_tickets redraft columns', () => {
  const { db, pool } = createDb(url)

  afterAll(() => pool.end())

  it('adds owner_redraft_feedback and redraft_count with correct defaults', async () => {
    const { rows } = await db.execute(sql`
      select column_name, data_type, column_default, is_nullable
      from information_schema.columns
      where table_name = 'support_tickets'
        and column_name in ('owner_redraft_feedback', 'redraft_count')
      order by column_name`)
    const byName = Object.fromEntries((rows as any[]).map((r) => [r.column_name, r]))
    expect(byName['owner_redraft_feedback'].is_nullable).toBe('YES')
    expect(byName['redraft_count'].data_type).toBe('integer')
    expect(byName['redraft_count'].is_nullable).toBe('NO')
    expect(String(byName['redraft_count'].column_default)).toContain('0')
  })
})

describe('settings: support.agent_guidance', () => {
  const { db, pool } = createDb(url)

  afterAll(() => pool.end())

  afterEach(async () => {
    // Settings hygiene (same idiom as admin-settings.test.ts): `settings` is a shared table
    // across the whole test suite. Deleting the row restores `get()` to the code default
    // regardless of what this test wrote, and is safe to run unconditionally every time.
    await db.delete(settingsTable).where(eq(settingsTable.key, 'support.agent_guidance'))
  })

  it('defaults to empty string and round-trips a string', async () => {
    const settings = createSettings(db)
    expect(await settings.get('support.agent_guidance')).toBe('')
    await settings.set('support.agent_guidance', 'No returns just because the dog disliked it.')
    expect(await settings.get('support.agent_guidance')).toBe('No returns just because the dog disliked it.')
  })
})

// ---------------------------------------------------------------------------------------------
// Task 7: the redraft-cycle-clear INVARIANT + the no_action-on-redraft-resume strand fix.
//
// The invariant: every write that transitions a ticket OUT of the redraft-eligible cycle clears
// BOTH `owner_redraft_feedback` and `redraft_count` (via `clearRedraftCycle()`), so a stale,
// authoritative correction can never be re-fed to a later agent run. Each block below seeds a
// ticket mid-cycle (`ownerRedraftFeedback='x'`, `redraftCount=1`), drives one real exit path
// through its production code, and asserts both columns cleared.
// ---------------------------------------------------------------------------------------------

/** Both redraft columns are cleared iff this holds — the single assertion every block below shares. */
function expectRedraftCleared(ticket: typeof supportTickets.$inferSelect): void {
  expect(ticket.ownerRedraftFeedback).toBeNull()
  expect(ticket.redraftCount).toBe(0)
}

let uidCounter = 0
function uid(): string {
  uidCounter += 1
  return `${Date.now()}-${uidCounter}`
}

const NOW = new Date('2026-06-15T12:00:00.000Z')
const minutesAgo = (n: number): Date => new Date(NOW.getTime() - n * 60_000)

// =============================================================================================
// (A) support-agent-run.ts — the agent's own `escalate` outcome, and the no_action-strand fix.
// =============================================================================================
describe('Task 7: agent-run exits clear the redraft cycle', () => {
  const { db, pool } = createDb(url)
  const settings = createSettings(db)
  afterAll(() => pool.end())

  const PREFIX = 'guidance-run-'
  let alert: ReturnType<typeof vi.fn>
  let notify: ReturnType<typeof vi.fn>
  let sessionEntries: SessionStoreEntry[] | null
  let sessionStore: SessionStore
  let contexts: SupportRunContext[]

  beforeEach(async () => {
    alert = vi.fn(async () => {})
    notify = vi.fn(async () => true)
    sessionEntries = null
    contexts = []
    sessionStore = {
      append: vi.fn(async () => {}),
      load: vi.fn(async () => sessionEntries),
      listSubkeys: vi.fn(async () => []),
    } as unknown as SessionStore
    await settings.set('killswitch.global', SETTINGS_DEFAULTS['killswitch.global'])
    await settings.set('workflow.support.enabled', SETTINGS_DEFAULTS['workflow.support.enabled'])
    await settings.set('support.agent_guidance', SETTINGS_DEFAULTS['support.agent_guidance'])
  })

  afterEach(async () => {
    const ticketRows = await db
      .select({ id: supportTickets.id })
      .from(supportTickets)
      .where(like(supportTickets.gmailThreadId, `${PREFIX}%`))
    const ticketIds = ticketRows.map((r) => r.id)
    if (ticketIds.length > 0) {
      await db.delete(supportMessages).where(inArray(supportMessages.ticketId, ticketIds))
      await db.delete(proposals).where(inArray(proposals.ticketId, ticketIds))
      await db.delete(agentRuns).where(inArray(agentRuns.triggerRef, ticketIds))
      await db.delete(auditLog).where(inArray(auditLog.entityId, ticketIds))
      await db.delete(supportTickets).where(inArray(supportTickets.id, ticketIds))
    }
    await db.delete(settingsTable).where(eq(settingsTable.key, 'support.agent_guidance'))
    vi.restoreAllMocks()
  })

  function makeDeps(runFn: SupportAgentJobDeps['runFn']): SupportAgentJobDeps {
    return {
      db,
      settings,
      alert,
      notify,
      adminBaseUrl: 'https://admin.test',
      adapter: { getDisputeOptions: vi.fn(async () => ({})) } as unknown as SupportAgentJobDeps['adapter'],
      enqueue: vi.fn(async () => {}),
      sessionStore,
      anthropicConfigured: true,
      runFn,
      now: () => NOW,
    }
  }

  function stubRun(result: HarnessResult<SupportOutput>): SupportAgentJobDeps['runFn'] {
    return vi.fn(async (_deps: unknown, input: SupportRunInput) => {
      contexts.push(input.ctx)
      return result
    }) as unknown as SupportAgentJobDeps['runFn']
  }

  function succeeded(output: SupportOutput, sessionId: string | null = 'stub-session'): HarnessResult<SupportOutput> {
    return {
      status: 'succeeded',
      output,
      costUsd: 0,
      costEstimated: false,
      sessionId,
      sawMirrorError: false,
      failedBeforeFirstAssistant: false,
    }
  }

  async function seedTicket(
    opts: {
      status?: (typeof supportTickets.$inferInsert)['status']
      ownerRedraftFeedback?: string | null
      redraftCount?: number
      agentSessionId?: string | null
      lastAgentRunAt?: Date | null
      lastInboundAt?: Date | null
      escalationNotifiedAt?: Date | null
    } = {},
  ): Promise<string> {
    const [row] = await db
      .insert(supportTickets)
      .values({
        gmailThreadId: `${PREFIX}${uid()}`,
        customerEmail: 'jane@example.com',
        subject: 'Where is my order?',
        status: opts.status ?? 'triaged',
        category: 'shipping',
        sentiment: 'neutral',
        lastInboundAt: opts.lastInboundAt === undefined ? minutesAgo(30) : opts.lastInboundAt,
        lastAgentRunAt: opts.lastAgentRunAt ?? null,
        agentSessionId: opts.agentSessionId ?? null,
        escalationNotifiedAt: opts.escalationNotifiedAt ?? null,
        ownerRedraftFeedback: opts.ownerRedraftFeedback ?? null,
        redraftCount: opts.redraftCount ?? 0,
      })
      .returning({ id: supportTickets.id })
    return row!.id
  }

  async function ticketById(id: string) {
    const [row] = await db.select().from(supportTickets).where(eq(supportTickets.id, id))
    return row!
  }

  it("the agent's own escalate outcome clears the redraft cycle", async () => {
    const ticketId = await seedTicket({
      ownerRedraftFeedback: 'x',
      redraftCount: 1,
      escalationNotifiedAt: NOW,
    })

    await executeSupportAgentRun(
      makeDeps(stubRun(succeeded({ outcome: 'escalate', escalationReason: 'out of policy', rationale: 'r' }))),
      ticketId,
    )

    const ticket = await ticketById(ticketId)
    expect(ticket.status).toBe('escalated')
    expect(ticket.escalationReason).toBe('out of policy')
    expect(ticket.escalationNotifiedAt).toBeNull()
    expectRedraftCleared(ticket)
  })

  it('BLOCKER: a no_action result on a redraft-resume ESCALATES (redraft_unfulfilled, paging) instead of stranding', async () => {
    // Re-armed for a resume: last_agent_run_at cleared (so the CAS re-claims it as new work), the
    // session id to resume present, and the owner's correction outstanding on the row.
    const ticketId = await seedTicket({
      ownerRedraftFeedback: 'Please soften the tone and apologise first.',
      redraftCount: 1,
      agentSessionId: 'sess-live',
      lastAgentRunAt: null,
      lastInboundAt: minutesAgo(30),
      escalationNotifiedAt: NOW,
    })
    sessionEntries = [{ uuid: 'e1' } as unknown as SessionStoreEntry]

    await executeSupportAgentRun(
      makeDeps(stubRun(succeeded({ outcome: 'no_action', rationale: 'nothing to do' }, 'sess-live'))),
      ticketId,
    )

    // The run genuinely consumed the owner feedback (resumed with it on the ctx).
    expect(contexts[0]?.isResume).toBe(true)
    expect(contexts[0]?.ticket.ownerRedraftFeedback).toBe('Please soften the tone and apologise first.')

    const ticket = await ticketById(ticketId)
    // Escalated with a paging reason — NOT left in triaged where it would be re-selected never again.
    expect(ticket.status).toBe('escalated')
    expect(ticket.escalationReason).toBe('redraft_unfulfilled')
    expect(ticket.escalationNotifiedAt).toBeNull() // paging: notifyPendingEscalations picks it up
    expect(ticket.agentSessionId).toBeNull()
    expectRedraftCleared(ticket)
    // The run is properly finalized (finished-at stamped), so the stuck gate never re-runs it.
    expect(ticket.lastAgentFinishedAt).toEqual(NOW)
    // A no_action audit row records the run happened, flagged as the redraft-unfulfilled escalate.
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, AGENT_NO_ACTION_ACTION), eq(auditLog.entityId, ticketId)))
    expect(audits).toHaveLength(1)
    expect(audits[0]!.detail).toMatchObject({ redraftUnfulfilled: true })
  })

  it('an ordinary no_action with NO owner feedback still stays triaged (the strand fix must not over-fire)', async () => {
    const ticketId = await seedTicket({ ownerRedraftFeedback: null, redraftCount: 0 })

    await executeSupportAgentRun(
      makeDeps(stubRun(succeeded({ outcome: 'no_action', rationale: 'idle' }))),
      ticketId,
    )

    const ticket = await ticketById(ticketId)
    expect(ticket.status).toBe('triaged')
    expect(ticket.lastAgentFinishedAt).toEqual(NOW)
    expectRedraftCleared(ticket) // still null/0 — a harmless no-op clear
  })
})

// =============================================================================================
// (B) apply-support-reply.ts — completeSend's `waiting_on_customer` flip.
// =============================================================================================
describe('Task 7: completeSend waiting_on_customer flip clears the redraft cycle', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  const PREFIX = 'guidance-apply-'
  const SUPPORT_ADDRESS = 'support@dogebuddy.test'
  const CUSTOMER = 'jane@example.com'
  const SUBJECT = 'Where is my order?'
  const REPLY_BODY = 'Hi Jane,\n\nYour order shipped yesterday and is moving.\n\nDoge Buddy Support'
  let gmail: MockGmail

  beforeEach(() => {
    gmail = createMockGmail({ selfAddress: SUPPORT_ADDRESS })
  })

  afterEach(async () => {
    const ticketRows = await db
      .select({ id: supportTickets.id })
      .from(supportTickets)
      .where(like(supportTickets.gmailThreadId, `${PREFIX}%`))
    const ticketIds = ticketRows.map((r) => r.id)
    if (ticketIds.length > 0) {
      const proposalRows = await db
        .select({ id: proposals.id })
        .from(proposals)
        .where(inArray(proposals.ticketId, ticketIds))
      await db.delete(supportMessages).where(inArray(supportMessages.ticketId, ticketIds))
      await db.delete(proposals).where(inArray(proposals.ticketId, ticketIds))
      await db.delete(supportTickets).where(inArray(supportTickets.id, ticketIds))
      if (proposalRows.length > 0) {
        await db.delete(auditLog).where(inArray(auditLog.entityId, proposalRows.map((r) => r.id)))
      }
    }
    vi.restoreAllMocks()
  })

  function makeDeps(): ApplyProposalDeps {
    const shopifyUnused = new Proxy({} as ProposalShopifyOps, {
      get: (_t, prop) => () => {
        throw new Error(`applySupportReply must not touch shopify (called ${String(prop)})`)
      },
    })
    return {
      db,
      alert: vi.fn(async () => {}) as unknown as ApplyProposalDeps['alert'],
      shopify: shopifyUnused,
      adapter: {} as unknown as ApplyProposalDeps['adapter'],
      gmail: gmail as GmailClient,
      refundOps: null,
      supportAddress: SUPPORT_ADDRESS,
      notify: vi.fn(async () => true) as unknown as ApplyProposalDeps['notify'],
      enqueue: vi.fn(async () => {}) as unknown as ApplyProposalDeps['enqueue'],
      adminBaseUrl: 'https://admin.test',
    }
  }

  it('a redrafted reply that ships flips to waiting_on_customer and clears both columns', async () => {
    const threadId = `${PREFIX}${uid()}`
    const { id } = gmail.receiveInbound({ from: CUSTOMER, to: [SUPPORT_ADDRESS], subject: SUBJECT, bodyText: 'where?', threadId })
    const meta = await gmail.getMessage(id, { format: 'metadata' })
    const snapshot = meta.internalDate

    const [ticket] = await db
      .insert(supportTickets)
      .values({
        gmailThreadId: threadId,
        customerEmail: CUSTOMER,
        subject: SUBJECT,
        status: 'awaiting_approval',
        lastInboundAt: snapshot,
        // Mid-cycle: this reply is a redraft the owner approved after correcting it.
        ownerRedraftFeedback: 'Mention the tracking link.',
        redraftCount: 2,
      })
      .returning()
    await db.insert(supportMessages).values({
      ticketId: ticket!.id,
      gmailMessageId: id,
      direction: 'inbound',
      fromEmail: CUSTOMER,
      bodyText: 'where?',
      rfcMessageId: meta.rfcMessageId,
      sentAt: snapshot,
    })
    const [proposal] = await db
      .insert(proposals)
      .values({
        type: 'support_reply',
        status: 'applying',
        summary: `Reply: ${SUBJECT}`,
        payload: { type: 'support_reply', ticketId: ticket!.id, body: REPLY_BODY, threadSnapshotAt: snapshot.toISOString() },
        sourceWorkflow: 'support',
        ticketId: ticket!.id,
      })
      .returning()

    await applySupportReply(makeDeps(), proposal!)

    const [after] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticket!.id))
    expect(after!.status).toBe('waiting_on_customer')
    expectRedraftCleared(after!)
  })
})

// =============================================================================================
// (C) ingest.ts — the deterministic tripwire escalate.
// =============================================================================================
describe('Task 7: the ingest tripwire escalate clears the redraft cycle', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  const SUPPORT = 'support@dogebuddy.com'
  let gmail: MockGmail
  let deps: IngestDeps

  beforeEach(() => {
    gmail = createMockGmail({ selfAddress: SUPPORT })
    deps = { db, gmail, supportAddress: SUPPORT, alert: vi.fn(async () => {}) }
  })

  afterEach(async () => {
    const ticketRows = await db
      .select({ id: supportTickets.id })
      .from(supportTickets)
      .where(like(supportTickets.gmailThreadId, 'mock-%'))
    const ticketIds = ticketRows.map((r) => r.id)
    if (ticketIds.length > 0) {
      await db.delete(supportMessages).where(inArray(supportMessages.ticketId, ticketIds))
      await db.delete(supportTickets).where(inArray(supportTickets.id, ticketIds))
    }
    await db.execute(sql`delete from gmail_sync_state where id = 1`)
    vi.restoreAllMocks()
  })

  it('a trigger-word follow-up on a triaged ticket with feedback escalates and clears both columns', async () => {
    // Seed sync state, then open the ticket with a first inbound.
    await runIngest(deps)
    const first = gmail.receiveInbound({ from: 'jane@example.com', to: [SUPPORT], subject: 'Order 1001', bodyText: 'hi' })
    await runIngest(deps)
    const [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.gmailThreadId, first.threadId))
    // Move it into the redraft-eligible cycle (triaged, owner correction outstanding).
    await db
      .update(supportTickets)
      .set({ status: 'triaged', ownerRedraftFeedback: 'x', redraftCount: 1 })
      .where(eq(supportTickets.id, ticket!.id))

    // A follow-up carrying a tripwire keyword lands on the same thread.
    gmail.receiveInbound({
      from: 'jane@example.com', to: [SUPPORT], subject: 'Re: Order 1001',
      bodyText: 'I will file a Chargeback with my bank.', threadId: first.threadId,
    })
    const result = await runIngest(deps)

    const [after] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticket!.id))
    expect(after!.status).toBe('escalated')
    expect(after!.escalationReason).toBe('tripwire: chargeback')
    expect(after!.escalationNotifiedAt).toBeNull()
    expect(result.tripwiredTicketIds).toContain(ticket!.id)
    expectRedraftCleared(after!)
  })
})

// =============================================================================================
// (D) admin/routes.ts — the TICKET_TRANSITIONS loop (escalate AND resolve).
// =============================================================================================
describe('Task 7: admin escalate/resolve clear the redraft cycle', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  const PREFIX = 'guidance-admin-'
  const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' }

  afterEach(async () => {
    const ticketRows = await db
      .select({ id: supportTickets.id })
      .from(supportTickets)
      .where(like(supportTickets.gmailThreadId, `${PREFIX}%`))
    const ticketIds = ticketRows.map((r) => r.id)
    if (ticketIds.length > 0) {
      await db.delete(auditLog).where(inArray(auditLog.entityId, ticketIds))
      await db.delete(supportMessages).where(inArray(supportMessages.ticketId, ticketIds))
      await db.delete(supportTickets).where(inArray(supportTickets.id, ticketIds))
    }
    await db.delete(auditLog).where(eq(auditLog.action, 'admin.login_link_sent'))
    vi.restoreAllMocks()
  })

  function makeDeps(): AdminDeps & { sent: ReturnType<typeof createCaptureNotifier>['sent'] } {
    const { notify, sent } = createCaptureNotifier()
    return {
      db,
      settings: createSettings(db),
      notify,
      enqueue: vi.fn(async () => {}),
      alert: vi.fn(async () => {}),
      adminBaseUrl: 'http://ops.test',
      sent,
    }
  }

  async function loginCookie(app: FastifyInstance, deps: ReturnType<typeof makeDeps>): Promise<string> {
    await app.inject({ method: 'POST', url: '/admin/login', headers: FORM_HEADERS, payload: '' })
    const link = deps.sent[deps.sent.length - 1]!.actions![0]!.url
    const token = link.match(/[?&]t=([^&]+)/)![1]!
    const consumed = await app.inject({ method: 'POST', url: `/admin/login/consume?t=${token}` })
    const setCookie = consumed.headers['set-cookie']
    const header = Array.isArray(setCookie) ? setCookie[0]! : (setCookie as string)
    return header.split(';')[0]!
  }

  async function seedTicket(): Promise<string> {
    const [row] = await db
      .insert(supportTickets)
      .values({
        gmailThreadId: `${PREFIX}${uid()}`,
        customerEmail: 'jane@example.com',
        subject: 'Where is my order?',
        status: 'awaiting_approval',
        lastInboundAt: NOW,
        ownerRedraftFeedback: 'x',
        redraftCount: 1,
      })
      .returning({ id: supportTickets.id })
    return row!.id
  }

  for (const { path, to } of [
    { path: 'escalate', to: 'escalated' },
    { path: 'resolve', to: 'resolved' },
  ] as const) {
    it(`POST /admin/tickets/:id/${path} clears both columns`, async () => {
      const deps = makeDeps()
      const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
      const cookie = await loginCookie(app, deps)
      const ticketId = await seedTicket()

      const res = await app.inject({
        method: 'POST',
        url: `/admin/tickets/${ticketId}/${path}`,
        headers: { ...FORM_HEADERS, cookie },
        payload: 'expectedStatus=awaiting_approval',
      })
      expect(res.statusCode).toBe(303)

      const [after] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticketId))
      expect(after!.status).toBe(to)
      expectRedraftCleared(after!)
      await app.close()
    })
  }
})
