import {Link} from 'react-router';
import type {FooterQuery, HeaderQuery} from 'storefrontapi.generated';
import {TrustStrip} from '~/components/brand/TrustStrip';

interface FooterProps {
  footer: Promise<FooterQuery | null>;
  header: HeaderQuery;
  publicStoreDomain: string;
}

// Hardcoded footer links — routes arrive in Task 10, so most are dead
// links until then (expected; see task-4 brief). /pages/about 404s until
// the About page is created in Shopify admin — owner item in OWNER-CHECKLIST.
const FOOTER_LINKS: Array<{to: string; title: string}> = [
  {to: '/pages/about', title: 'About'},
  {to: '/policies/shipping', title: 'Shipping'},
  {to: '/policies/returns', title: 'Returns'},
  {to: '/policies/privacy', title: 'Privacy'},
  {to: '/policies/terms', title: 'Terms'},
  {to: '/contact', title: 'Contact'},
];

// footer/header/publicStoreDomain are unused: the skeleton's footer-menu
// loader machinery lives on in PageLayout's call site, but the footer
// content itself is now fully hardcoded per the brand brief.
export function Footer(_props: FooterProps) {
  return (
    <footer className="mt-auto border-t-4 border-gold bg-ink text-surface">
      <div className="mx-auto flex max-w-5xl flex-col items-center gap-4 px-4 py-8">
        <nav
          className="flex flex-wrap justify-center gap-x-6 gap-y-2"
          role="navigation"
        >
          {FOOTER_LINKS.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className="text-surface transition-colors hover:text-accent"
            >
              {link.title}
            </Link>
          ))}
        </nav>
        <TrustStrip />
        <p className="text-sm text-surface">
          © {new Date().getFullYear()} Doge Buddy
        </p>
      </div>
    </footer>
  );
}
