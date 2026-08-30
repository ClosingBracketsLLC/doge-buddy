// SUPPORT_REDRAFT_MAX MUST satisfy 1 + SUPPORT_REDRAFT_MAX <= SUPPORT_AGENT_MAX_RUNS_PER_TICKET_PER_DAY
// (jobs/support-agent-run.ts, currently 3): each redraft is an agent run counted against that
// immutable daily per-ticket cap, which a re-arm cannot reset. MAX=3 collided with the cap and
// escalated a cycle early with the wrong reason (panel finding). MAX=2 => original draft + 2
// redraft runs = 3 runs = the cap, and the redraft_limit_reached terminal path stays reachable.
export const SUPPORT_REDRAFT_MAX = 2

/** Spread into EVERY `.set(...)` that transitions a ticket out of the redraft-eligible cycle, beside
 * the existing `escalationNotifiedAt: null` convention — see Task 7's full site list. Leaving these
 * stale re-feeds the agent a dead, authoritative correction on a later run (panel finding). */
export function clearRedraftCycle(): { ownerRedraftFeedback: null; redraftCount: 0 } {
  return { ownerRedraftFeedback: null, redraftCount: 0 }
}

export type RejectResolution = { kind: 'redraft' } | { kind: 'escalate_terminal' } | { kind: 'escalate_limit' }

/** Pure decision shared by both reject surfaces so they never diverge. */
export function resolveRejectAction(p: {
  reason: string
  action: string
  redraftCount: number
  ticketStatus: string
}): RejectResolution {
  if (p.reason.trim().length === 0 || p.action !== 'redraft') return { kind: 'escalate_terminal' }
  if (p.ticketStatus !== 'awaiting_approval') return { kind: 'escalate_terminal' }
  if (p.redraftCount >= SUPPORT_REDRAFT_MAX) return { kind: 'escalate_limit' }
  return { kind: 'redraft' }
}
