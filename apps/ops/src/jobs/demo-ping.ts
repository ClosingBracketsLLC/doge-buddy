import { auditLog, type createDb } from '@doge-buddy/db'
import type PgBoss from 'pg-boss'

type Db = ReturnType<typeof createDb>['db']

export function demoPingHandler(db: Db) {
  return async (jobs: PgBoss.Job<{ note: string }>[]): Promise<void> => {
    for (const job of jobs) {
      await db.insert(auditLog).values({
        actor: 'system',
        action: 'demo.ping',
        detail: { note: job.data.note },
      })
    }
  }
}
