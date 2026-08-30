import { describe, expect, it } from 'vitest'
import { clearRedraftCycle, resolveRejectAction, SUPPORT_REDRAFT_MAX } from '../src/support/redraft.ts'

describe('SUPPORT_REDRAFT_MAX', () => {
  // Load-bearing invariant (see redraft.ts doc comment): 1 + SUPPORT_REDRAFT_MAX must stay <=
  // SUPPORT_AGENT_MAX_RUNS_PER_TICKET_PER_DAY (jobs/support-agent-run.ts, currently 3). MAX=2 =>
  // original draft + 2 redraft runs = 3 = the immutable daily per-ticket cap.
  it('is 2 (original draft + 2 redrafts = the daily per-ticket run cap of 3)', () => {
    expect(SUPPORT_REDRAFT_MAX).toBe(2)
  })
})

describe('clearRedraftCycle', () => {
  it('returns the null/0 reset for the two redraft columns', () => {
    expect(clearRedraftCycle()).toEqual({ ownerRedraftFeedback: null, redraftCount: 0 })
  })
})

describe('resolveRejectAction', () => {
  const base = { reason: 'x', action: 'redraft', redraftCount: 0, ticketStatus: 'awaiting_approval' }
  it('redrafts when reason present, action=redraft, awaiting_approval, under cap', () =>
    expect(resolveRejectAction(base)).toEqual({ kind: 'redraft' }))
  it('escalate_terminal when reason blank', () =>
    expect(resolveRejectAction({ ...base, reason: '  ' })).toEqual({ kind: 'escalate_terminal' }))
  it('escalate_terminal when action != redraft', () =>
    expect(resolveRejectAction({ ...base, action: 'escalate' })).toEqual({ kind: 'escalate_terminal' }))
  it('escalate_terminal when ticket not awaiting_approval', () =>
    expect(resolveRejectAction({ ...base, ticketStatus: 'waiting_on_customer' })).toEqual({ kind: 'escalate_terminal' }))
  it('escalate_limit at the cap', () =>
    expect(resolveRejectAction({ ...base, redraftCount: SUPPORT_REDRAFT_MAX })).toEqual({ kind: 'escalate_limit' }))
  it('escalate_limit above the cap (defensive >=)', () =>
    expect(resolveRejectAction({ ...base, redraftCount: SUPPORT_REDRAFT_MAX + 1 })).toEqual({ kind: 'escalate_limit' }))
})
