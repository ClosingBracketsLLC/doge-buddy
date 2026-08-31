import { randomUUID } from 'node:crypto'

/**
 * Contact-form tickets (spec §3) have no Gmail message behind their first inbound and no Gmail
 * thread until the ack job creates one. Both ids use this prefix so every Gmail-touching path can
 * tell them apart with one check — `gmail_message_id`/`gmail_thread_id` stay NOT NULL UNIQUE.
 */
export const FORM_ID_PREFIX = 'form:'

export function isGmailMessageId(id: string): boolean {
  return !id.startsWith(FORM_ID_PREFIX)
}

export function formPlaceholderThreadId(ticketId: string): string {
  return `${FORM_ID_PREFIX}${ticketId}`
}

export function isFormPlaceholder(threadId: string): boolean {
  return threadId.startsWith(FORM_ID_PREFIX)
}

export function formMessageId(): string {
  return `${FORM_ID_PREFIX}${randomUUID()}`
}
