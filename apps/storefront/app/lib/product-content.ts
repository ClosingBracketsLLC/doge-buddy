import {
  ProductHighlightsSchema,
  ProductSpecsSchema,
  SupplierReviewsSchema,
} from '@doge-buddy/core';
import type {
  ProductHighlights,
  ProductSpecs,
  SupplierReviews,
} from '@doge-buddy/core';

/**
 * Parses the dogebuddy product-content metafields (product-page-v2 spec §B1). ANY failure —
 * missing metafield, invalid JSON, JSON that fails the shared schema — yields null for that
 * field, so the section renders nothing and the page equals the pre-v2 page. Never a 500.
 */

// Structural schema type so this app doesn't need its own zod dependency — the schemas come
// from @doge-buddy/core.
type Parser<T> = {
  safeParse: (value: unknown) => {success: true; data: T} | {success: false};
};

function parseJsonMetafield<T>(
  schema: Parser<T>,
  raw: string | null | undefined,
): T | null {
  if (!raw) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

type MetafieldValue = {value: string} | null | undefined;

export interface ProductContent {
  highlights: ProductHighlights | null;
  specs: ProductSpecs | null;
  supplierReviews: SupplierReviews | null;
  whatsInBox: string | null;
}

export function parseProductContent(product: {
  highlights?: MetafieldValue;
  specs?: MetafieldValue;
  supplierReviews?: MetafieldValue;
  whatsInBox?: MetafieldValue;
}): ProductContent {
  const whatsInBox = product.whatsInBox?.value?.trim() ?? '';
  return {
    highlights: parseJsonMetafield(
      ProductHighlightsSchema,
      product.highlights?.value,
    ),
    specs: parseJsonMetafield(ProductSpecsSchema, product.specs?.value),
    supplierReviews: parseJsonMetafield(
      SupplierReviewsSchema,
      product.supplierReviews?.value,
    ),
    whatsInBox: whatsInBox ? whatsInBox.slice(0, 200) : null,
  };
}
