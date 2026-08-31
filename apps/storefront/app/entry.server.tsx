import {ServerRouter} from 'react-router';
import {isbot} from 'isbot';
import {renderToReadableStream} from 'react-dom/server';
import {
  createContentSecurityPolicy,
  type HydrogenRouterContextProvider,
} from '@shopify/hydrogen';
import type {EntryContext} from 'react-router';

const TURNSTILE = 'https://challenges.cloudflare.com';
/** Mirrors Hydrogen's own default-src list, which script-src/frame-src otherwise fall back to. */
const SHOPIFY_SOURCES = [
  "'self'",
  'https://cdn.shopify.com',
  'https://shopify.com',
];

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext,
  context: HydrogenRouterContextProvider,
) {
  const {nonce, header, NonceProvider} = createContentSecurityPolicy({
    shop: {
      checkoutDomain: context.env.PUBLIC_CHECKOUT_DOMAIN,
      storeDomain: context.env.PUBLIC_STORE_DOMAIN,
    },
    // Cloudflare Turnstile (the /contact form): a script, an iframe challenge, and XHR to itself.
    // Hydrogen only MERGES a directive it sets a default for (connect-src is one); script-src and
    // frame-src have no default, so passing them alone would REPLACE the default-src fallback and
    // lock out Shopify's own CDN. Repeat what default-src already allows. (Hydrogen appends the
    // nonce to script-src for us.)
    scriptSrc: [...SHOPIFY_SOURCES, TURNSTILE],
    frameSrc: [...SHOPIFY_SOURCES, TURNSTILE],
    connectSrc: [TURNSTILE],
  });

  const body = await renderToReadableStream(
    <NonceProvider>
      <ServerRouter
        context={reactRouterContext}
        url={request.url}
        nonce={nonce}
      />
    </NonceProvider>,
    {
      nonce,
      signal: request.signal,
      onError(error) {
        console.error(error);
        responseStatusCode = 500;
      },
    },
  );

  if (isbot(request.headers.get('user-agent'))) {
    await body.allReady;
  }

  responseHeaders.set('Content-Type', 'text/html');
  responseHeaders.set('Content-Security-Policy', header);

  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
