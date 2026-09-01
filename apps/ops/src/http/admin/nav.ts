import { proposals, supportTickets, type createDb } from '@doge-buddy/db'
import { count, eq } from 'drizzle-orm'
import type { NavCounts } from './html.ts'

type Db = ReturnType<typeof createDb>['db']

/**
 * The two tab-bar badges, loaded once per authed page render (`routes.ts`'s `page()` helper).
 * Never throws: a badge is not worth a 500, so any failure degrades to zeros.
 */
export async function loadNavCounts(db: Db): Promise<NavCounts> {
  try {
    const [pending, escalated] = await Promise.all([
      db.select({ value: count() }).from(proposals).where(eq(proposals.status, 'pending')),
      db.select({ value: count() }).from(supportTickets).where(eq(supportTickets.status, 'escalated')),
    ])
    return { pendingProposals: pending[0]?.value ?? 0, escalatedTickets: escalated[0]?.value ?? 0 }
  } catch {
    return { pendingProposals: 0, escalatedTickets: 0 }
  }
}
