import type {RelatedProductFragment} from 'storefrontapi.generated';
import {ProductItem} from '~/components/ProductItem';
import {RibbonHeading} from '~/components/brand/RibbonHeading';

/** "You might also like" (spec Decision 3): pure presentational — the route resolves the deferred
 *  list; null (failed/absent) and [] both render NOTHING. */
export function RelatedProducts({products}: {products: RelatedProductFragment[] | null}) {
  if (!products || products.length === 0) return null;
  return (
    <section className="mt-12" aria-labelledby="related-products">
      <div id="related-products">
        <RibbonHeading>You might also like</RibbonHeading>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        {products.map((product) => (
          <ProductItem key={product.id} product={product} />
        ))}
      </div>
    </section>
  );
}
