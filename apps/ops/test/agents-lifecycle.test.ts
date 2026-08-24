import { agentRuns, auditLog, createDb } from '@doge-buddy/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { claimDailyRun, ORPHAN_AFTER_MINUTES, sweepOrphanRuns } from '../src/agents/lifecycle.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

// Unique-per-run workflow names (this test DB is shared and persistent across the whole suite and
// across reruns, same discipline as the other real-Postgres test files in this package) so a rerun
// never sees a previous run's leftover `agent_runs` rows for "today".
let uid = 0
function uniqueWorkflow(prefix = 'lifecycle-test'): string {
  uid += 1
  return `${prefix}-${Date.now()}-${uid}`
}

function mockAlert() {
  return vi.fn().mockResolvedValue(undefined)
}

describe('claimDailyRun / sweepOrphanRuns', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  let createdWorkflows: string[] = []
  function trackWorkflow(workflow: string): string {
    createdWorkflows.push(workflow)
    return workflow
  }

  afterEach(async () => {
    if (createdWorkflows.length > 0) {
      await db.delete(agentRuns).where(inArray(agentRuns.workflow, createdWorkflows))
      createdWorkflows = []
    }
  })

  async function auditRowsFor(entityId: string) {
    return db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'agent_run.orphaned'), eq(auditLog.entityId, entityId)))
  }

  it('(a) first claim of the day succeeds and creates a running row', async () => {
    const workflow = trackWorkflow(uniqueWorkflow())
    const result = await claimDailyRun(db, mockAlert(), { workflow, model: 'claude-sonnet', triggerRef: 'manual' })

    expect(result.claimed).toBe(true)
    if (!result.claimed) throw new Error('expected claimed:true')

    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, result.runId))
    expect(row?.status).toBe('running')
    expect(row?.workflow).toBe(workflow)
    expect(row?.model).toBe('claude-sonnet')
    expect(row?.triggerRef).toBe('manual')
  })

  it('(b) second claim same day is rejected, returning the first claim\'s runId', async () => {
    const workflow = trackWorkflow(uniqueWorkflow())
    const first = await claimDailyRun(db, mockAlert(), { workflow, model: 'm', triggerRef: 'cron' })
    if (!first.claimed) throw new Error('expected first claim to succeed')

    const second = await claimDailyRun(db, mockAlert(), { workflow, model: 'm', triggerRef: 'manual' })
    expect(second.claimed).toBe(false)
    if (second.claimed) throw new Error('expected second claim to fail')
    expect(second.existingRunId).toBe(first.runId)

    const rows = await db.select().from(agentRuns).where(eq(agentRuns.workflow, workflow))
    expect(rows.length).toBe(1)
  })

  it('(b2) a succeeded run started today still blocks a second same-day claim', async () => {
    // One-run-per-day must survive a status change: a run that finished (not just one still
    // in flight) is exactly the case the breaker exists to prevent duplicating.
    const workflow = trackWorkflow(uniqueWorkflow())
    const first = await claimDailyRun(db, mockAlert(), { workflow, model: 'm', triggerRef: 'cron' })
    if (!first.claimed) throw new Error('expected first claim to succeed')
    await db.update(agentRuns).set({ status: 'succeeded' }).where(eq(agentRuns.id, first.runId))

    const second = await claimDailyRun(db, mockAlert(), { workflow, model: 'm', triggerRef: 'manual' })
    expect(second.claimed).toBe(false)
    if (second.claimed) throw new Error('expected second claim to fail')
    expect(second.existingRunId).toBe(first.runId)

    const rows = await db.select().from(agentRuns).where(eq(agentRuns.workflow, workflow))
    expect(rows.length).toBe(1)
  })

  it('(c) force:true claims anyway, producing a second row', async () => {
    const workflow = trackWorkflow(uniqueWorkflow())
    const first = await claimDailyRun(db, mockAlert(), { workflow, model: 'm', triggerRef: 'cron' })
    if (!first.claimed) throw new Error('expected first claim to succeed')

    const second = await claimDailyRun(db, mockAlert(), { workflow, model: 'm', triggerRef: 'manual', force: true })
    expect(second.claimed).toBe(true)
    if (!second.claimed) throw new Error('expected forced claim to succeed')
    expect(second.runId).not.toBe(first.runId)

    const rows = await db.select().from(agentRuns).where(eq(agentRuns.workflow, workflow))
    expect(rows.length).toBe(2)
  })

  it('(d) atomicity: exactly one of 10 concurrent claims (each on its own connection) wins', async () => {
    const workflow = trackWorkflow(uniqueWorkflow('atomic'))

    // Each entry gets its OWN pg.Pool/drizzle client (via the same `createDb` factory `index.ts`
    // and every other test file use) — reusing a single client/connection would serialize every
    // call onto one session and prove nothing about the advisory-lock-protected transaction race
    // this test exists to catch.
    const connections = Array.from({ length: 10 }, () => createDb(url))
    try {
      const results = await Promise.all(
        connections.map(({ db: connDb }, i) =>
          claimDailyRun(connDb, mockAlert(), { workflow, model: 'm', triggerRef: `concurrent-${i}` }),
        ),
      )

      const claimedCount = results.filter((r) => r.claimed).length
      expect(claimedCount).toBe(1)

      const rows = await db.select().from(agentRuns).where(eq(agentRuns.workflow, workflow))
      expect(rows.length).toBe(1)
    } finally {
      await Promise.all(connections.map(({ pool: connPool }) => connPool.end()))
    }
  })

  it("(e) yesterday's run does not block today's claim", async () => {
    const workflow = trackWorkflow(uniqueWorkflow())
    await db.insert(agentRuns).values({
      workflow,
      status: 'succeeded',
      model: 'm',
      startedAt: sql`now() - interval '25 hours'`,
    })

    const result = await claimDailyRun(db, mockAlert(), { workflow, model: 'm', triggerRef: 'cron' })
    expect(result.claimed).toBe(true)

    const rows = await db.select().from(agentRuns).where(eq(agentRuns.workflow, workflow))
    expect(rows.length).toBe(2)
  })

  it('(f) orphan sweep flips a stale running row to aborted, alerts + audits, and leaves a fresh running row untouched', async () => {
    const staleWorkflow = trackWorkflow(uniqueWorkflow('stale'))
    const freshWorkflow = trackWorkflow(uniqueWorkflow('fresh'))

    const [staleRow] = await db
      .insert(agentRuns)
      .values({
        workflow: staleWorkflow,
        status: 'running',
        model: 'm',
        startedAt: sql`now() - interval '25 minutes'`,
      })
      .returning({ id: agentRuns.id })
    const [freshRow] = await db
      .insert(agentRuns)
      .values({
        workflow: freshWorkflow,
        status: 'running',
        model: 'm',
        startedAt: sql`now() - interval '10 minutes'`,
      })
      .returning({ id: agentRuns.id })

    expect(ORPHAN_AFTER_MINUTES).toBe(20)

    const alert = mockAlert()
    const sweptCount = await sweepOrphanRuns(db, alert)
    expect(sweptCount).toBeGreaterThanOrEqual(1)

    const [staleAfter] = await db.select().from(agentRuns).where(eq(agentRuns.id, staleRow!.id))
    expect(staleAfter?.status).toBe('aborted')
    expect(staleAfter?.finishedAt).not.toBeNull()

    const [freshAfter] = await db.select().from(agentRuns).where(eq(agentRuns.id, freshRow!.id))
    expect(freshAfter?.status).toBe('running')
    expect(freshAfter?.finishedAt).toBeNull()

    expect(alert).toHaveBeenCalledWith(
      'warning',
      'agent_run_orphaned',
      expect.objectContaining({ runId: staleRow!.id, workflow: staleWorkflow }),
    )
    expect(alert).not.toHaveBeenCalledWith(
      'warning',
      'agent_run_orphaned',
      expect.objectContaining({ runId: freshRow!.id }),
    )

    const auditRows = await auditRowsFor(staleRow!.id)
    expect(auditRows.length).toBe(1)
    expect(auditRows[0]?.actor).toBe('system')
    expect(auditRows[0]?.entityType).toBe('agent_run')
  })

  it('(f) cross-day self-heal: a run stuck running since yesterday no longer looks in-progress after the sweep, and claimDailyRun proceeds cleanly for that same workflow', async () => {
    // Deliberately more than a full day + ORPHAN_AFTER_MINUTES stale so this row is unambiguously
    // both (a) orphan-eligible and (b) outside "today"'s UTC window regardless of what time this
    // test happens to run — the day-scoped claim predicate excludes it either way, so this proves
    // the sweep (invoked automatically by claimDailyRun, before its own transaction) heals a
    // crashed run's status without needing the claim's own transaction to somehow special-case it.
    const staleWorkflow = trackWorkflow(uniqueWorkflow('stuck-since-yesterday'))
    const [staleRow] = await db
      .insert(agentRuns)
      .values({
        workflow: staleWorkflow,
        status: 'running',
        model: 'm',
        startedAt: sql`now() - interval '1 day' - interval '25 minutes'`,
      })
      .returning({ id: agentRuns.id })

    const claimResult = await claimDailyRun(db, mockAlert(), { workflow: staleWorkflow, model: 'm', triggerRef: 'cron' })
    expect(claimResult.claimed).toBe(true)

    const [staleAfter] = await db.select().from(agentRuns).where(eq(agentRuns.id, staleRow!.id))
    expect(staleAfter?.status).toBe('aborted')
  })

  it('(f) same-day self-heal: a run stuck running 25+ minutes earlier TODAY no longer blocks a same-day claim once swept (spec:116)', async () => {
    // This is the exact scenario the spec promises and the status-blind predicate (this task's
    // first pass) could not satisfy: a crashed run that never reached a terminal status must not
    // wedge the breaker for the REST OF THE SAME DAY. startedAt is only 25 minutes ago — still
    // well within "today" by the UTC day-truncated predicate — so this only passes because
    // claimDailyRun's status filter excludes 'aborted' rows, not because the row falls outside
    // today's window (contrast with the cross-day test above, which relies on the day boundary
    // instead).
    const workflow = trackWorkflow(uniqueWorkflow('stuck-since-this-morning'))
    const [staleRow] = await db
      .insert(agentRuns)
      .values({
        workflow,
        status: 'running',
        model: 'm',
        startedAt: sql`now() - interval '25 minutes'`,
      })
      .returning({ id: agentRuns.id })

    const claimResult = await claimDailyRun(db, mockAlert(), { workflow, model: 'm', triggerRef: 'cron' })
    expect(claimResult.claimed).toBe(true)

    const [staleAfter] = await db.select().from(agentRuns).where(eq(agentRuns.id, staleRow!.id))
    expect(staleAfter?.status).toBe('aborted')

    // Both rows now exist for this workflow: the healed 'aborted' row and today's new 'running'
    // claim — proving the self-heal didn't just skip creating a row, it actually let a fresh one
    // through.
    const rows = await db.select().from(agentRuns).where(eq(agentRuns.workflow, workflow))
    expect(rows.length).toBe(2)
  })
})
