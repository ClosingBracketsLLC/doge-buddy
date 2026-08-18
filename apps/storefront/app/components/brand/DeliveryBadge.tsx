export function DeliveryBadge({shipsFrom, minDays, maxDays}: {shipsFrom?: string | null; minDays?: string | null; maxDays?: string | null}) {
  if (!shipsFrom || !minDays || !maxDays) return null;
  return (
    <p className="inline-block -rotate-2 rounded border-2 border-dashed border-info bg-badge px-4 py-2 text-sm font-medium text-ink">
      Ships from {shipsFrom} · {minDays}–{maxDays} days
    </p>
  );
}
