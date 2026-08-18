export function DeliveryBadge({shipsFrom, minDays, maxDays}: {shipsFrom?: string | null; minDays?: string | null; maxDays?: string | null}) {
  if (!shipsFrom || !minDays || !maxDays) return null;
  return (
    <p className="bg-badge text-ink rounded-2xl px-4 py-2 text-sm font-medium inline-block">
      Ships from {shipsFrom} · {minDays}–{maxDays} days
    </p>
  );
}
