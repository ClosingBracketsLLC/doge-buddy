export interface HistoryRecord {
  id: string
  messagesAdded: { id: string; threadId: string }[]
}

export interface NormalizedMessage {
  id: string
  threadId: string
  labelIds: string[]
  internalDate: Date
  /** Parsed lowercase addr-specs. fromRaw kept for display only. */
  fromAddr: string | null
  fromRaw: string | null
  to: string[]
  cc: string[]
  deliveredTo: string[]
  subject: string | null
  rfcMessageId: string | null
  inReplyTo: string | null
  references: string | null
  /** null when fetched with format:'metadata' */
  bodyText: string | null
}

export interface GmailClient {
  getProfile(): Promise<{ emailAddress: string; historyId: string }>
  listHistory(q: { startHistoryId: string; pageToken?: string }): Promise<{ records: HistoryRecord[]; nextPageToken?: string }>
  listMessages(q: { q?: string; pageToken?: string; includeSpamTrash?: boolean }): Promise<{ ids: { id: string; threadId: string }[]; nextPageToken?: string }>
  /** Resync support: walks a known thread's LIVE message ids (format=minimal — ids only). */
  getThread(threadId: string): Promise<{ messages: { id: string }[] }>
  getMessage(id: string, opts: { format: 'metadata' | 'full' }): Promise<NormalizedMessage>
  listLabels(): Promise<{ id: string; name: string }[]>
  createLabel(name: string): Promise<{ id: string; name: string }>
  modifyMessage(id: string, mods: { addLabelIds?: string[]; removeLabelIds?: string[] }): Promise<void>
  sendReply(r: { threadId: string; to: string; subject: string; inReplyTo: string; references: string; bodyText: string }): Promise<{ id: string; threadId: string }>
}
