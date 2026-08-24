import { type createDb, proposals } from '@doge-buddy/db'
import { and, eq } from 'drizzle-orm'

type Db = ReturnType<typeof createDb>['db']

export type ProposalStatusDb = 'pending' | 'approved' | 'rejected' | 'expired' | 'applying' | 'applied' | 'failed'

/** Thrown by `applyProposalTransition` when `to` is not reachable from `from` per the legal matrix. */
export class IllegalProposalTransitionError extends Error {
  constructor(
    public readonly from: ProposalStatusDb,
    public readonly to: ProposalStatusDb,
  ) {
    super(`Illegal proposal transition: ${from} -> ${to}`)
    this.name = 'IllegalProposalTransitionError'
  }
}

/**
 * Thrown by `applyProposalTransition` when the guarded `UPDATE ... WHERE id = ? AND status = from`
 * matches 0 rows — i.e. another writer already moved the row off `from` (optimistic concurrency).
 */
export class StaleProposalStatusError extends Error {
  constructor(
    public readonly from: ProposalStatusDb,
    public readonly to: ProposalStatusDb,
  ) {
    super(`Stale proposal status: row was not in status '${from}' when transitioning to '${to}'`)
    this.name = 'StaleProposalStatusError'
  }
}

/**
 * Exhaustive legal-transition matrix for `proposals.status`. Every status change on
 * proposals across the approval pipeline must flow through `applyProposalTransition` below — no
 * job may write `status` directly — with two narrow, explicitly-guarded exceptions:
 * `jobs/proposal-expire-sweep.ts`'s cron and `http/admin/routes.ts`'s admin-load sweep
 * (`sweepExpiredOnLoad`) each run their own bulk `UPDATE proposals SET status = 'expired' WHERE
 * status = 'pending' AND expires_at < now()` — a guarded, single-status-in/single-status-out bulk
 * expiry that this per-row helper has no batch form for, and whose own `WHERE status = 'pending'`
 * clause is the guard (the same optimistic-concurrency discipline this table exists to enforce,
 * just expressed as a bulk predicate instead of a single-row `applyProposalTransition` call). So
 * this table is the single source of truth for every OTHER status change.
 *
 * Self-transitions (from === to) are always illegal and are never listed here.
 */
const LEGAL_TRANSITIONS: Record<ProposalStatusDb, ProposalStatusDb[]> = {
  pending: ['approved', 'rejected', 'expired'],
  approved: ['applying', 'failed'],
  applying: ['applied', 'failed'],
  rejected: [],
  expired: [],
  applied: [],
  failed: [],
}

/** Pure lookup: is `to` a legal next status from `from`? */
export function canTransitionProposal(from: ProposalStatusDb, to: ProposalStatusDb): boolean {
  return LEGAL_TRANSITIONS[from].includes(to)
}

export type ProposalPatch = Partial<{
  decidedBy: string
  decidedAt: Date
  actionTokenHash: string | null
  appliedAt: Date
  applyError: string
  payload: unknown
}>

/**
 * Moves a proposals row from `from` to `to`, persisting `patch` in the same UPDATE.
 *
 * Illegality is checked against the pure matrix *before* any DB call, so an illegal pair never
 * reaches the database. The UPDATE itself is guarded on `WHERE id = ? AND status = from`
 * (optimistic concurrency): if another writer already moved the row off `from`, 0 rows match and
 * this throws `StaleProposalStatusError` instead of silently clobbering that other writer's change.
 */
export async function applyProposalTransition(
  db: Db,
  proposalId: string,
  from: ProposalStatusDb,
  to: ProposalStatusDb,
  patch?: ProposalPatch,
): Promise<void> {
  if (!canTransitionProposal(from, to)) {
    throw new IllegalProposalTransitionError(from, to)
  }

  const [updated] = await db
    .update(proposals)
    .set({ ...patch, status: to })
    .where(and(eq(proposals.id, proposalId), eq(proposals.status, from)))
    .returning({ id: proposals.id })

  if (!updated) {
    throw new StaleProposalStatusError(from, to)
  }
}
