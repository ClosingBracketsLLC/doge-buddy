import {redirect, useLoaderData, Await} from 'react-router';
import {Suspense} from 'react';
import type {Route} from './+types/products.$handle';
import {
  getSelectedProductOptions,
  Analytics,
  useOptimisticVariant,
  getProductOptions,
  getAdjacentAndFirstAvailableVariants,
  useSelectedOptionInUrlParam,
} from '@shopify/hydrogen';
import {ProductPrice} from '~/components/ProductPrice';
import {ProductForm} from '~/components/ProductForm';
import {redirectIfHandleIsLocalized} from '~/lib/redirect';
import {DeliveryBadge} from '~/components/brand/DeliveryBadge';
import {productJsonLd} from '~/lib/seo';
import {parseProductContent} from '~/lib/product-content';
import {ProductGallery} from '~/components/product/ProductGallery';
import {TrustBadges} from '~/components/product/TrustBadges';
import {ProductHighlights} from '~/components/product/ProductHighlights';
import {ProductSpecs} from '~/components/product/ProductSpecs';
import {WhatsInBox} from '~/components/product/WhatsInBox';
import {ShippingReturnsAccordion} from '~/components/product/ShippingReturnsAccordion';
import {SupplierReviews} from '~/components/product/SupplierReviews';
import {RelatedProducts} from '~/components/product/RelatedProducts';
import {pickRelated} from '~/lib/related';

export const meta: Route.MetaFunction = ({data}) => {
  if (!data?.product) return [];

  const {product, origin} = data;
  const variant = product.selectedOrFirstAvailableVariant;

  return [
    {title: `${product.title} — Doge Buddy`},
    {
      name: 'description',
      content: product.seo?.description ?? product.description,
    },
    {
      rel: 'canonical',
      href: `/products/${product.handle}`,
    },
    ...(variant
      ? [
          {
            'script:ld+json': productJsonLd({
              name: product.title,
              description: product.description,
              url: `${origin}/products/${product.handle}`,
              imageUrl: variant.image?.url,
              price: variant.price.amount,
              currencyCode: variant.price.currencyCode,
              available: variant.availableForSale,
            }),
          },
        ]
      : []),
  ];
};

export async function loader(args: Route.LoaderArgs) {
  // Start fetching non-critical data without blocking time to first byte
  const deferredData = loadDeferredData(args);

  // Await the critical data required to render initial state of the page
  const criticalData = await loadCriticalData(args);

  return {
    ...deferredData,
    ...criticalData,
    origin: new URL(args.request.url).origin,
  };
}

/**
 * Load data necessary for rendering content above the fold. This is the critical data
 * needed to render the page. If it's unavailable, the whole page should 400 or 500 error.
 */
async function loadCriticalData({context, params, request}: Route.LoaderArgs) {
  const {handle} = params;
  const {storefront} = context;

  if (!handle) {
    throw new Error('Expected product handle to be defined');
  }

  const [{product}] = await Promise.all([
    storefront.query(PRODUCT_QUERY, {
      variables: {handle, selectedOptions: getSelectedProductOptions(request)},
    }),
    // Add other queries here, so that they are loaded in parallel
  ]);

  if (!product?.id) {
    throw new Response(null, {status: 404});
  }

  // The API handle might be localized, so redirect to the localized handle
  redirectIfHandleIsLocalized(request, {handle, data: product});

  return {
    product,
    content: parseProductContent(product),
  };
}

/**
 * Load data for rendering content below the fold. This data is deferred and will be
 * fetched after the initial page load. If it's unavailable, the page should still 200.
 * Make sure to not throw any errors here, as it will cause the page to 500.
 */
function loadDeferredData({context, params}: Route.LoaderArgs) {
  // Related products (spec 2026-09-03 storefront-p1 Decision 2): deferred, never blocks TTFB,
  // never 500s — a failed query or an uncategorized product resolves to null and the section
  // renders nothing.
  const relatedProducts = params.handle
    ? context.storefront
        .query(RELATED_PRODUCTS_QUERY, {
          variables: {handle: params.handle},
          cache: context.storefront.CacheLong(),
        })
        .then((result) => pickRelated(result.product?.collections?.nodes, params.handle!))
        .catch((error: Error) => {
          console.error(error);
          return null;
        })
    : Promise.resolve(null);

  return {relatedProducts};
}

export default function Product() {
  const {product, content, relatedProducts} = useLoaderData<typeof loader>();

  // Optimistically selects a variant with given available variant information
  const selectedVariant = useOptimisticVariant(
    product.selectedOrFirstAvailableVariant,
    getAdjacentAndFirstAvailableVariants(product),
  );

  // Sets the search param to the selected variant without navigation
  // only when no search params are set in the url
  useSelectedOptionInUrlParam(selectedVariant.selectedOptions);

  // Get the product options array
  const productOptions = getProductOptions({
    ...product,
    selectedOrFirstAvailableVariant: selectedVariant,
  });

  const {title, descriptionHtml} = product;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="grid gap-8 md:grid-cols-2">
        <ProductGallery
          media={product.media?.nodes ?? []}
          variantImage={selectedVariant?.image}
        />
        <div>
          <h1 className="font-display text-4xl text-ink">{title}</h1>
          <div className="mt-3 inline-block rounded border-2 border-ink bg-badge px-3 py-1 font-display text-xl text-ink">
            <ProductPrice
              price={selectedVariant?.price}
              compareAtPrice={selectedVariant?.compareAtPrice}
            />
          </div>
          <div className="mt-4">
            <DeliveryBadge
              shipsFrom={product.shipsFrom?.value}
              minDays={product.deliveryMinDays?.value}
              maxDays={product.deliveryMaxDays?.value}
            />
          </div>
          <div className="mt-6">
            <ProductForm
              productOptions={productOptions}
              selectedVariant={selectedVariant}
            />
          </div>
          <TrustBadges />
          <ProductHighlights highlights={content.highlights} />
          <h2 className="mt-10 font-display text-2xl text-ink">Description</h2>
          <div
            className="mt-2 leading-relaxed text-ink"
            dangerouslySetInnerHTML={{__html: descriptionHtml}}
          />
          <ProductSpecs
            specs={content.specs}
            variantWeight={selectedVariant?.weight}
            variantWeightUnit={selectedVariant?.weightUnit}
          />
          <WhatsInBox text={content.whatsInBox} />
          <ShippingReturnsAccordion
            shipsFrom={product.shipsFrom?.value}
            minDays={product.deliveryMinDays?.value}
            maxDays={product.deliveryMaxDays?.value}
          />
        </div>
      </div>
      <SupplierReviews data={content.supplierReviews} />
      <Suspense fallback={null}>
        <Await resolve={relatedProducts}>
          {(related) => <RelatedProducts products={related} />}
        </Await>
      </Suspense>
      <Analytics.ProductView
        data={{
          products: [
            {
              id: product.id,
              title: product.title,
              price: selectedVariant?.price.amount || '0',
              vendor: product.vendor,
              variantId: selectedVariant?.id || '',
              variantTitle: selectedVariant?.title || '',
              quantity: 1,
            },
          ],
        }}
      />
    </div>
  );
}

const PRODUCT_VARIANT_FRAGMENT = `#graphql
  fragment ProductVariant on ProductVariant {
    availableForSale
    compareAtPrice {
      amount
      currencyCode
    }
    id
    image {
      __typename
      id
      url
      altText
      width
      height
    }
    price {
      amount
      currencyCode
    }
    product {
      title
      handle
    }
    selectedOptions {
      name
      value
    }
    sku
    title
    unitPrice {
      amount
      currencyCode
    }
    weight
    weightUnit
  }
` as const;

const PRODUCT_FRAGMENT = `#graphql
  fragment Product on Product {
    id
    title
    vendor
    handle
    descriptionHtml
    description
    encodedVariantExistence
    encodedVariantAvailability
    options {
      name
      optionValues {
        name
        firstSelectableVariant {
          ...ProductVariant
        }
        swatch {
          color
          image {
            previewImage {
              url
            }
          }
        }
      }
    }
    selectedOrFirstAvailableVariant(selectedOptions: $selectedOptions, ignoreUnknownOptions: true, caseInsensitiveMatch: true) {
      ...ProductVariant
    }
    adjacentVariants (selectedOptions: $selectedOptions) {
      ...ProductVariant
    }
    seo {
      description
      title
    }
    shipsFrom: metafield(namespace: "dogebuddy", key: "ships_from") {
      value
    }
    deliveryMinDays: metafield(namespace: "dogebuddy", key: "delivery_min_days") {
      value
    }
    deliveryMaxDays: metafield(namespace: "dogebuddy", key: "delivery_max_days") {
      value
    }
    media(first: 10) {
      nodes {
        id
        ... on MediaImage {
          image {
            __typename
            id
            url
            altText
            width
            height
          }
        }
      }
    }
    highlights: metafield(namespace: "dogebuddy", key: "highlights") {
      value
    }
    specs: metafield(namespace: "dogebuddy", key: "specs") {
      value
    }
    whatsInBox: metafield(namespace: "dogebuddy", key: "whats_in_box") {
      value
    }
    supplierReviews: metafield(namespace: "dogebuddy", key: "supplier_reviews") {
      value
    }
  }
  ${PRODUCT_VARIANT_FRAGMENT}
` as const;

const PRODUCT_QUERY = `#graphql
  query Product(
    $country: CountryCode
    $handle: String!
    $language: LanguageCode
    $selectedOptions: [SelectedOptionInput!]!
  ) @inContext(country: $country, language: $language) {
    product(handle: $handle) {
      ...Product
    }
  }
  ${PRODUCT_FRAGMENT}
` as const;

const RELATED_PRODUCTS_QUERY = `#graphql
  fragment RelatedProduct on Product {
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
  query RelatedProducts($handle: String!, $country: CountryCode, $language: LanguageCode)
    @inContext(country: $country, language: $language) {
    product(handle: $handle) {
      collections(first: 5) {
        nodes {
          handle
          products(first: 8) {
            nodes {
              ...RelatedProduct
            }
          }
        }
      }
    }
  }
` as const;
