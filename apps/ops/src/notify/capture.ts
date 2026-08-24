import type { NotifyOwner, OwnerNotification } from './notify.ts'

/** Test double: records every notification, always reports delivered. */
export function createCaptureNotifier(): { notify: NotifyOwner; sent: OwnerNotification[] } {
  const sent: OwnerNotification[] = []
  return { sent, notify: async (n) => { sent.push(n); return true } }
}
