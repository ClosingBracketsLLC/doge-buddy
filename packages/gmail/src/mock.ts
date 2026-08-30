import { PROPOSAL_MARKER_HEADER, type GmailClient, type HistoryRecord, type NormalizedMessage } from './types.ts'
import { GmailApiError, HistoryExpiredError, MessageGoneError } from './errors.ts'
import { parseAddrSpecs, parseFirstAddrSpec } from './address.ts'
import { buildReplyRaw } from './rfc2822.ts'

export interface MockGmailOptions {
  selfAddress?: string
}

export interface ReceiveInboundInput {
  from: string
  to?: string[]
  cc?: string[]
  deliveredTo?: string[]
  subject: string
  bodyText: string
  threadId?: string
  labelIds?: string[]
  /** Simulates Gmail's own SPF/DKIM/DMARC stamp. Omitted -> normalized authenticationResults is null. */
  authenticationResults?: string
  /** RFC 2822 threading headers — lets a test model a reply that Gmail put in a DIFFERENT thread
   * (Gmail will not merge inbox mail into a spam-foldered conversation; seen live 2026-08-30). */
  inReplyTo?: string | null
  references?: string | null
}

export interface SaveDraftInput {
  threadId: string
  bodyText: string
}

export interface MockGmail extends GmailClient {
  receiveInbound(m: ReceiveInboundInput): { id: string; threadId: string }
  /** Simulates Gmail draft autosave churn: each call REPLACES the prior revision. */
  saveDraft(m: SaveDraftInput): { id: string }
  /** Sends the current draft: draft message ids become gone; a new SENT message id appears on the thread. */
  sendDraft(threadId: string): { id: string }
  /** Next listHistory call throws HistoryExpiredError, then behavior returns to normal. */
  expireHistory(): void
  /** Next call to `method` throws `err`, then normal. */
  failNext(method: keyof GmailClient, err: Error): void
  /** Assertion helper: reads labels directly, bypassing the gone-message check. */
  labelsOf(id: string): string[]
  /** Steers the history-id counter so the next mutation's record id is > the given decimal string. */
  advanceHistoryTo(id: string): void
  /** Inspection helper: every raw RFC 2822 message built by sendReply, oldest first. Decode with
   * `Buffer.from(raw, 'base64url').toString()` to assert headers (including extraHeaders) the
   * same way the real client's fixture tests do. */
  sentMessages(): { id: string; threadId: string; raw: string }[]
}

const DEFAULT_SELF_ADDRESS = 'me@mock.gmail'
const SYSTEM_LABELS = ['INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH']
/** Arbitrary deterministic baseline so real internalDate math never leaks into test output. */
const BASE_INTERNAL_DATE_MS = 1_700_000_000_000

interface StoredMessage {
  id: string
  threadId: string
  labelIds: string[]
  internalDate: Date
  /** Raw `From` value, kept verbatim for display — parsed into fromAddr at read time, like the real client. */
  fromRaw: string | null
  /** Already addr-spec-parsed/lowercased, mirroring the real client's addrListFromHeaders. */
  to: string[]
  cc: string[]
  deliveredTo: string[]
  subject: string | null
  bodyText: string | null
  rfcMessageId: string | null
  inReplyTo: string | null
  references: string | null
  /** Mirrors NormalizedMessage.authenticationResults — set via receiveInbound, null otherwise. */
  authenticationResults: string | null
  /** Mirrors NormalizedMessage.dogeBuddyProposalId — captured from sendReply's extraHeaders, so a
   * reply this mock "sent" reads back through getMessage exactly as the real thread would. Null on
   * every other message (inbound mail, drafts, the owner's own hand-sent replies). */
  dogeBuddyProposalId: string | null
  /** Superseded by draft churn or sendDraft/replaced — getMessage throws MessageGoneError, but the
   * record (and its labels) stays around for labelsOf(). */
  gone: boolean
}

/** Parses the resync query's `to:X OR cc:X OR deliveredto:X` shape and extracts X. */
function extractResyncTarget(q: string): string | null {
  const match = q.match(/(?:^|\s)(?:to|cc|deliveredto):(\S+)/i)
  return match ? match[1]!.toLowerCase() : null
}

export function createMockGmail(opts: MockGmailOptions = {}): MockGmail {
  const selfAddress = opts.selfAddress ?? DEFAULT_SELF_ADDRESS

  const messages = new Map<string, StoredMessage>()
  const labelRegistry = new Map<string, string>(SYSTEM_LABELS.map((name) => [name, name]))
  const historyLog: HistoryRecord[] = []
  /** Current draft message id(s) per thread, most recent first. Empty/absent once sent. */
  const draftsByThread = new Map<string, string[]>()
  const pendingMethodFailures = new Map<string, Error>()
  const sentRawMessages: { id: string; threadId: string; raw: string }[] = []

  let historyCounter = 0n
  let messageCounter = 0
  let labelCounter = 0
  let dateCounter = 0
  let expireHistoryPending = false

  function nextMessageId(): string {
    messageCounter += 1
    return `mock-msg-${messageCounter}`
  }

  function nextThreadId(): string {
    // Reuses the message counter's sequence space so ids stay simple and monotonic; collisions
    // with real message ids are irrelevant since the two id spaces are never compared.
    messageCounter += 1
    return `mock-thread-${messageCounter}`
  }

  function nextInternalDate(): Date {
    dateCounter += 1
    return new Date(BASE_INTERNAL_DATE_MS + dateCounter * 1000)
  }

  function nextHistoryId(): string {
    historyCounter += 1n
    return historyCounter.toString()
  }

  function pushHistory(messagesAdded: { id: string; threadId: string }[]): void {
    historyLog.push({ id: nextHistoryId(), messagesAdded })
  }

  function maybeThrowPending(method: keyof GmailClient): void {
    const err = pendingMethodFailures.get(method)
    if (err) {
      pendingMethodFailures.delete(method)
      throw err
    }
  }

  function normalizeAddrList(addrs: string[]): string[] {
    return parseAddrSpecs(addrs.join(', '))
  }

  function storeMessage(input: {
    threadId: string
    labelIds: string[]
    fromRaw: string | null
    to?: string[]
    cc?: string[]
    deliveredTo?: string[]
    subject?: string | null
    bodyText: string | null
    inReplyTo?: string | null
    references?: string | null
    authenticationResults?: string | null
    dogeBuddyProposalId?: string | null
  }): StoredMessage {
    const id = nextMessageId()
    const stored: StoredMessage = {
      id,
      threadId: input.threadId,
      labelIds: [...input.labelIds],
      internalDate: nextInternalDate(),
      fromRaw: input.fromRaw,
      to: normalizeAddrList(input.to ?? []),
      cc: normalizeAddrList(input.cc ?? []),
      deliveredTo: normalizeAddrList(input.deliveredTo ?? []),
      subject: input.subject ?? null,
      bodyText: input.bodyText,
      rfcMessageId: `<${id}@mock.gmail>`,
      inReplyTo: input.inReplyTo ?? null,
      references: input.references ?? null,
      authenticationResults: input.authenticationResults ?? null,
      dogeBuddyProposalId: input.dogeBuddyProposalId ?? null,
      gone: false,
    }
    messages.set(id, stored)
    return stored
  }

  function buildNormalizedMessage(msg: StoredMessage, format: 'metadata' | 'full'): NormalizedMessage {
    return {
      id: msg.id,
      threadId: msg.threadId,
      labelIds: [...msg.labelIds],
      internalDate: msg.internalDate,
      fromAddr: parseFirstAddrSpec(msg.fromRaw),
      fromRaw: msg.fromRaw,
      to: [...msg.to],
      cc: [...msg.cc],
      deliveredTo: [...msg.deliveredTo],
      subject: msg.subject,
      rfcMessageId: msg.rfcMessageId,
      inReplyTo: msg.inReplyTo,
      references: msg.references,
      authenticationResults: msg.authenticationResults,
      dogeBuddyProposalId: msg.dogeBuddyProposalId,
      bodyText: format === 'metadata' ? null : msg.bodyText,
    }
  }

  /** getMessage's 404 shape: the real client maps getMessage's 404 specifically to MessageGoneError. */
  function requireLiveMessage(id: string): StoredMessage {
    const msg = messages.get(id)
    if (!msg || msg.gone) throw new MessageGoneError()
    return msg
  }

  /** modifyMessage's 404 shape: the real client's request() only special-cases 404 for the
   * listHistory and getMessage endpoints — every other endpoint (including messages.modify) falls
   * through to a plain GmailApiError. Mirrored here for fidelity rather than reusing MessageGoneError. */
  function requireMessageForModify(id: string): StoredMessage {
    const msg = messages.get(id)
    if (!msg || msg.gone) throw new GmailApiError('Requested entity was not found.', 404, 'notFound')
    return msg
  }

  return {
    async getProfile() {
      maybeThrowPending('getProfile')
      return { emailAddress: selfAddress, historyId: historyCounter.toString() }
    },

    async listHistory(q) {
      maybeThrowPending('listHistory')
      if (expireHistoryPending) {
        expireHistoryPending = false
        throw new HistoryExpiredError()
      }
      const start = BigInt(q.startHistoryId)
      const records = historyLog
        .filter((r) => BigInt(r.id) > start)
        .map((r) => ({ id: r.id, messagesAdded: r.messagesAdded.map((m) => ({ ...m })) }))
      return { records, nextPageToken: undefined }
    },

    async listMessages(q) {
      maybeThrowPending('listMessages')
      const target = q.q ? extractResyncTarget(q.q) : null
      const includeSpamTrash = q.includeSpamTrash ?? false

      const ids: { id: string; threadId: string }[] = []
      for (const msg of messages.values()) {
        if (msg.gone) continue
        if (!includeSpamTrash && (msg.labelIds.includes('SPAM') || msg.labelIds.includes('TRASH'))) continue
        if (target && !(msg.to.includes(target) || msg.cc.includes(target) || msg.deliveredTo.includes(target))) {
          continue
        }
        ids.push({ id: msg.id, threadId: msg.threadId })
      }
      return { ids, nextPageToken: undefined }
    },

    async getThread(threadId) {
      maybeThrowPending('getThread')
      const ids: { id: string }[] = []
      for (const msg of messages.values()) {
        if (msg.gone) continue
        if (msg.threadId !== threadId) continue
        ids.push({ id: msg.id })
      }
      return { messages: ids }
    },

    async getMessage(id, opts) {
      maybeThrowPending('getMessage')
      const msg = requireLiveMessage(id)
      return buildNormalizedMessage(msg, opts.format)
    },

    async listLabels() {
      maybeThrowPending('listLabels')
      return [...labelRegistry.entries()].map(([id, name]) => ({ id, name }))
    },

    async createLabel(name) {
      maybeThrowPending('createLabel')
      labelCounter += 1
      const id = `Label_${labelCounter}`
      labelRegistry.set(id, name)
      return { id, name }
    },

    async modifyMessage(id, mods) {
      maybeThrowPending('modifyMessage')
      const msg = requireMessageForModify(id)
      const toRemove = new Set(mods.removeLabelIds ?? [])
      const next = new Set(msg.labelIds.filter((l) => !toRemove.has(l)))
      for (const l of mods.addLabelIds ?? []) next.add(l)
      msg.labelIds = [...next]
    },

    async sendReply(r) {
      maybeThrowPending('sendReply')
      // Route through the same builder the real client uses — this both validates/sanitizes
      // extraHeaders identically and gives sentMessages() a realistic raw message to decode.
      const raw = buildReplyRaw({
        from: selfAddress,
        to: r.to,
        subject: r.subject,
        inReplyTo: r.inReplyTo,
        references: r.references,
        bodyText: r.bodyText,
        extraHeaders: r.extraHeaders,
      })
      const msg = storeMessage({
        threadId: r.threadId,
        labelIds: ['SENT'],
        fromRaw: selfAddress,
        to: [r.to],
        bodyText: r.bodyText,
        subject: r.subject,
        inReplyTo: r.inReplyTo,
        references: r.references,
        // Same round-trip the real Gmail does: a header stamped on the way out comes back on the
        // way in. Without this the mock could never exercise `apply-support-reply.ts`'s re-entry
        // recovery, which reads the marker back off the thread.
        dogeBuddyProposalId: r.extraHeaders?.[PROPOSAL_MARKER_HEADER] ?? null,
      })
      sentRawMessages.push({ id: msg.id, threadId: msg.threadId, raw })
      pushHistory([{ id: msg.id, threadId: msg.threadId }])
      return { id: msg.id, threadId: msg.threadId }
    },

    receiveInbound(m) {
      const threadId = m.threadId ?? nextThreadId()
      const msg = storeMessage({
        threadId,
        labelIds: m.labelIds ?? ['INBOX'],
        fromRaw: m.from,
        to: m.to ?? [selfAddress],
        cc: m.cc,
        deliveredTo: m.deliveredTo,
        subject: m.subject,
        bodyText: m.bodyText,
        inReplyTo: m.inReplyTo ?? null,
        references: m.references ?? null,
        authenticationResults: m.authenticationResults ?? null,
      })
      pushHistory([{ id: msg.id, threadId: msg.threadId }])
      return { id: msg.id, threadId: msg.threadId }
    },

    saveDraft(m) {
      const priorIds = draftsByThread.get(m.threadId) ?? []
      for (const priorId of priorIds) {
        const prior = messages.get(priorId)
        if (prior) prior.gone = true
      }

      const msg = storeMessage({
        threadId: m.threadId,
        labelIds: ['DRAFT'],
        fromRaw: selfAddress,
        bodyText: m.bodyText,
      })
      draftsByThread.set(m.threadId, [msg.id])
      pushHistory([{ id: msg.id, threadId: msg.threadId }])
      return { id: msg.id }
    },

    sendDraft(threadId) {
      const draftIds = draftsByThread.get(threadId) ?? []
      // No live draft to send — either this thread never had one, or a concurrent sendDraft
      // already consumed it (draft-churn race). Every other operate-on-missing-state path in
      // this mock fails loudly; sendDraft must not silently send a null-body message.
      if (draftIds.length === 0) throw new MessageGoneError()

      let bodyText: string | null = null
      for (const draftId of draftIds) {
        const draft = messages.get(draftId)
        if (draft) {
          draft.gone = true
          bodyText = draft.bodyText
        }
      }
      draftsByThread.delete(threadId)

      const msg = storeMessage({
        threadId,
        labelIds: ['SENT'],
        fromRaw: selfAddress,
        bodyText,
      })
      pushHistory([{ id: msg.id, threadId: msg.threadId }])
      return { id: msg.id }
    },

    expireHistory() {
      expireHistoryPending = true
    },

    failNext(method, err) {
      pendingMethodFailures.set(method, err)
    },

    labelsOf(id) {
      const msg = messages.get(id)
      if (!msg) throw new Error(`MockGmail.labelsOf: unknown message id "${id}"`)
      return [...msg.labelIds]
    },

    advanceHistoryTo(id) {
      const target = BigInt(id)
      if (target > historyCounter) historyCounter = target
    },

    sentMessages() {
      return sentRawMessages.map((m) => ({ ...m }))
    },
  }
}
