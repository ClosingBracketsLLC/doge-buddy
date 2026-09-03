import type {Route} from './+types/sitemap.$type.$page[.xml]';
import {getSitemap} from '@shopify/hydrogen';

const ENABLED_SITEMAP_TYPES = ['products', 'collections', 'pages'] as const;

/** Blog removal (spec Decision 8): the index no longer advertises blogs/articles, and this guard
 *  keeps a directly-requested /sitemap/blogs/1.xml from serving URLs that 404. metaObjects are
 *  excluded too — the store defines none. */
export function assertSitemapTypeEnabled(type: string | undefined): void {
  if (!type || !(ENABLED_SITEMAP_TYPES as readonly string[]).includes(type)) {
    throw new Response('Not found', {status: 404});
  }
}

export async function loader({
  request,
  params,
  context: {storefront},
}: Route.LoaderArgs) {
  assertSitemapTypeEnabled(params.type);

  const response = await getSitemap({
    storefront,
    request,
    params,
    locales: ['EN-US', 'EN-CA', 'FR-CA'],
    getLink: ({type, baseUrl, handle, locale}) => {
      if (!locale) return `${baseUrl}/${type}/${handle}`;
      return `${baseUrl}/${locale}/${type}/${handle}`;
    },
  });

  response.headers.set('Cache-Control', `max-age=${60 * 60 * 24}`);

  return response;
}
