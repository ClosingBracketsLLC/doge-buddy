import { createHash } from 'node:crypto'
import { type createDb, webhookEvents } from '@doge-buddy/db'
import { verifyShopifyWebhookHmac } from '@doge-buddy/shopify-admin'
import type { FastifyPluginAsync } from 'fastify'

type Db = ReturnType<typeof createDb>['db']

export interface WebhookDeps {
  db: Db
  enqueue: (
    name: 'webhook.shopify.process' | 'webhook.cj.process',
    data: { webhookEventId: string },
  ) => Promise<void>
  shopifyWebhookSecret?: string
  cjVerify?: (rawBody: Buffer, headers: Record<string, string | string[] | undefined>) => boolean
  cjParse?: (rawBody: Buffer) => { externalEventId: string; type: string }
}

function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function parsePayload(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString('utf8'))
  } catch {
    return { raw: rawBody.toString('base64') }
  }
}

export function webhookRoutes(deps: WebhookDeps): FastifyPluginAsync {
  return async (fastify) => {
    // Scoped to this plugin's encapsulation context only — other routes (e.g. /healthz)
    // keep Fastify's default JSON body parsing. Fastify pre-registers an exact-match parser
    // for 'application/json' (and 'text/plain') that always wins over a '*' wildcard parser
    // for those content types, so 'application/json' — what Shopify/CJ actually send — must
    // be overridden explicitly too, in addition to the wildcard for anything else.
    const rawBodyParser = (_req: unknown, body: unknown, done: (err: Error | null, body?: unknown) => void): void => {
      done(null, body as Buffer)
    }
    fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, rawBodyParser)
    fastify.addContentTypeParser('*', { parseAs: 'buffer' }, rawBodyParser)

    async function recordAndEnqueue(
      source: 'shopify' | 'cj',
      externalEventId: string,
      topic: string | undefined,
      rawBody: Buffer,
      queueName: 'webhook.shopify.process' | 'webhook.cj.process',
    ): Promise<{ ok: true; duplicate: boolean }> {
      const inserted = await deps.db
        .insert(webhookEvents)
        .values({ source, externalEventId, topic, payload: parsePayload(rawBody) })
        .onConflictDoNothing({ target: [webhookEvents.source, webhookEvents.externalEventId] })
        .returning({ id: webhookEvents.id })

      if (inserted.length === 0) {
        return { ok: true, duplicate: true }
      }

      await deps.enqueue(queueName, { webhookEventId: inserted[0]!.id })
      return { ok: true, duplicate: false }
    }

    fastify.post('/shopify', async (request, reply) => {
      if (!deps.shopifyWebhookSecret) {
        return reply.code(503).send({ error: 'not configured' })
      }

      const rawBody = request.body as Buffer
      const hmacHeader = headerString(request.headers['x-shopify-hmac-sha256'])
      if (!verifyShopifyWebhookHmac(rawBody, hmacHeader, deps.shopifyWebhookSecret)) {
        return reply.code(401).send({ error: 'invalid hmac' })
      }

      const externalEventId = headerString(request.headers['x-shopify-webhook-id']) ?? sha256hex(rawBody)
      const topic = headerString(request.headers['x-shopify-topic'])

      const result = await recordAndEnqueue('shopify', externalEventId, topic, rawBody, 'webhook.shopify.process')
      return reply.code(200).send(result)
    })

    fastify.post('/cj', async (request, reply) => {
      if (!deps.cjVerify || !deps.cjParse) {
        return reply.code(503).send({ error: 'not configured' })
      }

      const rawBody = request.body as Buffer
      if (!deps.cjVerify(rawBody, request.headers)) {
        return reply.code(401).send({ error: 'invalid signature' })
      }

      const parsed = deps.cjParse(rawBody)
      const externalEventId = parsed.externalEventId || sha256hex(rawBody)

      const result = await recordAndEnqueue('cj', externalEventId, parsed.type, rawBody, 'webhook.cj.process')
      return reply.code(200).send(result)
    })
  }
}
