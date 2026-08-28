/**
 * The send-recovery marker header (spec §4 `support_reply` step 4). Stamped on every reply this
 * system sends and read back off the thread by a re-entered apply — the single discriminator
 * between "we already sent this reply" and "the owner hand-replied from Gmail in the crash
 * window". Named here so the client's `METADATA_HEADERS`, the mock, and the apply executor that
 * stamps it can never drift apart.
 */
export const PROPOSAL_MARKER_HEADER = 'X-DogeBuddy-Proposal'

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
  /** Topmost (first-occurrence) `Authentication-Results` header value — Gmail's own SPF/DKIM/DMARC
   * stamp. Present on both 'metadata' and 'full' format shapes; null when the header is absent. */
  authenticationResults: string | null
  /**
   * Value of the `X-DogeBuddy-Proposal` header — the send-recovery marker `support_reply`'s apply
   * executor stamps on every reply it sends (via `sendReply`'s `extraHeaders`), carrying the
   * proposal id. Gmail has no idempotency keys, so this header is what lets a re-entered apply
   * tell "I already sent this" from "the owner hand-replied in the crash window" (whose message
   * carries no marker). Present on both 'metadata' and 'full' shapes — see `METADATA_HEADERS` in
   * client.ts; null when the header is absent (every message not sent by this system).
   */
  dogeBuddyProposalId: string | null
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
  sendReply(r: {
    threadId: string
    to: string
    subject: string
    inReplyTo: string
    references: string
    bodyText: string
    extraHeaders?: Record<string, string>
  }): Promise<{ id: string; threadId: string }>
}
