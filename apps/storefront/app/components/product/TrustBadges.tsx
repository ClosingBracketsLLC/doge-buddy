import {Link} from 'react-router';

function BadgeIcon({path}: {path: string}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={path} />
    </svg>
  );
}

const ICONS = {
  warehouse: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  truck:
    'M1 5h14v11H1z M15 8h4l3 3v5h-7z M5.5 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M17.5 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  lock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
  check: 'M9 12l2 2 4-4 M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
};

/**
 * Trust badge row directly under the add-to-cart (product-page-v2 spec Decision 11). The last
 * badge deliberately links the load-bearing all-sales-final policy instead of hiding it — the
 * live route is /policies/returns (the spec's "/policies/refund-policy" handle does not exist).
 * The Footer's TrustStrip is a separate component and stays untouched.
 */
export function TrustBadges() {
  const badgeClass =
    'flex items-center gap-2 rounded-xl border-2 border-ink bg-badge px-3 py-2 text-sm font-medium text-ink';
  return (
    <ul className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
      <li className={badgeClass}>
        <BadgeIcon path={ICONS.warehouse} />
        US warehouses
      </li>
      <li className={badgeClass}>
        <BadgeIcon path={ICONS.truck} />
        3–7 day delivery
      </li>
      <li className={badgeClass}>
        <BadgeIcon path={ICONS.lock} />
        Secure checkout by Shopify
      </li>
      <li className={badgeClass}>
        <span>
          All sales final —{' '}
          <Link to="/policies/returns" className="text-info underline">
            policy
          </Link>
        </span>
      </li>
    </ul>
  );
}
