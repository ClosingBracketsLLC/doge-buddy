import { createHash } from 'node:crypto'
import { auditLog, type createDb, webhookEvents } from '@doge-buddy/db'
import { and, count, eq, gt, sql } from 'drizzle-orm'
import { verifyShopifyWebhookHmac } from '@doge-buddy/shopify-admin'
import type { FastifyPluginAsync } from 'fastify'
import type { SendOpts } from '../fulfillment/types.ts'

type Db = ReturnType<typeof createDb>['db']

export interface WebhookDeps {
  db: Db
  /**
   * Widened (beyond the two webhook-process queue names) so this same function can also be
   * handed to `webhookProcessHandler` deps, which enqueues into `fulfillment.place-order` with
   * `SendOpts` (singletonKey, retries) — see `jobs/webhook-process.ts`.
   */
  enqueue: (name: string, data: object, opts?: SendOpts) => Promise<void>
  shopifyWebhookSecret?: string
  cjVerify?: (rawBody: Buffer, headers: Record<string, string | string[] | undefined>) => boolean
  cjParse?: (rawBody: Buffer) => { externalEventId: string; type: string }
}

function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

const REDACTED_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization'])
const CJ_REJECT_CAPTURE_HOURLY_CAP = 50
const CJ_REJECT_BODY_PREVIEW_BYTES = 256

async function captureRejectedCjRequest(
  db: Db,
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer,
): Promise<void> {
  const [row] = await db
    .select({ recent: count() })
    .from(auditLog)
    .where(
      and(eq(auditLog.action, 'webhook.cj.rejected'), gt(auditLog.createdAt, sql`now() - interval '1 hour'`)),
    )
  if ((row?.recent ?? 0) >= CJ_REJECT_CAPTURE_HOURLY_CAP) return

  const sanitizedHeaders: Record<string, string | string[] | undefined> = {}
  for (const [key, value] of Object.entries(headers)) {
    sanitizedHeaders[key] = REDACTED_HEADERS.has(key.toLowerCase()) ? '[redacted]' : value
  }

  await db.insert(auditLog).values({
    actor: 'system',
    action: 'webhook.cj.rejected',
    entityType: 'webhook',
    detail: {
      headers: sanitizedHeaders,
      bodyPreview: rawBody.toString('utf8').slice(0, CJ_REJECT_BODY_PREVIEW_BYTES),
      bodySha256: sha256hex(rawBody),
      bodyLength: rawBody.length,
    },
  })
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
        // CJ's signature scheme has never been observed on a live delivery (docs/cj-api-notes.md
        // §Still unverified) — CJ's own /webhook/set registration probe 401'd here. Every
        // rejected request is therefore diagnostic evidence: capture what CJ actually sent
        // before rejecting, so the scheme can be read off the audit trail instead of guessed at.
        // Headers are kept wholesale on purpose (the unknown signature header is the thing being
        // hunted), except credential-bearing ones, which are redacted with presence preserved.
        // The body preview is bounded (a validation probe may carry a challenge token worth
        // seeing; full payloads of VERIFIED events land in webhook_events anyway), and inserts
        // are capped per hour so an unauthenticated flood can't inflate audit_log — beyond the
        // cap, requests still get their 401, just without a row.
        await captureRejectedCjRequest(deps.db, request.headers, rawBody)
        return reply.code(401).send({ error: 'invalid signature' })
      }

      // A valid signature must always result in a recorded event, even if cjParse throws
      // on malformed JSON — fall back to a deterministic id/topic so the request still
      // gets a definite 200 instead of an unhandled 500.
      let parsed: { externalEventId: string; type: string }
      try {
        parsed = deps.cjParse(rawBody)
      } catch {
        parsed = { externalEventId: sha256hex(rawBody), type: 'other' }
      }
      const externalEventId = parsed.externalEventId || sha256hex(rawBody)

      const result = await recordAndEnqueue('cj', externalEventId, parsed.type, rawBody, 'webhook.cj.process')
      return reply.code(200).send(result)
    })
  }
}
