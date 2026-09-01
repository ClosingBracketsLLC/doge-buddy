import { CATEGORIES, categoryTagValue } from '@doge-buddy/core'

/**
 * The subset of `@doge-buddy/shopify-admin`'s collection/publication ops this module needs,
 * already bound to a client (same injectable-ops pattern as `RefundOps` /
 * `ProposalShopifyOps` in `apps/ops/src/proposals/apply-shared.ts` and `apps/ops/src/index.ts` —
 * no `client` parameter here, the caller closes over it).
 */
export interface SeedCollectionsOps {
  listCollections(): Promise<{ id: string; handle: string }[]>
  collectionCreate(input: { title: string; handle: string; tagValue: string; descriptionHtml?: string }): Promise<{ id: string }>
  listPublications(): Promise<{ id: string; name: string }[]>
  // FIXTURE-ASSUMPTION (2026-07 API): publishablePublish on a Collection id — verify on the
  // first live seed-collections run. `publishablePublish` itself is LIVE-VERIFIED against the
  // 2026-07 Admin schema for the `Publishable` interface generally, but this module is the first
  // caller to invoke it with a Collection id rather than a Product id.
  publishablePublish(collectionId: string, publicationId: string): Promise<void>
}

export interface SeedCollectionsResult {
  created: string[]
  skipped: string[]
  published: number
  failures: string[]
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Idempotently creates the four category collections (`@doge-buddy/core`'s `CATEGORIES` —
 * the single category source of truth) and publishes every one of them to every publication the
 * store has, every run.
 *
 * Unlike `runSeed`'s product-publish step (which only publishes newly-created products, leaving
 * a partial-publish gap on rerun — see `run.ts`'s docstring), collection publishing is
 * deliberately unconditional: EVERY collection in `CATEGORIES`, whether it already existed or
 * was just created this run, gets `publishablePublish`-ed to every publication. Collections are
 * few (four) and cheap to re-publish, so healing a half-published collection (or one published
 * before a new sales channel/publication existed) costs nothing and needs no separate recovery
 * path — just rerun this script.
 *
 * Every create/publish call is individually contained: a failure is logged, recorded in
 * `failures`, and the run continues with the next category/publication rather than aborting
 * (same failure-containment style as `run.ts`'s `runSeed`).
 */
export async function seedCollections(ops: SeedCollectionsOps, log: (line: string) => void): Promise<SeedCollectionsResult> {
  const created: string[] = []
  const skipped: string[] = []
  const failures: string[] = []
  let published = 0

  const existing = await ops.listCollections()
  const existingByHandle = new Map(existing.map((c) => [c.handle, c.id]))
  const publications = await ops.listPublications()

  // handle -> collection id, populated from either the existing lookup or a fresh create —
  // whichever it is, the publish loop below needs an id to publish against.
  const collectionIds = new Map<string, string>()

  for (const category of CATEGORIES) {
    const existingId = existingByHandle.get(category.handle)
    if (existingId) {
      collectionIds.set(category.handle, existingId)
      skipped.push(category.handle)
      log(`skipped collection (already exists): ${category.handle}`)
      continue
    }
    try {
      const { id } = await ops.collectionCreate({
        title: category.title,
        handle: category.handle,
        tagValue: categoryTagValue(category.tag),
        descriptionHtml: category.blurb,
      })
      collectionIds.set(category.handle, id)
      created.push(category.handle)
      log(`created collection: ${category.handle}`)
    } catch (err) {
      const message = `collection ${category.handle}: ${formatError(err)}`
      failures.push(message)
      log(`FAILED collection: ${message}`)
    }
  }

  for (const category of CATEGORIES) {
    const collectionId = collectionIds.get(category.handle)
    // No id means collectionCreate failed above for this category — already recorded as a
    // failure; there is nothing to publish.
    if (!collectionId) continue
    for (const pub of publications) {
      try {
        await ops.publishablePublish(collectionId, pub.id)
        published += 1
      } catch (err) {
        const message = `collection ${category.handle}: publish to "${pub.name}" failed: ${formatError(err)}`
        failures.push(message)
        log(`FAILED publish: ${message}`)
      }
    }
  }

  return { created, skipped, published, failures }
}
