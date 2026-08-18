import { z } from 'zod'

const EnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    PORT: z.coerce.number().int().positive().default(3001),
    HOST: z.string().default('0.0.0.0'),
    SUPPLIER: z.enum(['mock', 'cj']).default('mock'),
    FULFILLMENT_SUPPLIER: z.enum(['mock', 'cj']).default('mock'),
    ADMIN_BASE_URL: z
      .string()
      .refine(
        (v) => {
          try {
            return ['http:', 'https:'].includes(new URL(v).protocol)
          } catch {
            return false
          }
        },
        { message: 'ADMIN_BASE_URL must be a valid http(s) URL' },
      )
      .optional(),
    SHOPIFY_SHOP_DOMAIN: z.string().optional(),
    SHOPIFY_CLIENT_ID: z.string().optional(),
    SHOPIFY_CLIENT_SECRET: z.string().optional(),
    SHOPIFY_WEBHOOK_SECRET: z.string().optional(),
    CJ_API_KEY: z.string().optional(),
    CJ_OPEN_ID: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    const shopifyVars = {
      SHOPIFY_SHOP_DOMAIN: data.SHOPIFY_SHOP_DOMAIN,
      SHOPIFY_CLIENT_ID: data.SHOPIFY_CLIENT_ID,
      SHOPIFY_CLIENT_SECRET: data.SHOPIFY_CLIENT_SECRET,
      SHOPIFY_WEBHOOK_SECRET: data.SHOPIFY_WEBHOOK_SECRET,
    }
    const shopifySetCount = Object.values(shopifyVars).filter((v) => v !== undefined).length
    if (shopifySetCount > 0 && shopifySetCount < 4) {
      const missing = Object.entries(shopifyVars)
        .filter(([, v]) => v === undefined)
        .map(([k]) => k)
      ctx.addIssue({
        code: 'custom',
        path: ['shopify'],
        message: `Shopify config requires all of SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_WEBHOOK_SECRET when any are set; missing: ${missing.join(', ')}`,
      })
    }

    const cjVars = { CJ_API_KEY: data.CJ_API_KEY, CJ_OPEN_ID: data.CJ_OPEN_ID }
    const cjSetCount = Object.values(cjVars).filter((v) => v !== undefined).length
    if (cjSetCount > 0 && cjSetCount < 2) {
      const missing = Object.entries(cjVars)
        .filter(([, v]) => v === undefined)
        .map(([k]) => k)
      ctx.addIssue({
        code: 'custom',
        path: ['cj'],
        message: `CJ config requires both CJ_API_KEY and CJ_OPEN_ID when either is set; missing: ${missing.join(', ')}`,
      })
    }

    if (data.SUPPLIER === 'cj' && cjSetCount < 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['SUPPLIER'],
        message: 'SUPPLIER=cj requires CJ_API_KEY and CJ_OPEN_ID to be set',
      })
    }

    if (data.FULFILLMENT_SUPPLIER === 'cj' && cjSetCount < 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['FULFILLMENT_SUPPLIER'],
        message: 'FULFILLMENT_SUPPLIER=cj requires CJ_API_KEY and CJ_OPEN_ID to be set',
      })
    }
  })

export interface Config {
  databaseUrl: string
  port: number
  host: string
  supplier: 'mock' | 'cj'
  fulfillmentSupplier: 'mock' | 'cj'
  adminBaseUrl?: string
  shopify?: { shopDomain: string; clientId: string; clientSecret: string; webhookSecret: string }
  cj?: { apiKey: string; openId: string }
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid environment: ${missing}`)
  }

  const data = parsed.data
  const config: Config = {
    databaseUrl: data.DATABASE_URL,
    port: data.PORT,
    host: data.HOST,
    supplier: data.SUPPLIER,
    fulfillmentSupplier: data.FULFILLMENT_SUPPLIER,
  }

  if (data.ADMIN_BASE_URL !== undefined) {
    config.adminBaseUrl = data.ADMIN_BASE_URL
  }

  if (
    data.SHOPIFY_SHOP_DOMAIN !== undefined &&
    data.SHOPIFY_CLIENT_ID !== undefined &&
    data.SHOPIFY_CLIENT_SECRET !== undefined &&
    data.SHOPIFY_WEBHOOK_SECRET !== undefined
  ) {
    config.shopify = {
      shopDomain: data.SHOPIFY_SHOP_DOMAIN,
      clientId: data.SHOPIFY_CLIENT_ID,
      clientSecret: data.SHOPIFY_CLIENT_SECRET,
      webhookSecret: data.SHOPIFY_WEBHOOK_SECRET,
    }
  }

  if (data.CJ_API_KEY !== undefined && data.CJ_OPEN_ID !== undefined) {
    config.cj = { apiKey: data.CJ_API_KEY, openId: data.CJ_OPEN_ID }
  }

  return config
}
