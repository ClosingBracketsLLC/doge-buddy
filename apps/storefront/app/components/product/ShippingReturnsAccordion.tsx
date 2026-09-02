import {Link} from 'react-router';
import {POLICY_COPY} from '@doge-buddy/core';

/**
 * <details> summaries of the shipping + returns policies (product-page-v2 spec B2). Every
 * paragraph is taken verbatim from POLICY_COPY — no new policy copy is authored here; each block
 * ends with a link to the full policy page.
 */
export function ShippingReturnsAccordion({
  shipsFrom,
  minDays,
  maxDays,
}: {
  shipsFrom?: string | null;
  minDays?: string | null;
  maxDays?: string | null;
}) {
  const shipping = POLICY_COPY.find((policy) => policy.handle === 'shipping');
  const returns = POLICY_COPY.find((policy) => policy.handle === 'returns');
  if (!shipping || !returns) return null;

  const detailsClass = 'rounded-2xl border-2 border-ink bg-surface-raised px-4 py-3';
  const summaryClass = 'cursor-pointer font-display text-lg text-ink';

  return (
    <div className="mt-8 space-y-2">
      <details className={detailsClass}>
        <summary className={summaryClass}>Shipping</summary>
        {shipsFrom && minDays && maxDays ? (
          <p className="mt-2 text-sm font-medium text-ink">
            Ships from {shipsFrom} · {minDays}–{maxDays} days
          </p>
        ) : null}
        {shipping.sections[0]!.paragraphs.slice(0, 2).map((paragraph) => (
          <p key={paragraph} className="mt-2 text-sm text-ink">
            {paragraph}
          </p>
        ))}
        <p className="mt-2 text-sm">
          <Link to="/policies/shipping" className="text-info underline">
            Full shipping policy
          </Link>
        </p>
      </details>
      <details className={detailsClass}>
        <summary className={summaryClass}>Returns</summary>
        {returns.sections[0]!.paragraphs.map((paragraph) => (
          <p key={paragraph} className="mt-2 text-sm text-ink">
            {paragraph}
          </p>
        ))}
        <p className="mt-2 text-sm">
          <Link to="/policies/returns" className="text-info underline">
            Full returns policy
          </Link>
        </p>
      </details>
    </div>
  );
}
