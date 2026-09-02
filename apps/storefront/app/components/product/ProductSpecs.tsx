import type {ProductSpecs as Specs} from '@doge-buddy/core';

const WEIGHT_UNITS: Record<string, string> = {
  GRAMS: 'g',
  KILOGRAMS: 'kg',
  OUNCES: 'oz',
  POUNDS: 'lb',
};

export function formatVariantWeight(
  weight?: number | null,
  unit?: string | null,
): string | null {
  if (weight == null || weight <= 0) return null;
  const suffix = unit ? WEIGHT_UNITS[unit] : undefined;
  if (!suffix) return null;
  return `${Math.round(weight * 100) / 100} ${suffix}`;
}

export function ProductSpecs({
  specs,
  variantWeight,
  variantWeightUnit,
}: {
  specs: Specs | null;
  variantWeight?: number | null;
  variantWeightUnit?: string | null;
}) {
  const weightText = formatVariantWeight(variantWeight, variantWeightUnit);
  // The LIVE selected-variant weight beats any agent-written Weight row (spec B2) — the agent
  // row only survives as the fallback when the variant carries no weight.
  const rows = [
    ...(specs ?? []).filter(
      (row) => !(weightText && row.label.trim().toLowerCase() === 'weight'),
    ),
    ...(weightText ? [{label: 'Weight', value: weightText}] : []),
  ];
  if (rows.length === 0) return null;
  return (
    <div className="mt-8">
      <h2 className="font-display text-2xl text-ink">Specs</h2>
      <table className="mt-2 w-full border-collapse text-sm">
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b border-ink/10">
              <th scope="row" className="w-1/3 py-2 pr-4 text-left font-medium text-ink/70">
                {row.label}
              </th>
              <td className="py-2 text-ink">{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
