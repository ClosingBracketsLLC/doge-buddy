/**
 * Pure JSON-LD (schema.org) builder functions.
 *
 * Each function returns a plain, serializable object — no request/global
 * access — so callers (route loaders/meta functions) supply already-resolved
 * data (origin URLs, prices, etc).
 */

export function productJsonLd(p: {
  name: string;
  description: string;
  url: string;
  imageUrl?: string;
  price: string;
  currencyCode: string;
  available: boolean;
}): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    description: p.description,
    url: p.url,
    ...(p.imageUrl ? {image: p.imageUrl} : {}),
    offers: {
      '@type': 'Offer',
      url: p.url,
      price: p.price,
      priceCurrency: p.currencyCode,
      availability: p.available
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
    },
  };
}

export function organizationJsonLd(o: {
  name: string;
  url: string;
  logoUrl: string;
}): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: o.name,
    url: o.url,
    logo: o.logoUrl,
  };
}

export function webSiteJsonLd(w: {name: string; url: string}): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: w.name,
    url: w.url,
  };
}
