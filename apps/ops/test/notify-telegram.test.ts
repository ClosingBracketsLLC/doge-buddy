import { describe, expect, it, vi } from 'vitest'
import { createTelegramNotifier } from '../src/notify/telegram.ts'
import { createNoopNotifier } from '../src/notify/notify.ts'

const okResponse = () => new Response(JSON.stringify({ ok: true }), { status: 200 })

describe('createTelegramNotifier', () => {
  const alert = vi.fn(async () => {})

  it('POSTs sendMessage with chat_id, text = title + body, and inline URL buttons', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const notify = createTelegramNotifier({
      botToken: 'tok-1', chatId: '42', alert,
      fetchImpl: async (url, init) => { calls.push({ url, init }); return okResponse() },
    })

    const delivered = await notify({
      title: 'New listing proposal',
      body: 'Dog Snuff Pad — margin 62%\n[ ] IP check done',
      actions: [
        { label: 'Approve', url: 'https://ops.example/a/p1/approve?t=abc' },
        { label: 'Reject', url: 'https://ops.example/a/p1/reject?t=abc' },
      ],
    })

    expect(delivered).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.telegram.org/bottok-1/sendMessage')
    const body = JSON.parse(String(calls[0]!.init!.body))
    expect(body.chat_id).toBe('42')
    expect(body.text).toBe('New listing proposal\n\nDog Snuff Pad — margin 62%\n[ ] IP check done')
    expect(body.reply_markup.inline_keyboard).toEqual([[
      { text: 'Approve', url: 'https://ops.example/a/p1/approve?t=abc' },
      { text: 'Reject', url: 'https://ops.example/a/p1/reject?t=abc' },
    ]])
  })

  it('resolves false and alerts on a non-ok HTTP response — never throws', async () => {
    const notify = createTelegramNotifier({
      botToken: 't', chatId: '1', alert,
      fetchImpl: async () => new Response('{"ok":false,"description":"blocked"}', { status: 403 }),
    })
    await expect(notify({ title: 'x', body: 'y' })).resolves.toBe(false)
    expect(alert).toHaveBeenCalledWith('warning', 'notify_failed', expect.objectContaining({ status: 403 }))
  })

  it('resolves false and alerts when fetch itself rejects — never throws', async () => {
    const notify = createTelegramNotifier({
      botToken: 't', chatId: '1', alert,
      fetchImpl: async () => { throw new Error('ECONNRESET') },
    })
    await expect(notify({ title: 'x', body: 'y' })).resolves.toBe(false)
  })

  it('omits reply_markup when there are no actions', async () => {
    const calls: { init?: RequestInit }[] = []
    const notify = createTelegramNotifier({
      botToken: 't', chatId: '1', alert,
      fetchImpl: async (_url, init) => { calls.push({ init }); return okResponse() },
    })
    await notify({ title: 'x', body: 'y' })
    expect('reply_markup' in JSON.parse(String(calls[0]!.init!.body))).toBe(false)
  })

  it('resolves false when alert throws on non-ok response — never rejects', async () => {
    const throwingAlert = vi.fn(async () => { throw new Error('db down') })
    const notify = createTelegramNotifier({
      botToken: 't', chatId: '1', alert: throwingAlert,
      fetchImpl: async () => new Response('{"ok":false}', { status: 403 }),
    })
    await expect(notify({ title: 'x', body: 'y' })).resolves.toBe(false)
  })

  it('resolves false when alert throws on fetch error — never rejects', async () => {
    const throwingAlert = vi.fn(async () => { throw new Error('db down') })
    const notify = createTelegramNotifier({
      botToken: 't', chatId: '1', alert: throwingAlert,
      fetchImpl: async () => { throw new Error('ECONNRESET') },
    })
    await expect(notify({ title: 'x', body: 'y' })).resolves.toBe(false)
  })
})

describe('createNoopNotifier', () => {
  it('resolves false when alert throws — never rejects', async () => {
    const throwingAlert = vi.fn(async () => { throw new Error('db down') })
    const notify = createNoopNotifier(throwingAlert)
    await expect(notify({ title: 'x', body: 'y' })).resolves.toBe(false)
  })
})
