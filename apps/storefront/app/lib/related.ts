import {CATEGORIES} from '@doge-buddy/core';

/** The four category-collection handles (single source: CATEGORIES). Related products come only
 *  from these — never from `frontpage` or other mixed collections. */
export const KNOWN_CATEGORY_HANDLES: ReadonlySet<string> = new Set(CATEGORIES.map((c) => c.handle));

export const RELATED_LIMIT = 4;

/**
 * "You might also like" picker (spec 2026-09-03 storefront-p1 Decision 2): the first collection
 * that is a CATEGORY collection, minus the product being viewed, capped at RELATED_LIMIT. Pure and
 * total: any missing/empty input yields [] — the section renders nothing rather than guessing.
 */
export function pickRelated<T extends {handle: string}>(
  collections: ReadonlyArray<{handle: string; products: {nodes: T[]}}> | null | undefined,
  currentHandle: string,
): T[] {
  const category = collections?.find((c) => KNOWN_CATEGORY_HANDLES.has(c.handle));
  if (!category) return [];
  return category.products.nodes.filter((p) => p.handle !== currentHandle).slice(0, RELATED_LIMIT);
}
