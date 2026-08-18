import {Link} from 'react-router';
import {Money} from '@shopify/hydrogen';
import type {
  ProductItemFragment,
  CollectionItemFragment,
  RecommendedProductFragment,
} from 'storefrontapi.generated';
import {useVariantUrl} from '~/lib/variants';
import {ProductCardImage} from '~/components/brand/ProductCardImage';

export function ProductItem({
  product,
}: {
  product:
    | CollectionItemFragment
    | ProductItemFragment
    | RecommendedProductFragment;
  loading?: 'eager' | 'lazy';
}) {
  const variantUrl = useVariantUrl(product.handle);
  return (
    <Link
      className="bg-surface-raised rounded-2xl p-3 block"
      prefetch="intent"
      to={variantUrl}
    >
      <ProductCardImage image={product.featuredImage} title={product.title} />
      <h3 className="mt-2 text-ink">{product.title}</h3>
      <p className="mt-1 font-bold text-ink">
        <Money data={product.priceRange.minVariantPrice} />
      </p>
    </Link>
  );
}
