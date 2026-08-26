import { describe, expect, it } from 'vitest'
import { createMockGmail } from '../src/mock.ts'
import { GmailApiError, HistoryExpiredError, MessageGoneError, isMessageGone } from '../src/errors.ts'

const SELF = 'support@dogebuddy.com'

describe('createMockGmail', () => {
  it('receiveInbound: the new message is visible via listHistory', async () => {
    const gmail = createMockGmail({ selfAddress: SELF })
    const before = await gmail.getProfile()

    const { id, threadId } = gmail.receiveInbound({
      from: 'jane@example.com',
      subject: 'Order help',
      bodyText: 'Where is my order?',
    })

    const { records } = await gmail.listHistory({ startHistoryId: before.historyId })
    expect(records).toHaveLength(1)
    expect(records[0]!.messagesAdded).toEqual([{ id, threadId }])
  })

  it('incremental history: a second listHistory from the first record id returns only the new record', async () => {
    const gmail = createMockGmail({ selfAddress: SELF })
    const before = await gmail.getProfile()

    const first = gmail.receiveInbound({ from: 'a@example.com', subject: 'One', bodyText: 'first' })
    const afterFirst = await gmail.listHistory({ startHistoryId: before.historyId })
    expect(afterFirst.records).toHaveLength(1)
    const firstRecordId = afterFirst.records[0]!.id

    const second = gmail.receiveInbound({ from: 'b@example.com', subject: 'Two', bodyText: 'second' })

    const onlyNew = await gmail.listHistory({ startHistoryId: firstRecordId })
    expect(onlyNew.records).toHaveLength(1)
    expect(onlyNew.records[0]!.messagesAdded).toEqual([{ id: second.id, threadId: second.threadId }])
    expect(onlyNew.records[0]!.messagesAdded).not.toEqual([{ id: first.id, threadId: first.threadId }])
  })

  it('advanceHistoryTo: steers the counter across a numeric boundary (99 -> 100), proving numeric not lexicographic compare', async () => {
    const gmail = createMockGmail({ selfAddress: SELF })
    gmail.advanceHistoryTo('99')

    const { id, threadId } = gmail.receiveInbound({ from: 'c@example.com', subject: 'Boundary', bodyText: 'x' })

    const { records } = await gmail.listHistory({ startHistoryId: '99' })
    expect(records).toHaveLength(1)
    expect(records[0]!.id).toBe('100')
    expect(records[0]!.messagesAdded).toEqual([{ id, threadId }])
  })

  it('draft churn: each saveDraft replaces the prior revision', async () => {
    const gmail = createMockGmail({ selfAddress: SELF })
    const before = await gmail.getProfile()
    const threadId = 'thread-1'

    const draft1 = gmail.saveDraft({ threadId, bodyText: 'first draft' })
    const draft2 = gmail.saveDraft({ threadId, bodyText: 'second draft' })

    expect(draft1.id).not.toBe(draft2.id)

    // first draft is now gone via getMessage...
    await expect(gmail.getMessage(draft1.id, { format: 'full' })).rejects.toBeInstanceOf(MessageGoneError)
    // ...but both are still DRAFT-labeled per the assertion helper
    expect(gmail.labelsOf(draft1.id)).toEqual(['DRAFT'])
    expect(gmail.labelsOf(draft2.id)).toEqual(['DRAFT'])

    // getMessage on the live draft succeeds and shows DRAFT
    const live = await gmail.getMessage(draft2.id, { format: 'full' })
    expect(live.labelIds).toEqual(['DRAFT'])
    expect(live.bodyText).toBe('second draft')

    // two history adds total, both referencing the newest id at time of the call
    const { records } = await gmail.listHistory({ startHistoryId: before.historyId })
    expect(records).toHaveLength(2)
    expect(records[0]!.messagesAdded).toEqual([{ id: draft1.id, threadId }])
    expect(records[1]!.messagesAdded).toEqual([{ id: draft2.id, threadId }])
  })

  it('sendDraft: SENT message present, draft ids gone', async () => {
    const gmail = createMockGmail({ selfAddress: SELF })
    const threadId = 'thread-2'
    const draft = gmail.saveDraft({ threadId, bodyText: 'ready to send' })

    const sent = gmail.sendDraft(threadId)

    await expect(gmail.getMessage(draft.id, { format: 'full' })).rejects.toBeInstanceOf(MessageGoneError)

    const sentMsg = await gmail.getMessage(sent.id, { format: 'full' })
    expect(sentMsg.labelIds).toEqual(['SENT'])
    expect(sentMsg.threadId).toBe(threadId)
    expect(sentMsg.bodyText).toBe('ready to send')
  })

  it('sendDraft: throws MessageGoneError when there is no live draft for the thread', () => {
    const gmail = createMockGmail({ selfAddress: SELF })

    // a thread that never had a draft at all
    expect(() => gmail.sendDraft('thread-never-drafted')).toThrow(MessageGoneError)

    // a thread whose draft was already sent — the second sendDraft races against the first
    const threadId = 'thread-send-twice'
    gmail.saveDraft({ threadId, bodyText: 'ready' })
    gmail.sendDraft(threadId)
    expect(() => gmail.sendDraft(threadId)).toThrow(MessageGoneError)
  })

  it('modifyMessage: a missing/gone id throws plain GmailApiError(404), NOT MessageGoneError', async () => {
    const gmail = createMockGmail({ selfAddress: SELF })
    const threadId = 'thread-modify-404'
    const draft1 = gmail.saveDraft({ threadId, bodyText: 'first' })
    gmail.saveDraft({ threadId, bodyText: 'second' }) // churn — draft1.id is now gone

    let caught: unknown
    try {
      await gmail.modifyMessage(draft1.id, { addLabelIds: ['FOO'] })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(GmailApiError)
    expect((caught as GmailApiError).status).toBe(404)
    expect(isMessageGone(caught)).toBe(false)

    // never-existed id behaves the same way
    await expect(gmail.modifyMessage('mock-msg-does-not-exist', { addLabelIds: ['FOO'] })).rejects.toMatchObject({
      name: 'GmailApiError',
      status: 404,
    })
  })

  it('expireHistory: the next listHistory call throws HistoryExpiredError, then behavior returns to normal', async () => {
    const gmail = createMockGmail({ selfAddress: SELF })
    const before = await gmail.getProfile()
    gmail.receiveInbound({ from: 'a@example.com', subject: 'x', bodyText: 'y' })

    gmail.expireHistory()
    await expect(gmail.listHistory({ startHistoryId: before.historyId })).rejects.toBeInstanceOf(HistoryExpiredError)

    // normal again
    const { records } = await gmail.listHistory({ startHistoryId: before.historyId })
    expect(records).toHaveLength(1)
  })

  it('modifyMessage/labelsOf round-trip', async () => {
    const gmail = createMockGmail({ selfAddress: SELF })
    const { id } = gmail.receiveInbound({ from: 'a@example.com', subject: 'x', bodyText: 'y' })

    expect(gmail.labelsOf(id)).toEqual(['INBOX'])

    await gmail.modifyMessage(id, { addLabelIds: ['DogeBuddy/New'], removeLabelIds: ['INBOX'] })

    expect(gmail.labelsOf(id)).toEqual(['DogeBuddy/New'])
  })

  it('failNext: injects a one-shot error for the named method, then normal behavior resumes', async () => {
    const gmail = createMockGmail({ selfAddress: SELF })
    const boom = new Error('boom')

    gmail.failNext('getMessage', boom)
    const { id } = gmail.receiveInbound({ from: 'a@example.com', subject: 'x', bodyText: 'y' })

    await expect(gmail.getMessage(id, { format: 'full' })).rejects.toBe(boom)
    await expect(gmail.getMessage(id, { format: 'full' })).resolves.toMatchObject({ id })
  })

  it('sendReply: appends a SENT message to the thread', async () => {
    const gmail = createMockGmail({ selfAddress: SELF })
    const inbound = gmail.receiveInbound({ from: 'jane@example.com', subject: 'Help', bodyText: 'help me' })

    const reply = await gmail.sendReply({
      threadId: inbound.threadId,
      to: 'jane@example.com',
      subject: 'Re: Help',
      inReplyTo: '<abc@mail.example.com>',
      references: '<abc@mail.example.com>',
      bodyText: 'On it!',
    })

    expect(reply.threadId).toBe(inbound.threadId)
    const sentMsg = await gmail.getMessage(reply.id, { format: 'full' })
    expect(sentMsg.labelIds).toEqual(['SENT'])
    expect(sentMsg.threadId).toBe(inbound.threadId)
    expect(sentMsg.bodyText).toBe('On it!')
    expect(sentMsg.to).toEqual(['jane@example.com'])
  })

  it('receiveInbound: defaults `to` to [selfAddress] when omitted', async () => {
    const gmail = createMockGmail({ selfAddress: SELF })
    const { id } = gmail.receiveInbound({ from: 'jane@example.com', subject: 'x', bodyText: 'y' })
    const msg = await gmail.getMessage(id, { format: 'full' })
    expect(msg.to).toEqual([SELF])
  })

  it('getMessage(metadata): bodyText is null', async () => {
    const gmail = createMockGmail({ selfAddress: SELF })
    const { id } = gmail.receiveInbound({ from: 'jane@example.com', subject: 'x', bodyText: 'has a body' })
    const msg = await gmail.getMessage(id, { format: 'metadata' })
    expect(msg.bodyText).toBeNull()
  })

  it('listMessages: resync q filter matches to/cc/deliveredTo, and includeSpamTrash gates SPAM/TRASH', async () => {
    const gmail = createMockGmail({ selfAddress: SELF })
    const toMatch = gmail.receiveInbound({
      from: 'a@example.com',
      to: [SELF],
      subject: 'to match',
      bodyText: 'x',
    })
    const ccMatch = gmail.receiveInbound({
      from: 'b@example.com',
      to: ['someone-else@example.com'],
      cc: [SELF],
      subject: 'cc match',
      bodyText: 'x',
    })
    const noMatch = gmail.receiveInbound({
      from: 'c@example.com',
      to: ['someone-else@example.com'],
      subject: 'no match',
      bodyText: 'x',
    })
    const spamMatch = gmail.receiveInbound({
      from: 'd@example.com',
      to: [SELF],
      subject: 'spam match',
      bodyText: 'x',
      labelIds: ['SPAM'],
    })

    const q = `to:${SELF} OR cc:${SELF} OR deliveredto:${SELF}`
    const result = await gmail.listMessages({ q })
    const ids = result.ids.map((m) => m.id)
    expect(ids).toContain(toMatch.id)
    expect(ids).toContain(ccMatch.id)
    expect(ids).not.toContain(noMatch.id)
    expect(ids).not.toContain(spamMatch.id)

    const withSpam = await gmail.listMessages({ q, includeSpamTrash: true })
    expect(withSpam.ids.map((m) => m.id)).toContain(spamMatch.id)
  })

  it('listLabels/createLabel: system labels are seeded, custom labels register', async () => {
    const gmail = createMockGmail({ selfAddress: SELF })
    const before = await gmail.listLabels()
    expect(before.map((l) => l.id).sort()).toEqual(['DRAFT', 'INBOX', 'SENT', 'SPAM', 'TRASH'])

    const created = await gmail.createLabel('DogeBuddy/New')
    expect(created.name).toBe('DogeBuddy/New')

    const after = await gmail.listLabels()
    expect(after.map((l) => l.name)).toContain('DogeBuddy/New')
  })
})
