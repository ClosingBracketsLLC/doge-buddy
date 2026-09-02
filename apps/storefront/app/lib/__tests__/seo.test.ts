import {productJsonLd, organizationJsonLd, webSiteJsonLd} from '../seo';

it('builds Product JSON-LD with offer', () => {
  const ld = productJsonLd({name: 'Rope Toy', description: 'Tug fun', url: 'https://x/p/rope', imageUrl: 'https://x/i.jpg', price: '12.99', currencyCode: 'USD', available: true}) as any;
  expect(ld['@type']).toBe('Product');
  expect(ld.offers).toMatchObject({'@type': 'Offer', price: '12.99', priceCurrency: 'USD', availability: 'https://schema.org/InStock'});
});

it('marks unavailable products OutOfStock and omits missing image', () => {
  const ld = productJsonLd({name: 'X', description: '', url: 'https://x', price: '1.00', currencyCode: 'USD', available: false}) as any;
  expect(ld.offers.availability).toBe('https://schema.org/OutOfStock');
  expect('image' in ld).toBe(false);
});

it('builds Organization and WebSite JSON-LD', () => {
  expect((organizationJsonLd({name: 'Doge Buddy', url: 'https://x', logoUrl: 'https://x/l.svg'}) as any)['@type']).toBe('Organization');
  expect((webSiteJsonLd({name: 'Doge Buddy', url: 'https://x'}) as any)['@type']).toBe('WebSite');
});

it('productJsonLd emits EXACTLY the known key set — the set is closed by Decision 6 (no review/aggregateRating, ever)', () => {
  const jsonLd = productJsonLd({
    name: 'Rope Toy',
    description: 'A rope toy',
    url: 'https://dogebuddy.com/products/rope-toy',
    price: '19.99',
    currencyCode: 'USD',
    available: true,
  }) as Record<string, unknown>;
  // A not.toHaveProperty('review') assert would pass trivially even after someone adds a
  // conditional reviews parameter — pinning the full key set is what actually guards Decision 6.
  expect(Object.keys(jsonLd).sort()).toEqual(['@context', '@type', 'description', 'name', 'offers', 'url']);
});
