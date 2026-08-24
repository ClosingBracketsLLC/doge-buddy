import { auditLog, createDb, webhookEvents } from '@doge-buddy/db'
import { createHmac } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildServer } from '../src/server.ts'
import type { WebhookDeps } from '../src/http/webhooks.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

const SHOPIFY_SECRET = 'testsecret'

function signShopify(rawBody: string): string {
  return createHmac('sha256', SHOPIFY_SECRET).update(rawBody).digest('base64')
}

describe('POST /webhooks', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  let enqueue: ReturnType<typeof vi.fn>

  function makeDeps(overrides: Partial<WebhookDeps> = {}): WebhookDeps {
    enqueue = vi.fn(async () => {})
    return {
      db,
      enqueue,
      shopifyWebhookSecret: SHOPIFY_SECRET,
      cjVerify: (raw: Buffer) => raw.toString().includes('valid'),
      cjParse: (raw: Buffer) => {
        // Deliberately unguarded JSON.parse, mirroring the real CJSupplierAdapter.parseWebhook
        // — the route itself is responsible for catching a throw here (test 7).
        const body = JSON.parse(raw.toString()) as { id?: string }
        return { externalEventId: body.id ?? 'cj-x', type: 'order' }
      },
      ...overrides,
    }
  }

  beforeEach(() => {
    enqueue = vi.fn(async () => {})
  })

  it('1. valid Shopify HMAC + fresh webhook id -> 200, one row, enqueue called once', async () => {
    const deps = makeDeps()
    const app = buildServer({
      pool,
      isQueueReady: () => true,
      webhooks: deps,
    })
    const webhookId = `wh-${Date.now()}-1`
    const body = JSON.stringify({ id: 12345, foo: 'bar' })
    const hmac = signShopify(body)

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/shopify',
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': hmac,
        'x-shopify-webhook-id': webhookId,
        'x-shopify-topic': 'orders/create',
      },
      payload: Buffer.from(body),
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, duplicate: false })

    const rows = await db
      .select()
      .from(webhookEvents)
      .where(and(eq(webhookEvents.source, 'shopify'), eq(webhookEvents.externalEventId, webhookId)))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.topic).toBe('orders/create')
    expect(rows[0]!.processedAt).toBeNull()

    expect(deps.enqueue).toHaveBeenCalledTimes(1)
    expect(deps.enqueue).toHaveBeenCalledWith('webhook.shopify.process', { webhookEventId: rows[0]!.id })

    await app.close()
  })

  it('2. replayed delivery (same webhook id) -> 200 duplicate:true, still one row, enqueue not called again', async () => {
    const deps = makeDeps()
    const app = buildServer({
      pool,
      isQueueReady: () => true,
      webhooks: deps,
    })
    const webhookId = `wh-${Date.now()}-2`
    const body = JSON.stringify({ id: 999 })
    const hmac = signShopify(body)
    const headers = {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': hmac,
      'x-shopify-webhook-id': webhookId,
      'x-shopify-topic': 'orders/create',
    }

    const first = await app.inject({ method: 'POST', url: '/webhooks/shopify', headers, payload: Buffer.from(body) })
    expect(first.statusCode).toBe(200)
    expect(first.json()).toEqual({ ok: true, duplicate: false })

    const second = await app.inject({ method: 'POST', url: '/webhooks/shopify', headers, payload: Buffer.from(body) })
    expect(second.statusCode).toBe(200)
    expect(second.json()).toEqual({ ok: true, duplicate: true })

    const rows = await db
      .select()
      .from(webhookEvents)
      .where(and(eq(webhookEvents.source, 'shopify'), eq(webhookEvents.externalEventId, webhookId)))
    expect(rows).toHaveLength(1)

    expect(deps.enqueue).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it('3. bad HMAC -> 401, zero rows, no enqueue', async () => {
    const deps = makeDeps()
    const app = buildServer({
      pool,
      isQueueReady: () => true,
      webhooks: deps,
    })
    const webhookId = `wh-${Date.now()}-3`
    const body = JSON.stringify({ id: 1 })

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/shopify',
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': 'bogus-not-a-real-hmac',
        'x-shopify-webhook-id': webhookId,
        'x-shopify-topic': 'orders/create',
      },
      payload: Buffer.from(body),
    })

    expect(res.statusCode).toBe(401)

    const rows = await db
      .select()
      .from(webhookEvents)
      .where(and(eq(webhookEvents.source, 'shopify'), eq(webhookEvents.externalEventId, webhookId)))
    expect(rows).toHaveLength(0)
    expect(deps.enqueue).not.toHaveBeenCalled()

    await app.close()
  })

  it('4. no shopifyWebhookSecret configured -> 503', async () => {
    const deps = makeDeps({ shopifyWebhookSecret: undefined })
    const app = buildServer({
      pool,
      isQueueReady: () => true,
      webhooks: deps,
    })
    const body = JSON.stringify({ id: 1 })

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/shopify',
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': 'whatever',
        'x-shopify-webhook-id': `wh-${Date.now()}-4`,
      },
      payload: Buffer.from(body),
    })

    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ error: 'not configured' })

    await app.close()
  })

  it('5. CJ valid body -> 200 + row with source cj; CJ invalid -> 401', async () => {
    const deps = makeDeps()
    const app = buildServer({
      pool,
      isQueueReady: () => true,
      webhooks: deps,
    })
    const cjId = `cj-${Date.now()}-5`
    const validBody = JSON.stringify({ id: cjId, status: 'valid' })

    const validRes = await app.inject({
      method: 'POST',
      url: '/webhooks/cj',
      headers: { 'content-type': 'application/json' },
      payload: Buffer.from(validBody),
    })
    expect(validRes.statusCode).toBe(200)
    expect(validRes.json()).toEqual({ ok: true, duplicate: false })

    const rows = await db
      .select()
      .from(webhookEvents)
      .where(and(eq(webhookEvents.source, 'cj'), eq(webhookEvents.externalEventId, cjId)))
    expect(rows).toHaveLength(1)
    expect(deps.enqueue).toHaveBeenCalledWith('webhook.cj.process', { webhookEventId: rows[0]!.id })

    const invalidId = `cj-${Date.now()}-5b`
    const invalidBody = JSON.stringify({ id: invalidId, status: 'nope' })
    const invalidRes = await app.inject({
      method: 'POST',
      url: '/webhooks/cj',
      headers: { 'content-type': 'application/json' },
      payload: Buffer.from(invalidBody),
    })
    expect(invalidRes.statusCode).toBe(401)

    const invalidRows = await db
      .select()
      .from(webhookEvents)
      .where(and(eq(webhookEvents.source, 'cj'), eq(webhookEvents.externalEventId, invalidId)))
    expect(invalidRows).toHaveLength(0)

    await app.close()
  })

  it('6. missing x-shopify-webhook-id header -> still 200; external_event_id is 64-hex sha256', async () => {
    const deps = makeDeps()
    const app = buildServer({
      pool,
      isQueueReady: () => true,
      webhooks: deps,
    })
    const body = JSON.stringify({ id: `no-header-${Date.now()}-6` })
    const hmac = signShopify(body)

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/shopify',
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': hmac,
        'x-shopify-topic': 'orders/create',
      },
      payload: Buffer.from(body),
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, duplicate: false })

    const rows = await db.select().from(webhookEvents).where(eq(webhookEvents.source, 'shopify'))
    const match = rows.find((r) => r.payload && (r.payload as { id?: string }).id === JSON.parse(body).id)
    expect(match).toBeDefined()
    expect(match!.externalEventId).toMatch(/^[a-f0-9]{64}$/)

    await app.close()
  })

  it('7. CJ valid signature but cjParse throws on malformed JSON -> still 200, row with 64-hex external_event_id', async () => {
    const deps = makeDeps()
    const app = buildServer({
      pool,
      isQueueReady: () => true,
      webhooks: deps,
    })
    // Passes cjVerify (contains "valid") but is not parseable JSON, so the test harness's
    // cjParse (a bare JSON.parse, like the real CJSupplierAdapter.parseWebhook) throws.
    const body = `not-json-but-valid-signature-{{{${Date.now()}-7`

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/cj',
      headers: { 'content-type': 'application/json' },
      payload: Buffer.from(body),
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, duplicate: false })

    const rows = await db.select().from(webhookEvents).where(eq(webhookEvents.source, 'cj'))
    const match = rows.find((r) => (r.payload as { raw?: string } | null)?.raw === Buffer.from(body).toString('base64'))
    expect(match).toBeDefined()
    expect(match!.externalEventId).toMatch(/^[a-f0-9]{64}$/)
    expect(deps.enqueue).toHaveBeenCalledWith('webhook.cj.process', { webhookEventId: match!.id })

    await app.close()
  })

  it('8. rejected CJ request is captured to audit_log with its headers (signature-scheme diagnosis)', async () => {
    // CJ's signature scheme has never been observed on a live delivery (docs/cj-api-notes.md
    // §Still unverified) — CJ's own registration probe 401'd against this route. Every rejected
    // request must leave diagnostic evidence: which headers CJ sent, what the body looked like.
    const deps = makeDeps()
    const app = buildServer({
      pool,
      isQueueReady: () => true,
      webhooks: deps,
    })
    const marker = `probe-${Date.now()}-8`
    const body = JSON.stringify({ id: marker, status: 'nope' })

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/cj',
      headers: { 'content-type': 'application/json', 'x-cj-mystery-header': 'probe-value' },
      payload: Buffer.from(body),
    })
    expect(res.statusCode).toBe(401)

    const rows = await db.select().from(auditLog).where(eq(auditLog.action, 'webhook.cj.rejected'))
    const match = rows.find((r) => {
      const detail = r.detail as { bodyPreview?: string } | null
      return detail?.bodyPreview?.includes(marker)
    })
    expect(match).toBeDefined()
    const detail = match!.detail as { headers: Record<string, string>; bodySha256: string; bodyLength: number }
    expect(detail.headers['x-cj-mystery-header']).toBe('probe-value')
    expect(detail.bodySha256).toMatch(/^[a-f0-9]{64}$/)
    expect(detail.bodyLength).toBe(Buffer.byteLength(body))

    await app.close()
  })
})
