import {Suspense} from 'react';
import {Await, NavLink, useAsyncValue} from 'react-router';
import {
  type CartViewPayload,
  useAnalytics,
  useOptimisticCart,
} from '@shopify/hydrogen';
import type {HeaderQuery, CartApiQueryFragment} from 'storefrontapi.generated';
import {useAside} from '~/components/Aside';
import wordmark from '~/assets/wordmark.svg';

interface HeaderProps {
  header: HeaderQuery;
  cart: Promise<CartApiQueryFragment | null>;
  isLoggedIn: Promise<boolean>;
  publicStoreDomain: string;
}

type Viewport = 'desktop' | 'mobile';

// Hardcoded nav — later tasks (product/collection routes, Task 10 policy
// pages) rely on these exact paths existing in the header/mobile nav.
const NAV_ITEMS: Array<{to: string; title: string}> = [
  {to: '/collections/toys-play', title: 'Toys & Play'},
  {to: '/collections/walks-travel', title: 'Walks & Travel'},
  {to: '/collections/beds-comfort', title: 'Beds & Comfort'},
  {to: '/collections/grooming-care', title: 'Grooming & Care'},
];

export function Header({
  header,
  isLoggedIn,
  cart,
  publicStoreDomain,
}: HeaderProps) {
  const {shop, menu} = header;
  return (
    <header className="sticky top-0 z-10 flex items-center gap-2 bg-surface-raised px-4 py-3 md:gap-4">
      <NavLink prefetch="intent" to="/" end className="shrink-0 rounded-2xl">
        <img src={wordmark} alt="Doge Buddy" className="h-8" />
      </NavLink>
      <HeaderMenu
        menu={menu}
        viewport="desktop"
        primaryDomainUrl={header.shop.primaryDomain.url}
        publicStoreDomain={publicStoreDomain}
      />
      <HeaderCtas isLoggedIn={isLoggedIn} cart={cart} />
    </header>
  );
}

export function HeaderMenu({
  viewport,
}: {
  // menu/primaryDomainUrl/publicStoreDomain are part of the skeleton's
  // menu-loader machinery (still wired up by callers); the nav itself is
  // hardcoded per the brand brief, so they're unused here.
  menu?: HeaderProps['header']['menu'];
  primaryDomainUrl?: HeaderProps['header']['shop']['primaryDomain']['url'];
  viewport: Viewport;
  publicStoreDomain?: HeaderProps['publicStoreDomain'];
}) {
  const className =
    viewport === 'desktop'
      ? 'hidden items-center gap-1 md:ml-6 md:flex md:gap-2'
      : 'flex flex-col gap-1';
  const {close} = useAside();

  return (
    <nav className={className} role="navigation">
      {viewport === 'mobile' && (
        <NavLink
          end
          onClick={close}
          prefetch="intent"
          to="/"
          className={navLinkClassName}
        >
          Home
        </NavLink>
      )}
      {NAV_ITEMS.map((item) => (
        <NavLink
          className={navLinkClassName}
          end
          key={item.to}
          onClick={close}
          prefetch="intent"
          to={item.to}
        >
          {item.title}
        </NavLink>
      ))}
    </nav>
  );
}

function navLinkClassName({isActive}: {isActive: boolean}) {
  return `rounded-2xl px-3 py-2 text-ink transition-colors hover:text-cta ${
    isActive ? 'text-cta font-semibold' : ''
  }`;
}

function HeaderCtas({
  isLoggedIn,
  cart,
}: Pick<HeaderProps, 'isLoggedIn' | 'cart'>) {
  return (
    <nav className="ml-auto flex items-center gap-1" role="navigation">
      <HeaderMenuMobileToggle />
      <NavLink
        prefetch="intent"
        to="/account"
        className="rounded-2xl px-3 py-2 text-ink transition-colors hover:text-cta"
      >
        <Suspense fallback="Sign in">
          <Await resolve={isLoggedIn} errorElement="Sign in">
            {(isLoggedIn) => (isLoggedIn ? 'Account' : 'Sign in')}
          </Await>
        </Suspense>
      </NavLink>
      <SearchToggle />
      <CartToggle cart={cart} />
    </nav>
  );
}

function HeaderMenuMobileToggle() {
  const {open} = useAside();
  return (
    <button
      className="rounded-2xl px-3 py-2 text-ink transition-colors hover:text-cta md:hidden"
      onClick={() => open('mobile')}
    >
      <h3>☰</h3>
    </button>
  );
}

function SearchToggle() {
  const {open} = useAside();
  return (
    <button
      className="rounded-2xl px-3 py-2 text-ink transition-colors hover:text-cta"
      onClick={() => open('search')}
    >
      Search
    </button>
  );
}

function CartBadge({count}: {count: number}) {
  const {open} = useAside();
  const {publish, shop, cart, prevCart} = useAnalytics();

  return (
    <a
      href="/cart"
      className="rounded-2xl px-3 py-2 text-ink transition-colors hover:text-cta"
      onClick={(e) => {
        e.preventDefault();
        open('cart');
        publish('cart_viewed', {
          cart,
          prevCart,
          shop,
          url: window.location.href || '',
        } as CartViewPayload);
      }}
    >
      Cart <span aria-label={`(items: ${count})`}>{count}</span>
    </a>
  );
}

function CartToggle({cart}: Pick<HeaderProps, 'cart'>) {
  return (
    <Suspense fallback={<CartBadge count={0} />}>
      <Await resolve={cart}>
        <CartBanner />
      </Await>
    </Suspense>
  );
}

function CartBanner() {
  const originalCart = useAsyncValue() as CartApiQueryFragment | null;
  const cart = useOptimisticCart(originalCart);
  return <CartBadge count={cart?.totalQuantity ?? 0} />;
}
