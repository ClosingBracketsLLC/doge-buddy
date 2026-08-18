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
