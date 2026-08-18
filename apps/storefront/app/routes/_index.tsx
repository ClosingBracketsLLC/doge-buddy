import {Await, useLoaderData, Link} from 'react-router';
import type {Route} from './+types/_index';
import {Suspense} from 'react';
import {Money} from '@shopify/hydrogen';
import type {
  RecommendedProductFragment,
  RecommendedProductsQuery,
} from 'storefrontapi.generated';
import {Hero} from '~/components/brand/Hero';
import {ProductCardImage} from '~/components/brand/ProductCardImage';
import {TrustStrip} from '~/components/brand/TrustStrip';
import {useVariantUrl} from '~/lib/variants';

export const meta: Route.MetaFunction = () => {
  return [{title: 'Doge Buddy — Great gear for your best friend'}];
};

export async function loader(args: Route.LoaderArgs) {
  // Start fetching non-critical data without blocking time to first byte
  const deferredData = loadDeferredData(args);

  // Await the critical data required to render initial state of the page
  const criticalData = await loadCriticalData(args);

  return {...deferredData, ...criticalData};
}

/**
 * Load data necessary for rendering content above the fold. This is the critical data
 * needed to render the page. If it's unavailable, the whole page should 400 or 500 error.
 */
async function loadCriticalData({context}: Route.LoaderArgs) {
  const [{collections}] = await Promise.all([
    context.storefront.query(FEATURED_COLLECTION_QUERY),
    // Add other queries here, so that they are loaded in parallel
  ]);

  return {
    isShopLinked: Boolean(context.env.PUBLIC_STORE_DOMAIN),
    featuredCollection: collections.nodes[0],
  };
}

/**
 * Load data for rendering content below the fold. This data is deferred and will be
 * fetched after the initial page load. If it's unavailable, the page should still 200.
 * Make sure to not throw any errors here, as it will cause the page to 500.
 */
function loadDeferredData({context}: Route.LoaderArgs) {
  const recommendedProducts = context.storefront
    .query(RECOMMENDED_PRODUCTS_QUERY)
    .catch((error: Error) => {
      // Log query errors, but don't throw them so the page can still render
      console.error(error);
      return null;
    });

  return {
    recommendedProducts,
  };
}

export default function Homepage() {
  const data = useLoaderData<typeof loader>();
  return (
    <div className="home mx-auto max-w-5xl px-4 py-8 md:py-12">
      <Hero />
      <RecommendedProducts products={data.recommendedProducts} />
      <div className="mt-12">
        <TrustStrip />
      </div>
    </div>
  );
}

function RecommendedProducts({
  products,
}: {
  products: Promise<RecommendedProductsQuery | null>;
}) {
  return (
    <section className="mt-12" aria-labelledby="recommended-products">
      <h2
        id="recommended-products"
        className="font-display font-bold text-2xl text-ink"
      >
        Featured products
      </h2>
      <Suspense fallback={<div className="mt-4 text-info">Loading...</div>}>
        <Await resolve={products}>
          {(response) => (
            <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
              {response
                ? response.products.nodes.map((product) => (
                    <RecommendedProductCard key={product.id} product={product} />
                  ))
                : null}
            </div>
          )}
        </Await>
      </Suspense>
    </section>
  );
}

function RecommendedProductCard({
  product,
}: {
  product: RecommendedProductFragment;
}) {
  const variantUrl = useVariantUrl(product.handle);
  return (
    <Link
      to={variantUrl}
      prefetch="intent"
      className="bg-surface-raised rounded-2xl p-3 block"
    >
      <ProductCardImage image={product.featuredImage} title={product.title} />
      <h3 className="mt-2 text-ink">{product.title}</h3>
      <p className="mt-1 font-bold text-ink">
        <Money data={product.priceRange.minVariantPrice} />
      </p>
    </Link>
  );
}

const FEATURED_COLLECTION_QUERY = `#graphql
  fragment FeaturedCollection on Collection {
    id
    title
    image {
      id
      url
      altText
      width
      height
    }
    handle
  }
  query FeaturedCollection($country: CountryCode, $language: LanguageCode)
    @inContext(country: $country, language: $language) {
    collections(first: 1, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        ...FeaturedCollection
      }
    }
  }
` as const;

const RECOMMENDED_PRODUCTS_QUERY = `#graphql
  fragment RecommendedProduct on Product {
    id
    title
    handle
    priceRange {
      minVariantPrice {
        amount
        currencyCode
      }
    }
    featuredImage {
      id
      url
      altText
      width
      height
    }
  }
  query RecommendedProducts ($country: CountryCode, $language: LanguageCode)
    @inContext(country: $country, language: $language) {
    products(first: 4, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        ...RecommendedProduct
      }
    }
  }
` as const;
