import { createHmac, randomUUID } from 'node:crypto'

/**
 * One-command manual proof of the webhook dedup path: signs a sample `orders/paid` payload and
 * POSTs it twice, with the same `x-shopify-webhook-id`, to a locally running ops instance.
 * Expects the first response to report `duplicate: false` and the second `duplicate: true` —
 * i.e. the same delivery retried (as Shopify does) is recorded once and enqueued once.
 *
 * Requires SHOPIFY_WEBHOOK_SECRET (must match the running ops instance's secret) and a running
 * `pnpm --filter @doge-buddy/ops dev` (or `start`) on PORT (default 3001).
 */

const secret = process.env.SHOPIFY_WEBHOOK_SECRET
if (!secret) {
  console.error('replay-webhook: SHOPIFY_WEBHOOK_SECRET is required')
  process.exit(1)
}

const port = process.env.PORT ?? '3001'
const url = `http://localhost:${port}/webhooks/shopify`

// Shopify's canonical orders/paid sample order id/total, written as a literal JSON string (not
// built from a JS object) so the id — which exceeds Number.MAX_SAFE_INTEGER — round-trips
// exactly instead of being silently rounded by float precision.
const payload = '{"id":820982911946154500,"test":true,"total_price":"11.50"}'
const hmac = createHmac('sha256', secret).update(payload).digest('base64')
const webhookId = randomUUID()

const headers = {
  'content-type': 'application/json',
  'x-shopify-hmac-sha256': hmac,
  'x-shopify-webhook-id': webhookId,
  'x-shopify-topic': 'orders/paid',
}

interface Sent {
  status: number
  body: unknown
}

async function send(): Promise<Sent> {
  const res = await fetch(url, { method: 'POST', headers, body: payload })
  const body = await res.json().catch(() => undefined)
  return { status: res.status, body }
}

console.log(`replay-webhook: POSTing to ${url} twice with x-shopify-webhook-id=${webhookId}`)

let first: Sent
let second: Sent
try {
  first = await send()
  console.log(`First response: ${first.status} ${JSON.stringify(first.body)}`)

  second = await send()
  console.log(`Second response: ${second.status} ${JSON.stringify(second.body)}`)
} catch (err) {
  console.error(
    `replay-webhook: could not reach ${url} — is ops running? (${err instanceof Error ? err.message : String(err)})`,
  )
  process.exit(1)
}

const firstDuplicate = (first.body as { duplicate?: unknown } | undefined)?.duplicate
const secondDuplicate = (second.body as { duplicate?: unknown } | undefined)?.duplicate

if (firstDuplicate === false && secondDuplicate === true) {
  console.log('REPLAY OK: first duplicate=false, second duplicate=true')
  process.exit(0)
} else {
  console.error(
    `REPLAY FAILED: expected first duplicate=false and second duplicate=true; got first=${String(firstDuplicate)}, second=${String(secondDuplicate)}`,
  )
  process.exit(1)
}
