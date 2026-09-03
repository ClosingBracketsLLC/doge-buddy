import {Await, useLoaderData} from 'react-router';
import type {Route} from './+types/_index';
import {Suspense} from 'react';
import type {NewArrivalsQuery} from 'storefrontapi.generated';
import {Hero} from '~/components/brand/Hero';
import {ProductItem} from '~/components/ProductItem';
import {RibbonHeading} from '~/components/brand/RibbonHeading';
import {ValueProps} from '~/components/brand/ValueProps';
import {CategoryTiles} from '~/components/brand/CategoryTiles';

export const meta: Route.MetaFunction = () => {
  return [
    {title: 'Doge Buddy — Great gear for your best friend'},
    {
      name: 'description',
      content:
        'Toys, walks, beds, and grooming gear for happy dogs, shipped fast from US warehouses with 3–7 day delivery.',
    },
  ];
};

export async function loader(args: Route.LoaderArgs) {
  // All home data is deferred (spec Decision 7) — the old critical-path FEATURED_COLLECTION_QUERY
  // was never rendered and is gone.
  return loadDeferredData(args);
}

/**
 * Load data for rendering content below the fold. This data is deferred and will be
 * fetched after the initial page load. If it's unavailable, the page should still 200.
 * Make sure to not throw any errors here, as it will cause the page to 500.
 */
function loadDeferredData({context}: Route.LoaderArgs) {
  const recommendedProducts = context.storefront
    .query(NEW_ARRIVALS_QUERY)
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
      <ValueProps />
      <CategoryTiles />
      <NewArrivals products={data.recommendedProducts} />
    </div>
  );
}

function NewArrivals({
  products,
}: {
  products: Promise<NewArrivalsQuery | null>;
}) {
  return (
    <section className="mt-12" aria-labelledby="new-arrivals">
      <div id="new-arrivals">
        <RibbonHeading>New arrivals</RibbonHeading>
      </div>
      <Suspense fallback={<div className="mt-4 text-info">Loading...</div>}>
        <Await resolve={products}>
          {(response) => (
            <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
              {response
                ? response.products.nodes.map((product) => (
                    <ProductItem key={product.id} product={product} />
                  ))
                : null}
            </div>
          )}
        </Await>
      </Suspense>
    </section>
  );
}

const NEW_ARRIVALS_QUERY = `#graphql
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
  query NewArrivals ($country: CountryCode, $language: LanguageCode)
    @inContext(country: $country, language: $language) {
    products(first: 8, sortKey: CREATED_AT, reverse: true) {
      nodes {
        ...RecommendedProduct
      }
    }
  }
` as const;
