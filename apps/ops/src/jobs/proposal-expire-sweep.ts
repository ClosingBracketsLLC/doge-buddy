import { auditLog, proposals, type createDb } from '@doge-buddy/db'
import { and, eq, lt } from 'drizzle-orm'
import type PgBoss from 'pg-boss'

type Db = ReturnType<typeof createDb>['db']

export function proposalExpireSweepHandler(db: Db) {
  return async (jobs: PgBoss.Job<object>[]): Promise<void> => {
    // Update all pending proposals that have expired
    const expiredIds = await db
      .update(proposals)
      .set({ status: 'expired' })
      .where(and(eq(proposals.status, 'pending'), lt(proposals.expiresAt, new Date())))
      .returning({ id: proposals.id })

    // Insert audit log entry for each expired proposal
    if (expiredIds.length > 0) {
      await db.insert(auditLog).values(
        expiredIds.map((row) => ({
          actor: 'system',
          action: 'proposal.expired',
          entityType: 'proposal',
          entityId: row.id,
        })),
      )
    }
  }
}
