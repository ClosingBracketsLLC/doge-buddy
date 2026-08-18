import { ShopifyAdminClient, ShopifyTokenManager } from '@doge-buddy/shopify-admin'
import { describe, expect, it } from 'vitest'
import { runSeed } from '../src/seed/run.ts'
import { COLLECTIONS, METAFIELD_DEFINITIONS } from '../src/seed/sample-data.ts'

const tokenOk = () => new Response(JSON.stringify({ access_token: 'tok', expires_in: 86399 }), { status: 200 })
const gql = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })

interface GraphqlCall {
  query: string
  variables?: Record<string, unknown>
}

// Same fake-fetch harness pattern as packages/shopify-admin/test/operations.test.ts and
// apps/ops/test/shopify-webhook-audit.test.ts: branch per-call on the operation name embedded in
// the query text, since a single seed run makes many distinct graphql calls.
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

describe('runSeed', () => {
  it('scopes skip counts/logs to the seed’s own definitions and collections, ignoring unrelated store content', async () => {
    const logLines: string[] = []
    const { client, calls } = makeClient((call) => {
      if (call.query.includes('ListMetafieldDefinitions')) {
        return gql({
          metafieldDefinitions: {
            nodes: [
              ...METAFIELD_DEFINITIONS.map((d, i) => ({ id: `gid://shopify/MetafieldDefinition/${i}`, key: d.key })),
              // unrelated definition in the same namespace — must not count as a seed skip
              { id: 'gid://shopify/MetafieldDefinition/999', key: 'unrelated_field' },
            ],
          },
        })
      }
      if (call.query.includes('ListCollections')) {
        return gql({
          collections: {
            nodes: [
              ...COLLECTIONS.map((c, i) => ({ id: `gid://shopify/Collection/${i}`, handle: c.handle })),
              // pre-existing store collection unrelated to seeding — must not count as a seed skip
              { id: 'gid://shopify/Collection/999', handle: 'featured-products' },
            ],
          },
        })
      }
      if (call.query.includes('ListPublications')) {
        return gql({ publications: { nodes: [] } })
      }
      if (call.query.includes('FindProductByHandle')) {
        return gql({ products: { nodes: [{ id: 'gid://shopify/Product/1' }] } })
      }
      throw new Error(`unexpected call: ${call.query}`)
    })

    const result = await runSeed(client, (line) => logLines.push(line))

    expect(result.skipped).toEqual({ definitions: 3, collections: 4, products: 10 })
    expect(result.created).toEqual({ definitions: 0, collections: 0, products: 0 })
    expect(result.failures).toEqual([])

    expect(logLines.some((l) => l.includes('unrelated_field'))).toBe(false)
    expect(logLines.some((l) => l.includes('featured-products'))).toBe(false)
    expect(calls.some((c) => c.query.includes('MetafieldDefinitionCreate'))).toBe(false)
    expect(calls.some((c) => c.query.includes('CollectionCreate'))).toBe(false)
  })

  it('continues past a failed product create and a failed publish, surfacing both failures while still creating/publishing the rest', async () => {
    const logLines: string[] = []
    const missingHandles = ['sample-tug-of-war-rope-toy', 'sample-squeaky-plush-fox']

    const { client, calls } = makeClient((call) => {
      if (call.query.includes('ListMetafieldDefinitions')) {
        return gql({
          metafieldDefinitions: { nodes: METAFIELD_DEFINITIONS.map((d, i) => ({ id: `gid://shopify/MetafieldDefinition/${i}`, key: d.key })) },
        })
      }
      if (call.query.includes('ListCollections')) {
        return gql({ collections: { nodes: COLLECTIONS.map((c, i) => ({ id: `gid://shopify/Collection/${i}`, handle: c.handle })) } })
      }
      if (call.query.includes('ListPublications')) {
        return gql({
          publications: {
            nodes: [
              { id: 'gid://shopify/Publication/1', name: 'Online Store' },
              { id: 'gid://shopify/Publication/2', name: 'Hydrogen' },
            ],
          },
        })
      }
      if (call.query.includes('FindProductByHandle')) {
        const query = call.variables?.query as string
        const isMissing = missingHandles.some((h) => query.includes(h))
        return gql({ products: { nodes: isMissing ? [] : [{ id: 'gid://shopify/Product/existing' }] } })
      }
      if (call.query.includes('mutation ProductSet')) {
        const input = call.variables?.input as { handle: string }
        if (input.handle === 'sample-tug-of-war-rope-toy') {
          return gql({ productSet: { product: null, userErrors: [{ message: 'Title already taken' }] } })
        }
        return gql({
          productSet: {
            product: { id: 'gid://shopify/Product/500', variants: { nodes: [{ id: 'gid://shopify/ProductVariant/500', sku: null }] } },
            userErrors: [],
          },
        })
      }
      if (call.query.includes('PublishablePublish')) {
        const input = call.variables?.input as { publicationId: string }[]
        if (input[0]!.publicationId === 'gid://shopify/Publication/1') {
          return gql({ publishablePublish: { userErrors: [{ message: 'not allowed' }] } })
        }
        return gql({ publishablePublish: { userErrors: [] } })
      }
      throw new Error(`unexpected call: ${call.query}`)
    })

    const result = await runSeed(client, (line) => logLines.push(line))

    // (iii) the run doesn't throw on partial failure — the full summary is still returned.
    expect(result.created).toEqual({ definitions: 0, collections: 0, products: 1 })
    expect(result.skipped).toEqual({ definitions: 3, collections: 4, products: 8 })

    // (ii) both the failed create and the failed publish are surfaced, not swallowed.
    expect(result.failures).toHaveLength(2)
    expect(result.failures[0]).toContain('sample-tug-of-war-rope-toy')
    expect(result.failures[1]).toContain('sample-squeaky-plush-fox')
    expect(result.failures[1]).toContain('Online Store')

    // both publications were attempted for the surviving product despite the first one failing.
    const publishCalls = calls.filter((c) => c.query.includes('PublishablePublish'))
    expect(publishCalls).toHaveLength(2)

    expect(logLines.some((l) => l.includes('FAILED product') && l.includes('sample-tug-of-war-rope-toy'))).toBe(true)
    expect(logLines.some((l) => l.includes('FAILED publish') && l.includes('sample-squeaky-plush-fox'))).toBe(true)
    expect(logLines.some((l) => l.includes('created product: sample-squeaky-plush-fox'))).toBe(true)
  })
})
