import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyShopifyWebhookHmac } from '@doge-buddy/shopify-admin'

describe('verifyShopifyWebhookHmac', () => {
  const secret = 'shhh'
  const body = Buffer.from('{"id":123}')
  const good = createHmac('sha256', secret).update(body).digest('base64')
  it('accepts a valid signature', () => expect(verifyShopifyWebhookHmac(body, good, secret)).toBe(true))
  it('rejects a tampered body', () => expect(verifyShopifyWebhookHmac(Buffer.from('{"id":124}'), good, secret)).toBe(false))
  it('rejects missing/garbage headers without throwing', () => {
    expect(verifyShopifyWebhookHmac(body, undefined, secret)).toBe(false)
    expect(verifyShopifyWebhookHmac(body, 'not-base64-of-right-length', secret)).toBe(false)
  })
})
