import { auditLog, type createDb } from '@doge-buddy/db'

type Db = ReturnType<typeof createDb>['db']

export type AlertSeverity = 'info' | 'warning' | 'critical'

interface Logger {
  info(obj: unknown, msg: string): void
  warn(obj: unknown, msg: string): void
  error(obj: unknown, msg: string): void
}

export function createAlerter(db: Db, log: Logger) {
  return async function alert(
    severity: AlertSeverity,
    kind: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const logDetail = { kind, severity, ...detail }

    // Insert audit log row
    await db.insert(auditLog).values({
      actor: 'system',
      action: `alert.${kind}`,
      entityType: 'alert',
      detail: { severity, ...detail },
    })

    // Log at the appropriate level based on severity
    if (severity === 'info') {
      log.info(logDetail, 'alert')
    } else if (severity === 'warning') {
      log.warn(logDetail, 'alert')
    } else if (severity === 'critical') {
      log.error(logDetail, 'alert')
    }
  }
}
