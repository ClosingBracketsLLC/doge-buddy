import {describe, expect, it} from 'vitest';
import {assertSitemapTypeEnabled} from '../sitemap.$type.$page[.xml]';

describe('sitemap type guard', () => {
  it.each(['blogs', 'articles', 'metaObjects'])('404s %s', (type) => {
    try {
      assertSitemapTypeEnabled(type);
      throw new Error('expected assertSitemapTypeEnabled to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      expect((error as Response).status).toBe(404);
    }
  });

  it.each(['products', 'collections', 'pages'])('allows %s', (type) => {
    expect(() => assertSitemapTypeEnabled(type)).not.toThrow();
  });
});
