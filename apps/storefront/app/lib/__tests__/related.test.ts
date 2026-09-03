import {describe, expect, it} from 'vitest';
import {pickRelated, KNOWN_CATEGORY_HANDLES, RELATED_LIMIT} from '../related';

const p = (handle: string) => ({handle});

describe('pickRelated', () => {
  it('picks the first CATEGORY collection, drops the current product, caps at RELATED_LIMIT', () => {
    const collections = [
      {handle: 'frontpage', products: {nodes: [p('x1'), p('x2')]}},
      {handle: 'toys-play', products: {nodes: [p('me'), p('a'), p('b'), p('c'), p('d'), p('e')]}},
      {handle: 'beds-comfort', products: {nodes: [p('z')]}},
    ];
    const related = pickRelated(collections, 'me');
    expect(related.map((r) => r.handle)).toEqual(['a', 'b', 'c', 'd']);
    expect(related).toHaveLength(RELATED_LIMIT);
  });

  it('returns [] when the only collections are non-category (frontpage)', () => {
    expect(pickRelated([{handle: 'frontpage', products: {nodes: [p('a')]}}], 'me')).toEqual([]);
  });

  it('returns [] when the category collection holds only the current product', () => {
    expect(pickRelated([{handle: 'grooming-care', products: {nodes: [p('me')]}}], 'me')).toEqual([]);
  });

  it('returns [] on null/undefined/empty input', () => {
    expect(pickRelated(null, 'me')).toEqual([]);
    expect(pickRelated(undefined, 'me')).toEqual([]);
    expect(pickRelated([], 'me')).toEqual([]);
  });

  it('KNOWN_CATEGORY_HANDLES is exactly the four CATEGORIES handles', () => {
    expect([...KNOWN_CATEGORY_HANDLES].sort()).toEqual(['beds-comfort', 'grooming-care', 'toys-play', 'walks-travel']);
  });
});
