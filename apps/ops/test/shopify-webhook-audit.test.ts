import { auditLog, createDb } from '@doge-buddy/db'
import { ShopifyAdminClient, ShopifyTokenManager } from '@doge-buddy/shopify-admin'
import { and, eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { shopifyWebhookAudit } from '../src/jobs/shopify-webhook-audit.ts'

const tokenOk = () => new Response(JSON.stringify({ access_token: 'tok', expires_in: 86399 }), { status: 200 })
const gql = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })

interface GraphqlCall {
  query: string
  variables?: Record<string, unknown>
}

// Reuses the fake-fetch harness pattern from packages/shopify-admin/test/operations.test.ts,
// but branches per-call on the operation name since a single audit run makes several
// distinct graphql calls (one list, N creates, N deletes).
function makeClient(handler: (call: GraphqlCall) => Response) {
  const calls: GraphqlCall[] = []
  const fetchImpl = async (url: string, init?: RequestInit) => {
    if (url.endsWith('/admin/oauth/access_token')) return tokenOk()
    const body = JSON.parse(init!.body as string) as GraphqlCall
    calls.push(body)
    return handler(body)
  }
  const tokenManager = new ShopifyTokenManager({ shopDomain: 's.myshopify.com', clientId: 'a', clientSecret: 'b', fetchImpl })
  const client = new ShopifyAdminClient({ shopDomain: 's.myshopify.com', tokenManager, fetchImpl, sleep: async () => {} })
  return { client, calls }
}

// A create-or-delete-succeeds-unconditionally handler, layered on top of a fixed `list` response —
// covers every test below whose fixture doesn't care about a specific create/delete request shape,
// only about which topics/ids end up called.
function withMutationsOk(listNodes: unknown[]) {
  return (call: GraphqlCall) => {
    if (call.query.includes('webhookSubscriptionCreate')) {
      return gql({
        webhookSubscriptionCreate: { webhookSubscription: { id: 'gid://shopify/WebhookSubscription/new' }, userErrors: [] },
      })
    }
    if (call.query.includes('webhookSubscriptionDelete')) {
      return gql({ webhookSubscriptionDelete: { userErrors: [] } })
    }
    return gql({ webhookSubscriptions: { nodes: listNodes } })
  }
}

const ADMIN_BASE_URL = 'https://ops.example'
const CALLBACK_URL = 'https://ops.example/webhooks/shopify'
const STALE_URL = 'https://stale.example/webhooks/shopify'

describe('shopifyWebhookAudit', () => {
  const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  // Audit log rows are never deleted, so absolute counts would be non-deterministic across the
  // whole suite's lifetime — same before/after delta pattern `wallet-monitor.test.ts` uses for
  // alerts (`alertsSince`), scoped here to `webhook.subscription_pruned` rows for a given
  // subscription id.
  async function pruneAuditRowsFor(entityId: string) {
    return db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'webhook.subscription_pruned'), eq(auditLog.entityId, entityId)))
  }
  async function pruneAuditIds(entityId: string): Promise<Set<bigint>> {
    return new Set((await pruneAuditRowsFor(entityId)).map((r) => r.id))
  }
  async function pruneAuditRowsSince(entityId: string, before: Set<bigint>) {
    return (await pruneAuditRowsFor(entityId)).filter((r) => !before.has(r.id))
  }

  it('creates only the missing required-topic subscriptions', async () => {
    const { client, calls } = makeClient(
      withMutationsOk([{ id: 'gid://shopify/WebhookSubscription/1', topic: 'ORDERS_PAID', endpoint: { callbackUrl: CALLBACK_URL } }]),
    )

    const result = await shopifyWebhookAudit({ client, adminBaseUrl: ADMIN_BASE_URL, db })

    expect(result).toEqual({ created: ['ORDERS_CANCELLED', 'REFUNDS_CREATE'], pruned: [] })

    const createCalls = calls.filter((c) => c.query.includes('webhookSubscriptionCreate'))
    expect(createCalls).toHaveLength(2)
    for (const call of createCalls) {
      expect(call.variables?.webhookSubscription).toEqual({ uri: CALLBACK_URL })
    }
    expect(createCalls.map((c) => c.variables?.topic).sort()).toEqual(['ORDERS_CANCELLED', 'REFUNDS_CREATE'])
    expect(calls.filter((c) => c.query.includes('webhookSubscriptionDelete'))).toHaveLength(0)
  })

  it('creates nothing when all required topics are already correctly subscribed', async () => {
    const { client, calls } = makeClient(
      withMutationsOk([
        { id: '1', topic: 'ORDERS_PAID', endpoint: { callbackUrl: CALLBACK_URL } },
        { id: '2', topic: 'ORDERS_CANCELLED', endpoint: { callbackUrl: CALLBACK_URL } },
        { id: '3', topic: 'REFUNDS_CREATE', endpoint: { callbackUrl: CALLBACK_URL } },
      ]),
    )

    const result = await shopifyWebhookAudit({ client, adminBaseUrl: ADMIN_BASE_URL, db })

    expect(result).toEqual({ created: [], pruned: [] })
    expect(calls.filter((c) => c.query.includes('webhookSubscriptionCreate'))).toHaveLength(0)
    expect(calls.filter((c) => c.query.includes('webhookSubscriptionDelete'))).toHaveLength(0)
  })

  it('recreates AND prunes a managed-topic subscription that points at the wrong URL', async () => {
    const before = await pruneAuditIds('2')
    const { client, calls } = makeClient(
      withMutationsOk([
        { id: '1', topic: 'ORDERS_PAID', endpoint: { callbackUrl: CALLBACK_URL } },
        { id: '2', topic: 'ORDERS_CANCELLED', endpoint: { callbackUrl: STALE_URL } },
        { id: '3', topic: 'REFUNDS_CREATE', endpoint: { callbackUrl: CALLBACK_URL } },
      ]),
    )

    const result = await shopifyWebhookAudit({ client, adminBaseUrl: ADMIN_BASE_URL, db })

    expect(result).toEqual({
      created: ['ORDERS_CANCELLED'],
      pruned: [{ id: '2', topic: 'ORDERS_CANCELLED', callbackUrl: STALE_URL }],
    })

    const createCalls = calls.filter((c) => c.query.includes('webhookSubscriptionCreate'))
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]!.variables).toEqual({ topic: 'ORDERS_CANCELLED', webhookSubscription: { uri: CALLBACK_URL } })

    const deleteCalls = calls.filter((c) => c.query.includes('webhookSubscriptionDelete'))
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0]!.variables).toEqual({ id: '2' })

    const newAuditRows = await pruneAuditRowsSince('2', before)
    expect(newAuditRows).toHaveLength(1)
    expect(newAuditRows[0]).toMatchObject({
      actor: 'system',
      action: 'webhook.subscription_pruned',
      entityType: 'webhook_subscription',
      entityId: '2',
      detail: { topic: 'ORDERS_CANCELLED', callbackUrl: STALE_URL, id: '2' },
    })
  })

  it('leaves a subscription for a topic it does not manage untouched, regardless of URL', async () => {
    const { client, calls } = makeClient(
      withMutationsOk([
        { id: '1', topic: 'ORDERS_PAID', endpoint: { callbackUrl: CALLBACK_URL } },
        { id: '2', topic: 'ORDERS_CANCELLED', endpoint: { callbackUrl: CALLBACK_URL } },
        { id: '3', topic: 'REFUNDS_CREATE', endpoint: { callbackUrl: CALLBACK_URL } },
        // Unmanaged topic, pointing at a completely unrelated URL — would look "stale" by the
        // wrong-URL rule if that rule were mistakenly applied to every topic instead of only
        // REQUIRED_TOPICS.
        { id: '4', topic: 'PRODUCTS_UPDATE', endpoint: { callbackUrl: STALE_URL } },
      ]),
    )

    const result = await shopifyWebhookAudit({ client, adminBaseUrl: ADMIN_BASE_URL, db })

    expect(result).toEqual({ created: [], pruned: [] })
    expect(calls.filter((c) => c.query.includes('webhookSubscriptionDelete'))).toHaveLength(0)
  })

  it('dedupes two correct-URL subscriptions on the same managed topic, keeping the first and pruning the rest', async () => {
    const before = await pruneAuditIds('1b')
    const { client, calls } = makeClient(
      withMutationsOk([
        { id: '1a', topic: 'ORDERS_PAID', endpoint: { callbackUrl: CALLBACK_URL } },
        { id: '1b', topic: 'ORDERS_PAID', endpoint: { callbackUrl: CALLBACK_URL } }, // duplicate, same topic+url
        { id: '2', topic: 'ORDERS_CANCELLED', endpoint: { callbackUrl: CALLBACK_URL } },
        { id: '3', topic: 'REFUNDS_CREATE', endpoint: { callbackUrl: CALLBACK_URL } },
      ]),
    )

    const result = await shopifyWebhookAudit({ client, adminBaseUrl: ADMIN_BASE_URL, db })

    // Nothing "missing" — ORDERS_PAID already has a correctly-pointed subscription (the first one).
    expect(result).toEqual({
      created: [],
      pruned: [{ id: '1b', topic: 'ORDERS_PAID', callbackUrl: CALLBACK_URL }],
    })
    expect(calls.filter((c) => c.query.includes('webhookSubscriptionCreate'))).toHaveLength(0)

    const deleteCalls = calls.filter((c) => c.query.includes('webhookSubscriptionDelete'))
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0]!.variables).toEqual({ id: '1b' })

    const newAuditRows = await pruneAuditRowsSince('1b', before)
    expect(newAuditRows).toHaveLength(1)
    expect(newAuditRows[0]).toMatchObject({
      action: 'webhook.subscription_pruned',
      entityId: '1b',
      detail: { topic: 'ORDERS_PAID', callbackUrl: CALLBACK_URL, id: '1b' },
    })
  })
})
