import { CATEGORIES, CATEGORY_TAGS, categoryTagValue } from '@doge-buddy/core'
import { describe, expect, it } from 'vitest'
import { seedCollections, type SeedCollectionsOps } from '../src/seed/collections.ts'
import { COLLECTIONS, SAMPLE_PRODUCTS } from '../src/seed/sample-data.ts'

interface CollectionCreateCall {
  title: string
  handle: string
  tagValue: string
  descriptionHtml?: string
}

interface PublishCall {
  collectionId: string
  publicationId: string
}

const PUBLICATIONS = [
  { id: 'gid://shopify/Publication/1', name: 'Online Store' },
  { id: 'gid://shopify/Publication/2', name: 'Hydrogen' },
]

/**
 * In-memory fake for `SeedCollectionsOps` — no client, no fetch, just plain call-recording
 * objects, per the brief's "in-memory fake" step 1. `existingHandles` seeds `listCollections`;
 * `failCreateHandle` makes exactly one `collectionCreate` throw so failure-containment can be
 * exercised without touching the other three.
 */
function makeOps(opts: { existingHandles?: string[]; failCreateHandle?: string } = {}) {
  const existingHandles = new Set(opts.existingHandles ?? [])
  const createCalls: CollectionCreateCall[] = []
  const publishCalls: PublishCall[] = []
  let nextId = 0

  const ops: SeedCollectionsOps = {
    listCollections: async () =>
      CATEGORIES.filter((c) => existingHandles.has(c.handle)).map((c) => ({
        id: `gid://shopify/Collection/existing-${c.handle}`,
        handle: c.handle,
      })),
    collectionCreate: async (input) => {
      createCalls.push(input)
      if (input.handle === opts.failCreateHandle) {
        throw new Error(`collectionCreate failed for ${input.handle}`)
      }
      nextId += 1
      return { id: `gid://shopify/Collection/new-${nextId}` }
    },
    listPublications: async () => PUBLICATIONS,
    publishablePublish: async (collectionId, publicationId) => {
      publishCalls.push({ collectionId, publicationId })
    },
  }

  return { ops, createCalls, publishCalls }
}

describe('seedCollections', () => {
  it('creates all four collections in CATEGORIES order, then publishes each to every publication', async () => {
    const { ops, createCalls, publishCalls } = makeOps()
    const logLines: string[] = []

    const result = await seedCollections(ops, (line) => logLines.push(line))

    expect(createCalls).toHaveLength(4)
    expect(createCalls.map((c) => c.handle)).toEqual(CATEGORIES.map((c) => c.handle))
    for (const [i, call] of createCalls.entries()) {
      expect(call).toEqual({
        title: CATEGORIES[i]!.title,
        handle: CATEGORIES[i]!.handle,
        tagValue: categoryTagValue(CATEGORIES[i]!.tag),
        descriptionHtml: CATEGORIES[i]!.blurb,
      })
    }

    expect(publishCalls).toHaveLength(8)
    expect(result.created).toEqual(CATEGORIES.map((c) => c.handle))
    expect(result.skipped).toEqual([])
    expect(result.published).toBe(8)
    expect(result.failures).toEqual([])
    expect(logLines.some((l) => l.includes('created collection'))).toBe(true)
  })

  it('rerunning against a store with all four collections already present creates nothing but still republishes (idempotent healing)', async () => {
    const { ops, createCalls, publishCalls } = makeOps({ existingHandles: CATEGORIES.map((c) => c.handle) })

    const result = await seedCollections(ops, () => {})

    expect(createCalls).toHaveLength(0)
    expect(publishCalls).toHaveLength(8)
    expect(result.created).toEqual([])
    expect(result.skipped).toEqual(CATEGORIES.map((c) => c.handle))
    expect(result.published).toBe(8)
    expect(result.failures).toEqual([])
  })

  it('continues past one failed collectionCreate, creating and publishing the other three', async () => {
    const failHandle = CATEGORIES[1]!.handle
    const { ops, createCalls, publishCalls } = makeOps({ failCreateHandle: failHandle })
    const logLines: string[] = []

    const result = await seedCollections(ops, (line) => logLines.push(line))

    expect(createCalls).toHaveLength(4) // attempted for all four, not short-circuited
    expect(result.created).toEqual(CATEGORIES.filter((c) => c.handle !== failHandle).map((c) => c.handle))
    expect(result.skipped).toEqual([])
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toContain(failHandle)
    expect(publishCalls).toHaveLength(6) // 3 surviving collections * 2 publications
    expect(result.published).toBe(6)
    expect(logLines.some((l) => l.includes('FAILED collection') && l.includes(failHandle))).toBe(true)
  })

  it('sample-data COLLECTIONS/SAMPLE_PRODUCTS stay aligned with CATEGORIES and CATEGORY_TAGS', () => {
    expect(COLLECTIONS.map((c) => c.handle).sort()).toEqual(CATEGORIES.map((c) => c.handle).slice().sort())
    for (const product of SAMPLE_PRODUCTS) {
      expect(CATEGORY_TAGS).toContain(product.categoryTag)
    }
  })
})
