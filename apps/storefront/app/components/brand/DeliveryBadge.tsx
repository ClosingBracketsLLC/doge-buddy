/** How a product's origin is named to the buyer. Never the raw country code: 'CN' means nothing
 *  to a shopper, and the honest phrase is the one the shipping policy uses (spec 2026-09-03 §2). */
export function originLabel(shipsFrom: string): string {
  return shipsFrom === 'CN' ? 'our partner warehouse' : 'our US warehouse';
}

/**
 * The product's OWN delivery window, from its own metafields. Renders nothing when any part is
 * missing — a product with no quoted window makes no promise at all, which is the whole point of
 * the affordable-catalog pivot: no blanket site-wide claim survives anywhere.
 */
export function DeliveryBadge({shipsFrom, minDays, maxDays}: {shipsFrom?: string | null; minDays?: string | null; maxDays?: string | null}) {
  if (!shipsFrom || !minDays || !maxDays) return null;
  return (
    <p className="inline-block -rotate-2 rounded border-2 border-dashed border-info bg-badge px-4 py-2 text-sm font-medium text-ink">
      Arrives in {minDays}–{maxDays} days · ships from {originLabel(shipsFrom)}
    </p>
  );
}
