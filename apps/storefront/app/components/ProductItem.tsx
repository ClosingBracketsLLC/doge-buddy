import {Link} from 'react-router';
import {Money} from '@shopify/hydrogen';
import type {
  ProductItemFragment,
  CollectionItemFragment,
  RecommendedProductFragment,
  RelatedProductFragment,
} from 'storefrontapi.generated';
import {useVariantUrl} from '~/lib/variants';
import {ProductCardImage} from '~/components/brand/ProductCardImage';

export function ProductItem({
  product,
}: {
  product:
    | CollectionItemFragment
    | ProductItemFragment
    | RecommendedProductFragment
    | RelatedProductFragment;
  loading?: 'eager' | 'lazy';
}) {
  const variantUrl = useVariantUrl(product.handle);
  return (
    <Link
      className="block rounded-2xl border-2 border-ink bg-surface-raised p-3 transition-transform hover:-translate-y-1 hover:shadow-[4px_4px_0_var(--color-ink)] motion-reduce:transition-none"
      prefetch="intent"
      to={variantUrl}
    >
      <ProductCardImage image={product.featuredImage} title={product.title} />
      <h3 className="mt-2 text-ink">{product.title}</h3>
      <p className="mt-1.5 inline-block rounded border-2 border-ink bg-badge px-2 py-0.5 font-display text-ink">
        <Money data={product.priceRange.minVariantPrice} />
      </p>
    </Link>
  );
}
