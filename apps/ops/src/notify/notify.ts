export interface OwnerNotification {
  title: string
  body: string
  actions?: { label: string; url: string }[]
}

type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

/**
 * Owner-notification seam. Implementations NEVER reject: delivery failure resolves `false`
 * after alerting, so no caller (submitProposal, login links) can fail because Telegram did —
 * the spec's notification failure contract.
 */
export type NotifyOwner = (n: OwnerNotification) => Promise<boolean>

/** Config-absent fallback: alert-and-false, so notify-dependent paths degrade loudly, not fatally. */
export function createNoopNotifier(alert: Alert): NotifyOwner {
  return async (n) => {
    await alert('warning', 'notify_unconfigured', { title: n.title }).catch(() => {})
    return false
  }
}
