import {parseProductContent} from '../product-content';

const mf = (value: string) => ({value});

it('parses valid metafield JSON through the shared schemas', () => {
  const content = parseProductContent({
    highlights: mf(
      JSON.stringify([
        'Durable rope core',
        'Machine washable',
        'Non-slip grip',
      ]),
    ),
    specs: mf(JSON.stringify([{label: 'Material', value: 'Cotton'}])),
    supplierReviews: mf(
      JSON.stringify({
        average: 4.6,
        count: 1238,
        reviews: [{rating: 5, text: 'Great toy'}],
        fetchedAt: '2026-09-01T00:00:00.000Z',
      }),
    ),
    whatsInBox: mf('1x rope toy'),
  });
  expect(content.highlights).toHaveLength(3);
  expect(content.specs?.[0]).toEqual({label: 'Material', value: 'Cotton'});
  expect(content.supplierReviews?.count).toBe(1238);
  expect(content.whatsInBox).toBe('1x rope toy');
});

it.each([
  ['absent metafields', {}],
  [
    'invalid JSON',
    {highlights: mf('{not json'), specs: mf('['), supplierReviews: mf('x')},
  ],
  [
    'JSON failing the schema',
    {
      highlights: mf('["a"]'),
      specs: mf('[]'),
      supplierReviews: mf('{"average":9}'),
    },
  ],
])('degrades to all-null on %s (never throws)', (_name, product) => {
  const content = parseProductContent(product);
  expect(content).toEqual({
    highlights: null,
    specs: null,
    supplierReviews: null,
    whatsInBox: null,
  });
});

it('trims whatsInBox and nulls a blank one', () => {
  expect(parseProductContent({whatsInBox: mf('  ')}).whatsInBox).toBeNull();
  expect(parseProductContent({whatsInBox: mf(' 1x toy ')}).whatsInBox).toBe(
    '1x toy',
  );
});
