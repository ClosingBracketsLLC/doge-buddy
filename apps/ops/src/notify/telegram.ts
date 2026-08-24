import type { NotifyOwner, OwnerNotification } from './notify.ts'

type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export function createTelegramNotifier(opts: {
  botToken: string
  chatId: string
  alert: Alert
  fetchImpl?: FetchLike
}): NotifyOwner {
  const fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init))
  const safeAlert = (...args: Parameters<Alert>) => opts.alert(...args).catch(() => {})
  return async (n: OwnerNotification): Promise<boolean> => {
    try {
      const payload: Record<string, unknown> = {
        chat_id: opts.chatId,
        text: `${n.title}\n\n${n.body}`,
      }
      if (n.actions && n.actions.length > 0) {
        payload.reply_markup = { inline_keyboard: [n.actions.map((a) => ({ text: a.label, url: a.url }))] }
      }
      const res = await fetchImpl(`https://api.telegram.org/bot${opts.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '')
        await safeAlert('warning', 'notify_failed', { status: res.status, body: bodyText.slice(0, 300) })
        return false
      }
      return true
    } catch (err) {
      await safeAlert('warning', 'notify_failed', { error: err instanceof Error ? err.message : String(err) })
      return false
    }
  }
}
