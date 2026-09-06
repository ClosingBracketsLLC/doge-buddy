/**
 * The one-line delivery estimate on a product CARD — the buyer sees how long an item takes before
 * clicking into it (spec 2026-09-03 §4). Deliberately the slow end of the product's own quoted
 * window: under-promising is the only side of this trade that never generates a complaint.
 * Renders nothing without the metafield, so a pre-pivot product makes no claim at all.
 */
export function DeliveryLine({maxDays}: {maxDays?: string | null}) {
  if (!maxDays) return null;
  return <p className="mt-1 text-xs text-muted">Arrives in ~{maxDays} days</p>;
}
