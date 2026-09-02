import type {SupplierReviews as SupplierReviewsData} from '@doge-buddy/core';

/**
 * Labeled supplier marketplace reviews (product-page-v2 spec Decisions 3-6). The disclosure line
 * is FIXED VERBATIM — FTC 16 CFR Part 465: these reviewers are not this store's buyers, and the
 * label is what makes displaying them honest. NO schema.org review markup, ever (Decision 6):
 * imported reviews in JSON-LD invite a Google manual action. Judge.me replaces/demotes this
 * section once real orders exist (backlog #15).
 */
const DISCLOSURE =
  "From the supplier's buyers on other marketplaces — not yet from Doge Buddy customers.";

function Stars({rating}: {rating: number}) {
  return (
    <span aria-label={`${rating} out of 5 stars`} className="text-gold-dark">
      {'★'.repeat(rating)}
      <span aria-hidden="true" className="text-ink/20">
        {'★'.repeat(5 - rating)}
      </span>
    </span>
  );
}

export function SupplierReviews({data}: {data: SupplierReviewsData | null}) {
  if (!data || data.reviews.length === 0) return null;
  const asOf = data.fetchedAt.slice(0, 10);
  return (
    <section className="mt-12">
      <h2 className="font-display text-2xl text-ink">Marketplace reviews</h2>
      <p className="mt-1 text-sm text-ink/70">{DISCLOSURE}</p>
      <p className="mt-2 font-medium text-ink">
        ★ {data.average.toFixed(1)} · {data.count.toLocaleString('en-US')} marketplace ratings ·
        as of {asOf}
      </p>
      <ul className="mt-4 grid gap-3 md:grid-cols-2">
        {data.reviews.map((review, index) => (
          <li
            key={`${index}-${review.text.slice(0, 40)}`}
            className="rounded-2xl border-2 border-ink bg-surface-raised p-4"
          >
            <Stars rating={review.rating} />
            <p className="mt-2 text-sm text-ink">{review.text}</p>
            {review.date || review.country ? (
              <p className="mt-2 text-xs text-ink/60">
                {[review.date, review.country].filter(Boolean).join(' · ')}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
