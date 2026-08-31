import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

describe('loadConfig', () => {
  it('parses a valid environment with defaults', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d' })
    expect(c).toEqual({
      databaseUrl: 'postgres://u:p@h:5432/d',
      port: 3001,
      host: '0.0.0.0',
      fulfillmentSupplier: 'mock',
    })
  })
  it('honors PORT override', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d', PORT: '8080' }).port).toBe(8080)
  })
  it('throws a readable error when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/)
  })

  it('defaults fulfillmentSupplier to mock with no shopify/cj blocks', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d' })
    expect(c.fulfillmentSupplier).toBe('mock')
    expect(c.shopify).toBeUndefined()
    expect(c.cj).toBeUndefined()
  })

  it('assembles the shopify block when all 4 SHOPIFY_* vars are set', () => {
    const c = loadConfig({
      DATABASE_URL: 'postgres://u:p@h:5432/d',
      SHOPIFY_SHOP_DOMAIN: 'shop.myshopify.com',
      SHOPIFY_CLIENT_ID: 'client-id',
      SHOPIFY_CLIENT_SECRET: 'client-secret',
      SHOPIFY_WEBHOOK_SECRET: 'webhook-secret',
    })
    expect(c.shopify).toEqual({
      shopDomain: 'shop.myshopify.com',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      webhookSecret: 'webhook-secret',
    })
  })

  it('throws naming the missing var when only some SHOPIFY_* vars are set', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://u:p@h:5432/d',
        SHOPIFY_SHOP_DOMAIN: 'shop.myshopify.com',
      }),
    ).toThrow(/SHOPIFY_CLIENT_ID/)
  })

  it('assembles the cj block when both CJ_API_KEY and CJ_OPEN_ID are set', () => {
    const c = loadConfig({
      DATABASE_URL: 'postgres://u:p@h:5432/d',
      CJ_API_KEY: 'api-key',
      CJ_OPEN_ID: 'open-id',
    })
    expect(c.cj).toEqual({ apiKey: 'api-key', openId: 'open-id' })
  })

  it('ignores the retired SUPPLIER env var entirely (superseded by FULFILLMENT_SUPPLIER)', () => {
    // SUPPLIER used to select the adapter before FULFILLMENT_SUPPLIER replaced it; it must now
    // neither validate nor surface — a leftover SUPPLIER=cj in an old .env with no CJ creds
    // must not fail startup.
    const c = loadConfig({
      DATABASE_URL: 'postgres://u:p@h:5432/d',
      SUPPLIER: 'cj',
    })
    expect('supplier' in c).toBe(false)
  })

  it('accepts FULFILLMENT_SUPPLIER=cj when the full CJ pair is set', () => {
    const c = loadConfig({
      DATABASE_URL: 'postgres://u:p@h:5432/d',
      FULFILLMENT_SUPPLIER: 'cj',
      CJ_API_KEY: 'k',
      CJ_OPEN_ID: 'o',
    })
    expect(c.fulfillmentSupplier).toBe('cj')
    expect(c.cj).toEqual({ apiKey: 'k', openId: 'o' })
  })

  it('throws mentioning CJ_API_KEY when FULFILLMENT_SUPPLIER=cj without the CJ pair', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://u:p@h:5432/d',
        FULFILLMENT_SUPPLIER: 'cj',
      }),
    ).toThrow(/CJ_API_KEY/)
  })

  it('throws when FULFILLMENT_SUPPLIER is not mock or cj', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://u:p@h:5432/d',
        FULFILLMENT_SUPPLIER: 'bogus',
      }),
    ).toThrow()
  })

  it('throws when ADMIN_BASE_URL is not a valid URL', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://u:p@h:5432/d',
        ADMIN_BASE_URL: 'notaurl',
      }),
    ).toThrow()
  })

  it('throws when ADMIN_BASE_URL is a non-http(s) URL', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://u:p@h:5432/d',
        ADMIN_BASE_URL: 'ftp://admin.example.com',
      }),
    ).toThrow(/ADMIN_BASE_URL/)
  })

  it('accepts a valid http(s) ADMIN_BASE_URL', () => {
    const c = loadConfig({
      DATABASE_URL: 'postgres://u:p@h:5432/d',
      ADMIN_BASE_URL: 'https://admin.example.com',
    })
    expect(c.adminBaseUrl).toBe('https://admin.example.com')
  })

  it('assembles the telegram block when both TELEGRAM_* vars are set', () => {
    const c = loadConfig({
      DATABASE_URL: 'postgres://u:p@h:5432/d',
      TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '42',
    })
    expect(c.telegram).toEqual({ botToken: 'tok', chatId: '42' })
  })

  it('throws naming the missing var when only one TELEGRAM_* var is set', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d', TELEGRAM_BOT_TOKEN: 'tok' }),
    ).toThrow(/TELEGRAM_CHAT_ID/)
  })

  it('anthropic block present iff ANTHROPIC_API_KEY set', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d' }).anthropic).toBeUndefined()
    expect(loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d', ANTHROPIC_API_KEY: 'sk-ant-x' }).anthropic).toEqual({ apiKey: 'sk-ant-x' })
  })

  it('serpapi block present iff SERPAPI_KEY set', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d' }).serpapi).toBeUndefined()
    expect(loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d', SERPAPI_KEY: 'serp-x' }).serpapi).toEqual({ apiKey: 'serp-x' })
  })

  it('assembles the gmail block when the full quartet is set, unescaping \\n in the key', () => {
    const c = loadConfig({
      DATABASE_URL: 'postgres://u:p@h:5432/d',
      GMAIL_SERVICE_ACCOUNT_EMAIL: 'sa@project.iam.gserviceaccount.com',
      GMAIL_SERVICE_ACCOUNT_KEY: '-----BEGIN PRIVATE KEY-----\\nabc123\\n-----END PRIVATE KEY-----\\n',
      GMAIL_IMPERSONATE: 'owner@example.com',
      SUPPORT_ADDRESS: 'support@example.com',
    })
    expect(c.gmail).toBeDefined()
    expect(c.gmail!.saEmail).toBe('sa@project.iam.gserviceaccount.com')
    expect(c.gmail!.saKey).toContain('\n')
    expect(c.gmail!.saKey).not.toContain('\\n')
    expect(c.gmail!.impersonate).toBe('owner@example.com')
    expect(c.gmail!.supportAddress).toBe('support@example.com')
  })

  it('leaves gmail undefined when none of the quartet vars are set', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d' })
    expect(c.gmail).toBeUndefined()
  })

  it('throws naming the three missing vars when only GMAIL_SERVICE_ACCOUNT_EMAIL is set', () => {
    let message = ''
    try {
      loadConfig({
        DATABASE_URL: 'postgres://u:p@h:5432/d',
        GMAIL_SERVICE_ACCOUNT_EMAIL: 'sa@project.iam.gserviceaccount.com',
      })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('GMAIL_SERVICE_ACCOUNT_KEY')
    expect(message).toContain('GMAIL_IMPERSONATE')
    expect(message).toContain('SUPPORT_ADDRESS')
  })

  it('TURNSTILE_SECRET_KEY → config.turnstile; absent → undefined', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d' }).turnstile).toBeUndefined()
    expect(
      loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d', TURNSTILE_SECRET_KEY: '0xsecret' }).turnstile,
    ).toEqual({ secretKey: '0xsecret' })
  })
})
