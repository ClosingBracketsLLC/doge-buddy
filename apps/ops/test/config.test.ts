import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

describe('loadConfig', () => {
  it('parses a valid environment with defaults', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d' })
    expect(c).toEqual({ databaseUrl: 'postgres://u:p@h:5432/d', port: 3001, host: '0.0.0.0', supplier: 'mock' })
  })
  it('honors PORT override', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d', PORT: '8080' }).port).toBe(8080)
  })
  it('throws a readable error when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/)
  })

  it('defaults supplier to mock with no shopify/cj blocks', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d' })
    expect(c.supplier).toBe('mock')
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

  it('accepts SUPPLIER=cj when the full CJ pair is set', () => {
    const c = loadConfig({
      DATABASE_URL: 'postgres://u:p@h:5432/d',
      SUPPLIER: 'cj',
      CJ_API_KEY: 'k',
      CJ_OPEN_ID: 'o',
    })
    expect(c.supplier).toBe('cj')
    expect(c.cj).toEqual({ apiKey: 'k', openId: 'o' })
  })

  it('throws mentioning CJ_API_KEY when SUPPLIER=cj without the CJ pair', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://u:p@h:5432/d',
        SUPPLIER: 'cj',
      }),
    ).toThrow(/CJ_API_KEY/)
  })

  it('throws when SUPPLIER is not mock or cj', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://u:p@h:5432/d',
        SUPPLIER: 'bogus',
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
})
