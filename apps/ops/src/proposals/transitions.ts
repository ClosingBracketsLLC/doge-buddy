import { type createDb, proposals } from '@doge-buddy/db'
import { and, eq } from 'drizzle-orm'

type Db = ReturnType<typeof createDb>['db']
/** The type of the callback's `tx` parameter inside `db.transaction(async (tx) => {...})` — same
 * alias `support/ingest.ts` declares, for the same reason: a caller that must make a proposal's
 * status change atomic with other writes (e.g. `apply-support-reply.ts`'s staleness path, which
 * fails the proposal and re-triages its ticket in one commit) passes the transaction handle here. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type DbOrTx = Db | Tx

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
 * job may write `status` directly — with three narrow, explicitly-guarded exceptions, all of them
 * bulk `pending → expired` flips this per-row helper has no batch form for, and each guarded by its
 * own `WHERE status = 'pending'` clause (the same optimistic-concurrency discipline this table
 * exists to enforce, just expressed as a bulk predicate instead of a single-row call):
 *   1. `jobs/proposal-expire-sweep.ts`'s cron (`… AND expires_at < now()`).
 *   2. `http/admin/routes.ts`'s admin-load sweep, `sweepExpiredOnLoad` (same predicate).
 *   3. `jobs/support-agent-run.ts`'s supersede step, which expires a ticket's still-pending
 *      support proposals when a newer agent run replaces them (`… AND ticket_id = $1 AND type IN
 *      (…)`), writing one `proposal.superseded` audit row per flipped row.
 * So this table is the single source of truth for every OTHER status change.
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
  db: DbOrTx,
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
