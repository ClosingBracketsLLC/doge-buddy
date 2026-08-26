import { auditLog, createDb, orders, supportMessages, supportTickets } from '@doge-buddy/db'
import { createMockGmail, type MockGmail } from '@doge-buddy/gmail'
import { eq, inArray, like } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAnthropicTriageCall,
  normalizeOrderNumber,
  runTriage,
  TRIAGE_CYCLE_DEADLINE_MS,
  TRIAGE_MAX_CALLS_PER_DAY,
  TRIAGE_MODEL,
  type TriageCall,
  type TriageDeps,
  type TriageVerdict,
} from '../src/support/triage.ts'
import { SPAM_LABEL } from '../src/support/ingest.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

const TRIAGE_ACTION = 'support.triage'
const TRIAGE_CAPPED_ACTION = 'support.triage_capped'
/** Any instant works; a fixed one keeps `last_triaged_at` and the UTC-day windows assertable. */
const FIXED_NOW = new Date('2024-06-15T12:00:00.000Z')
const INBOUND_AT = new Date('2024-06-15T11:00:00.000Z')

let uidCounter = 0
function uid(): string {
  uidCounter += 1
  return `${Date.now()}-${uidCounter}`
}

function verdict(overrides: Partial<TriageVerdict> = {}): TriageVerdict {
  return {
    category: 'shipping',
    order_number: null,
    sentiment: 'neutral',
    is_spam: false,
    escalation_flags: [],
    ...overrides,
  }
}

describe('runTriage', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  let gmail: MockGmail
  let alert: ReturnType<typeof vi.fn>

  beforeEach(() => {
    gmail = createMockGmail({ selfAddress: 'support@dogebuddy.com' })
    alert = vi.fn(async () => {})
  })

  // Everything this file creates is reachable from the `triage-%` id prefixes, and it exclusively
  // owns these two audit actions (vitest runs files serially — see vitest.config.ts).
  afterEach(async () => {
    const ticketRows = await db
      .select({ id: supportTickets.id })
      .from(supportTickets)
      .where(like(supportTickets.gmailThreadId, 'triage-%'))
    const ticketIds = ticketRows.map((r) => r.id)
    if (ticketIds.length > 0) {
      await db.delete(supportMessages).where(inArray(supportMessages.ticketId, ticketIds))
      await db.delete(supportTickets).where(inArray(supportTickets.id, ticketIds))
    }
    await db.delete(orders).where(like(orders.shopifyOrderGid, 'triage-order-%'))
    await db.delete(auditLog).where(inArray(auditLog.action, [TRIAGE_ACTION, TRIAGE_CAPPED_ACTION]))
    vi.unstubAllGlobals()
  })

  function makeDeps(call: TriageCall, overrides: Partial<TriageDeps> = {}): TriageDeps {
    return { db, call, gmail, alert, now: () => FIXED_NOW, ...overrides }
  }

  async function seedTicket(opts: {
    status?: 'new' | 'triaged' | 'escalated' | 'resolved' | 'waiting_on_customer'
    customerEmail?: string | null
    subject?: string
    lastInboundAt?: Date | null
    lastTriagedAt?: Date | null
    triageFailureCount?: number
    isSpam?: boolean | null
    escalationReason?: string | null
  } = {}): Promise<string> {
    const [row] = await db
      .insert(supportTickets)
      .values({
        gmailThreadId: `triage-${uid()}`,
        customerEmail: opts.customerEmail === undefined ? 'jane@example.com' : opts.customerEmail,
        subject: opts.subject ?? 'Where is my order?',
        status: opts.status ?? 'new',
        lastInboundAt: opts.lastInboundAt === undefined ? INBOUND_AT : opts.lastInboundAt,
        lastTriagedAt: opts.lastTriagedAt ?? null,
        triageFailureCount: opts.triageFailureCount ?? 0,
        isSpam: opts.isSpam ?? null,
        escalationReason: opts.escalationReason ?? null,
      })
      .returning({ id: supportTickets.id })
    return row!.id
  }

  async function seedMessage(
    ticketId: string,
    opts: { bodyText: string; direction?: 'inbound' | 'outbound'; sentAt?: Date; gmailMessageId?: string },
  ): Promise<void> {
    await db.insert(supportMessages).values({
      ticketId,
      gmailMessageId: opts.gmailMessageId ?? `triage-msg-${uid()}`,
      direction: opts.direction ?? 'inbound',
      fromEmail: 'jane@example.com',
      bodyText: opts.bodyText,
      sentAt: opts.sentAt ?? INBOUND_AT,
    })
  }

  async function seedOrder(opts: { number: string; email: string }): Promise<string> {
    const [row] = await db
      .insert(orders)
      .values({
        shopifyOrderGid: `triage-order-${uid()}`,
        shopifyOrderNumber: opts.number,
        email: opts.email,
        isTest: false,
      })
      .returning({ id: orders.id })
    return row!.id
  }

  async function ticketById(id: string) {
    const [row] = await db.select().from(supportTickets).where(eq(supportTickets.id, id))
    return row
  }

  async function auditRows(action: string) {
    return db.select().from(auditLog).where(eq(auditLog.action, action))
  }

  // 1
  it('triages a new ticket: stores the verdict, stamps last_triaged_at, and writes ONE spend-guard audit row', async () => {
    const id = await seedTicket({ subject: 'Package never arrived' })
    await seedMessage(id, { bodyText: 'It has been three weeks.' })
    const call = vi.fn<TriageCall>(async () => verdict({ category: 'shipping', sentiment: 'negative' }))

    const result = await runTriage(makeDeps(call))

    expect(result).toEqual({ triaged: 1, escalatedTicketIds: [] })
    const ticket = await ticketById(id)
    expect(ticket!.status).toBe('triaged')
    expect(ticket!.category).toBe('shipping')
    expect(ticket!.sentiment).toBe('negative')
    expect(ticket!.isSpam).toBe(false)
    expect(ticket!.lastTriagedAt).toEqual(FIXED_NOW)
    expect(ticket!.triageFailureCount).toBe(0)
    expect(ticket!.escalationReason).toBeNull()

    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0]![0]).toEqual({ subject: 'Package never arrived', bodies: ['It has been three weeks.'] })
    expect(await auditRows(TRIAGE_ACTION)).toHaveLength(1)
  })

  // 2
  it('re-triages an already-triaged ticket whose follow-up arrived after the last triage', async () => {
    const id = await seedTicket({
      status: 'triaged',
      lastTriagedAt: new Date('2024-06-14T00:00:00.000Z'),
      lastInboundAt: new Date('2024-06-15T09:00:00.000Z'),
    })
    await seedMessage(id, { bodyText: 'Still nothing, this is ridiculous.' })
    const call = vi.fn<TriageCall>(async () => verdict({ category: 'order_issue' }))

    const result = await runTriage(makeDeps(call))

    expect(result.triaged).toBe(1)
    expect(call).toHaveBeenCalledTimes(1)
    const ticket = await ticketById(id)
    expect(ticket!.category).toBe('order_issue')
    expect(ticket!.lastTriagedAt).toEqual(FIXED_NOW)
  })

  // 3
  it('does NOT re-triage a triaged ticket whose last inbound predates its last triage', async () => {
    const id = await seedTicket({
      status: 'triaged',
      lastTriagedAt: new Date('2024-06-15T10:00:00.000Z'),
      lastInboundAt: new Date('2024-06-15T09:00:00.000Z'),
    })
    const call = vi.fn<TriageCall>(async () => verdict())

    const result = await runTriage(makeDeps(call))

    expect(result).toEqual({ triaged: 0, escalatedTicketIds: [] })
    expect(call).not.toHaveBeenCalled()
    expect(await auditRows(TRIAGE_ACTION)).toHaveLength(0)
    expect((await ticketById(id))!.lastTriagedAt).toEqual(new Date('2024-06-15T10:00:00.000Z'))
  })

  // 4
  it('spam beats anger: an angry spam verdict resolves + labels the thread and never escalates, and the spam ticket is excluded from the repeat-complainant count', async () => {
    // One earlier non-spam ticket from this sender, so the spam ticket would be the 2nd and the
    // later ticket the 3rd IF spam counted. It must not.
    await seedTicket({ status: 'resolved', customerEmail: 'flood@example.com' })

    const received = gmail.receiveInbound({
      from: 'flood@example.com',
      to: ['support@dogebuddy.com'],
      subject: 'CHEAP MEDS',
      bodyText: 'buy now',
    })
    const spamId = await seedTicket({ customerEmail: 'flood@example.com', subject: 'CHEAP MEDS' })
    await seedMessage(spamId, { bodyText: 'buy now', gmailMessageId: received.id })

    const spamResult = await runTriage(
      makeDeps(async () => verdict({ is_spam: true, sentiment: 'angry', category: 'other' })),
    )

    expect(spamResult).toEqual({ triaged: 1, escalatedTicketIds: [] })
    const spamTicket = await ticketById(spamId)
    expect(spamTicket!.status).toBe('resolved')
    expect(spamTicket!.isSpam).toBe(true)
    expect(spamTicket!.escalationReason).toBeNull()

    const labels = await gmail.listLabels()
    const spamLabelId = labels.find((l) => l.name === SPAM_LABEL)?.id
    expect(spamLabelId).toBeDefined()
    expect(gmail.labelsOf(received.id)).toContain(spamLabelId)

    // The 2nd NON-spam ticket from this sender: 2 non-spam in the window (the spam one is
    // excluded), so it must not trip the ≥3 repeat-complainant rule.
    const laterId = await seedTicket({ customerEmail: 'flood@example.com', subject: 'Another one' })
    const laterResult = await runTriage(makeDeps(async () => verdict()))

    expect(laterResult.escalatedTicketIds).toEqual([])
    expect((await ticketById(laterId))!.status).toBe('triaged')
  })

  // 5
  it('escalates the 3rd non-spam ticket from the same customer inside 30 days (repeat complainant)', async () => {
    await seedTicket({ status: 'resolved', customerEmail: 'repeat@example.com' })
    await seedTicket({ status: 'resolved', customerEmail: 'repeat@example.com' })
    const id = await seedTicket({ customerEmail: 'repeat@example.com' })
    await seedMessage(id, { bodyText: 'third time asking' })

    const result = await runTriage(makeDeps(async () => verdict({ sentiment: 'neutral' })))

    expect(result.escalatedTicketIds).toEqual([id])
    const ticket = await ticketById(id)
    expect(ticket!.status).toBe('escalated')
    expect(ticket!.escalationReason).toBe('repeat_complainant')
  })

  it('escalates on an escalation flag and on sentiment `angry`', async () => {
    const flagged = await seedTicket({ customerEmail: 'flagged@example.com' })
    const flaggedResult = await runTriage(
      makeDeps(async () => verdict({ escalation_flags: ['chargeback_threat'] })),
    )
    expect(flaggedResult.escalatedTicketIds).toEqual([flagged])
    expect((await ticketById(flagged))!.escalationReason).toBe('triage_flags: chargeback_threat')

    const angry = await seedTicket({ customerEmail: 'angry@example.com' })
    const angryResult = await runTriage(makeDeps(async () => verdict({ sentiment: 'angry' })))
    expect(angryResult.escalatedTicketIds).toEqual([angry])
    expect((await ticketById(angry))!.escalationReason).toBe('sentiment_angry')
  })

  // 6
  it('never touches a ticket the ingest tripwire already escalated', async () => {
    const id = await seedTicket({ status: 'escalated', escalationReason: 'tripwire: chargeback' })
    const call = vi.fn<TriageCall>(async () => verdict())

    const result = await runTriage(makeDeps(call))

    expect(result).toEqual({ triaged: 0, escalatedTicketIds: [] })
    expect(call).not.toHaveBeenCalled()
    expect(await auditRows(TRIAGE_ACTION)).toHaveLength(0)
    const ticket = await ticketById(id)
    expect(ticket!.status).toBe('escalated')
    expect(ticket!.escalationReason).toBe('tripwire: chargeback')
    expect(ticket!.lastTriagedAt).toBeNull()
  })

  // 7
  it('a failed call increments triage_failure_count and leaves the ticket selectable; the second failure escalates it', async () => {
    const id = await seedTicket()
    const failing = vi.fn<TriageCall>(async () => {
      throw new Error('model timeout')
    })

    const first = await runTriage(makeDeps(failing))

    expect(first).toEqual({ triaged: 0, escalatedTicketIds: [] })
    let ticket = await ticketById(id)
    expect(ticket!.status).toBe('new')
    expect(ticket!.triageFailureCount).toBe(1)
    expect(ticket!.lastTriagedAt).toBeNull()
    // The attempt is still charged against the daily budget (fail-closed counting).
    expect(await auditRows(TRIAGE_ACTION)).toHaveLength(1)

    const second = await runTriage(makeDeps(failing))

    expect(second.escalatedTicketIds).toEqual([id])
    ticket = await ticketById(id)
    expect(ticket!.status).toBe('escalated')
    expect(ticket!.escalationReason).toBe('triage_failed_twice')
    expect(ticket!.triageFailureCount).toBe(2)
    expect(await auditRows(TRIAGE_ACTION)).toHaveLength(2)
  })

  it('a successful call resets a prior failure count', async () => {
    const id = await seedTicket({ triageFailureCount: 1 })

    await runTriage(makeDeps(async () => verdict()))

    const ticket = await ticketById(id)
    expect(ticket!.status).toBe('triaged')
    expect(ticket!.triageFailureCount).toBe(0)
  })

  // 8
  it('at the daily call cap: makes no call, leaves the ticket new, and fires ONE capped warning per UTC day', async () => {
    const id = await seedTicket()
    await db.insert(auditLog).values(
      Array.from({ length: TRIAGE_MAX_CALLS_PER_DAY }, () => ({
        actor: 'system',
        action: TRIAGE_ACTION,
        detail: {},
        createdAt: FIXED_NOW,
      })),
    )
    const call = vi.fn<TriageCall>(async () => verdict())

    const result = await runTriage(makeDeps(call))

    expect(result).toEqual({ triaged: 0, escalatedTicketIds: [] })
    expect(call).not.toHaveBeenCalled()
    expect((await ticketById(id))!.status).toBe('new')
    expect(await auditRows(TRIAGE_ACTION)).toHaveLength(TRIAGE_MAX_CALLS_PER_DAY)
    expect(alert).toHaveBeenCalledTimes(1)
    expect(alert).toHaveBeenCalledWith('warning', 'support_triage_capped', expect.any(Object))
    expect(await auditRows(TRIAGE_CAPPED_ACTION)).toHaveLength(1)

    // Same UTC day, second cycle: still capped, but silent.
    const again = await runTriage(makeDeps(call))
    expect(again.triaged).toBe(0)
    expect(alert).toHaveBeenCalledTimes(1)
    expect(await auditRows(TRIAGE_CAPPED_ACTION)).toHaveLength(1)
  })

  // IMPORTANT 4b regression: a poll must not be able to run indefinitely if the model is slow —
  // that erodes the margin `expireInSeconds` gives the queue's overlap protection. The deadline is
  // measured off the injectable `now` seam (not real wall-clock), so the stubbed model call itself
  // advances a shared mutable clock to simulate one ticket's processing alone eating the budget.
  it('IMPORTANT 4b: a wall-clock deadline stops the per-cycle loop, leaving remaining tickets selectable next cycle', async () => {
    // Distinct customer emails — seeding three tickets under the SAME default customerEmail would
    // trip the unrelated repeat-complainant rule (≥3 non-spam tickets/customer) and escalate them,
    // muddying this test's own assertion about what status a plain triage lands on.
    const first = await seedTicket({
      subject: 'First',
      customerEmail: 'deadline-a@example.com',
      lastInboundAt: new Date('2024-06-15T09:00:00.000Z'),
    })
    const second = await seedTicket({
      subject: 'Second',
      customerEmail: 'deadline-b@example.com',
      lastInboundAt: new Date('2024-06-15T09:01:00.000Z'),
    })
    const third = await seedTicket({
      subject: 'Third',
      customerEmail: 'deadline-c@example.com',
      lastInboundAt: new Date('2024-06-15T09:02:00.000Z'),
    })

    let clock = FIXED_NOW.getTime()
    const now = () => new Date(clock)
    const call = vi.fn<TriageCall>(async () => {
      // Simulate this one call alone taking longer than the whole cycle's deadline.
      clock += TRIAGE_CYCLE_DEADLINE_MS + 1_000
      return verdict()
    })

    const result = await runTriage(makeDeps(call, { now }))

    expect(result.triaged).toBe(1)
    expect(call).toHaveBeenCalledTimes(1)
    expect((await ticketById(first))!.status).toBe('triaged')
    // Never even attempted — still `new`, so next cycle's selection picks them back up.
    expect((await ticketById(second))!.status).toBe('new')
    expect((await ticketById(third))!.status).toBe('new')
  })

  it('yesterday`s calls do not count toward today`s cap', async () => {
    const id = await seedTicket()
    await db.insert(auditLog).values(
      Array.from({ length: TRIAGE_MAX_CALLS_PER_DAY }, () => ({
        actor: 'system',
        action: TRIAGE_ACTION,
        detail: {},
        createdAt: new Date('2024-06-14T23:59:00.000Z'),
      })),
    )

    const result = await runTriage(makeDeps(async () => verdict()))

    expect(result.triaged).toBe(1)
    expect((await ticketById(id))!.status).toBe('triaged')
    expect(alert).not.toHaveBeenCalled()
  })

  // 9
  it('links the order when the claimed number matches after normalization AND the order email is the ticket customer', async () => {
    const orderId = await seedOrder({ number: '1001', email: 'Jane@Example.com' })
    const id = await seedTicket({ customerEmail: 'jane@example.com' })

    const result = await runTriage(makeDeps(async () => verdict({ order_number: '#1001 ' })))

    expect(result.triaged).toBe(1)
    const ticket = await ticketById(id)
    expect(ticket!.orderId).toBe(orderId)
    expect(ticket!.claimedOrderNumber).toBeNull()
  })

  it('normalizes the STORED number too — a `#`-prefixed reconcile-path row still matches a bare claim', async () => {
    const orderId = await seedOrder({ number: '#2002', email: 'jane@example.com' })
    const id = await seedTicket({ customerEmail: 'jane@example.com' })

    await runTriage(makeDeps(async () => verdict({ order_number: '2002' })))

    expect((await ticketById(id))!.orderId).toBe(orderId)
  })

  it('a re-triage whose verdict claims no number keeps the order linked on the earlier pass', async () => {
    const orderId = await seedOrder({ number: '4004', email: 'jane@example.com' })
    const id = await seedTicket({ customerEmail: 'jane@example.com' })
    await runTriage(makeDeps(async () => verdict({ order_number: '#4004' })))
    expect((await ticketById(id))!.orderId).toBe(orderId)

    await db
      .update(supportTickets)
      .set({ lastInboundAt: new Date('2024-06-15T23:00:00.000Z') })
      .where(eq(supportTickets.id, id))
    const second = await runTriage(makeDeps(async () => verdict({ order_number: null })))

    expect(second.triaged).toBe(1) // the ticket really was re-triaged, so the assertion below bites
    expect((await ticketById(id))!.orderId).toBe(orderId)
  })

  // 10
  it('refuses to link another customer`s order: stores claimed_order_number and leaves order_id null', async () => {
    await seedOrder({ number: '3003', email: 'victim@example.com' })
    const id = await seedTicket({ customerEmail: 'attacker@example.com' })

    const result = await runTriage(makeDeps(async () => verdict({ order_number: '#3003' })))

    expect(result.triaged).toBe(1)
    const ticket = await ticketById(id)
    expect(ticket!.orderId).toBeNull()
    expect(ticket!.claimedOrderNumber).toBe('3003')
  })

  // 11
  it('guarded write: an owner Resolve landing mid-call makes the triage write a silent no-op', async () => {
    const id = await seedTicket()

    const result = await runTriage(
      makeDeps(async () => {
        // The owner resolves the ticket in /admin while the model call is in flight.
        await db.update(supportTickets).set({ status: 'resolved' }).where(eq(supportTickets.id, id))
        return verdict({ category: 'refund_request', sentiment: 'angry' })
      }),
    )

    expect(result).toEqual({ triaged: 0, escalatedTicketIds: [] })
    const ticket = await ticketById(id)
    expect(ticket!.status).toBe('resolved')
    expect(ticket!.category).toBeNull()
    expect(ticket!.sentiment).toBeNull()
    expect(ticket!.lastTriagedAt).toBeNull()
  })

  it('sends the subject and the last 3 inbound bodies (oldest first), never outbound ones', async () => {
    const id = await seedTicket({ subject: 'Thread subject' })
    await seedMessage(id, { bodyText: 'first', sentAt: new Date('2024-06-15T01:00:00.000Z') })
    await seedMessage(id, { bodyText: 'second', sentAt: new Date('2024-06-15T02:00:00.000Z') })
    await seedMessage(id, { bodyText: 'our reply', direction: 'outbound', sentAt: new Date('2024-06-15T03:00:00.000Z') })
    await seedMessage(id, { bodyText: 'third', sentAt: new Date('2024-06-15T04:00:00.000Z') })
    await seedMessage(id, { bodyText: 'fourth', sentAt: new Date('2024-06-15T05:00:00.000Z') })
    const call = vi.fn<TriageCall>(async () => verdict())

    await runTriage(makeDeps(call))

    expect(call.mock.calls[0]![0]).toEqual({ subject: 'Thread subject', bodies: ['second', 'third', 'fourth'] })
  })
})

describe('normalizeOrderNumber', () => {
  it('strips leading # and surrounding whitespace', () => {
    expect(normalizeOrderNumber('#1001')).toBe('1001')
    expect(normalizeOrderNumber('  #1001  ')).toBe('1001')
    expect(normalizeOrderNumber('# 1001')).toBe('1001')
    expect(normalizeOrderNumber('1001')).toBe('1001')
  })
})

describe('createAnthropicTriageCall', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubResponse(body: unknown): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  function toolUseResponse(input: unknown): unknown {
    return {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: TRIAGE_MODEL,
      content: [{ type: 'tool_use', id: 'toolu_test', name: 'triage', input }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    }
  }

  it('requests the pinned model with a forced `triage` tool call and parses the tool input', async () => {
    const fetchMock = stubResponse(
      toolUseResponse({
        category: 'refund_request',
        order_number: '#1001',
        sentiment: 'angry',
        is_spam: false,
        escalation_flags: ['chargeback_threat'],
      }),
    )

    const call = createAnthropicTriageCall({ apiKey: 'test-key' })
    const parsed = await call({ subject: 'Refund now', bodies: ['I want my money back'] }, new AbortController().signal)

    expect(parsed).toEqual({
      category: 'refund_request',
      order_number: '#1001',
      sentiment: 'angry',
      is_spam: false,
      escalation_flags: ['chargeback_threat'],
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0]![1] as { body: string }
    const request = JSON.parse(init.body) as Record<string, unknown>
    expect(request.model).toBe(TRIAGE_MODEL)
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'triage' })
    const tools = request.tools as { name: string; input_schema: { properties: Record<string, unknown> } }[]
    expect(tools[0]!.name).toBe('triage')
    expect(Object.keys(tools[0]!.input_schema.properties).sort()).toEqual([
      'category',
      'escalation_flags',
      'is_spam',
      'order_number',
      'sentiment',
    ])
    expect(JSON.stringify(request.messages)).toContain('I want my money back')
  })

  it('throws on a malformed tool input (runTriage counts that as a failed attempt)', async () => {
    stubResponse(toolUseResponse({ category: 'not_a_category', sentiment: 'angry', is_spam: false, escalation_flags: [] }))

    const call = createAnthropicTriageCall({ apiKey: 'test-key' })

    await expect(call({ subject: 's', bodies: ['b'] }, new AbortController().signal)).rejects.toThrow(/bad category/)
  })

  it('throws when the model answers without a tool_use block', async () => {
    stubResponse({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: TRIAGE_MODEL,
      content: [{ type: 'text', text: 'I refuse' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    })

    const call = createAnthropicTriageCall({ apiKey: 'test-key' })

    await expect(call({ subject: 's', bodies: ['b'] }, new AbortController().signal)).rejects.toThrow(/no tool_use/)
  })
})
