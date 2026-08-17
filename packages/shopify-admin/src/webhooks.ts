import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verifies a Shopify webhook's `X-Shopify-Hmac-SHA256` header against the raw request body.
 * Uses a constant-time comparison and never throws — any malformed input (missing header,
 * non-base64 garbage, wrong length) simply yields `false`.
 */
export function verifyShopifyWebhookHmac(rawBody: Buffer, hmacHeader: string | undefined, secret: string): boolean {
  if (!hmacHeader) return false

  try {
    const expected = createHmac('sha256', secret).update(rawBody).digest()
    const provided = Buffer.from(hmacHeader, 'base64')
    if (provided.length !== expected.length) return false
    return timingSafeEqual(provided, expected)
  } catch {
    return false
  }
}
