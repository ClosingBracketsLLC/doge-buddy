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
  // Guard ORDER is load-bearing (spec §3.4). The cap check MUST precede the action check: at cap the
  // rendered forms drop the redraft button and keep only "escalate" + the reason textarea, so an
  // at-cap reject arrives as action=escalate. A reason-carrying reject at cap must PAGE as
  // redraft_limit_reached regardless of which button — checking action first would misroute it to the
  // silent owner_rejected_draft terminal. The blank-reason "just escalate to me" path stays silent at
  // ANY count because its guard is first.
  if (p.reason.trim().length === 0) return { kind: 'escalate_terminal' } // "just escalate to me" — silent, any count
  if (p.ticketStatus !== 'awaiting_approval') return { kind: 'escalate_terminal' }
  if (p.redraftCount >= SUPPORT_REDRAFT_MAX) return { kind: 'escalate_limit' } // reason present + at cap → paging
  if (p.action !== 'redraft') return { kind: 'escalate_terminal' } // reason present, below cap, chose escalate → silent terminal
  return { kind: 'redraft' }
}
