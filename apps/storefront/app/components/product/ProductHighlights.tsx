import type {ProductHighlights as Highlights} from '@doge-buddy/core';

export function ProductHighlights({highlights}: {highlights: Highlights | null}) {
  if (!highlights || highlights.length === 0) return null;
  return (
    <ul className="mt-6 space-y-2">
      {highlights.map((highlight) => (
        <li key={highlight} className="flex items-start gap-2 text-ink">
          <span aria-hidden="true" className="mt-0.5 font-display text-accent">
            ✓
          </span>
          {highlight}
        </li>
      ))}
    </ul>
  );
}
