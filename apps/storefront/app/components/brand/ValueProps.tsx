import {Link} from 'react-router';

/** Home value-props strip (spec Decision 5). The all-sales-final item LINKS to the policy rather
 *  than paraphrasing it — policy copy is legally load-bearing and single-sourced in POLICY_COPY. */
export function ValueProps() {
  const item = 'rounded-2xl bg-badge px-3 py-2 text-center text-sm font-medium text-ink';
  return (
    <ul className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-3">
      <li className={item}>Ships from US warehouses</li>
      <li className={item}>3–7 day delivery</li>
      <li className={item}>
        All sales final —{' '}
        <Link to="/policies/returns" className="underline transition-colors hover:text-accent">
          see our returns policy
        </Link>
      </li>
    </ul>
  );
}
