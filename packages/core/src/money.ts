export function assertCents(n: number, label = 'amount'): void {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${label} must be integer cents, got ${n}`)
}

export function formatCents(cents: number): string {
  assertCents(cents)
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const dollars = Math.floor(abs / 100)
  const rem = (abs % 100).toString().padStart(2, '0')
  return `${sign}$${dollars}.${rem}`
}

export function grossMarginBps(revenueCents: number, costCents: number): number {
  assertCents(revenueCents, 'revenueCents')
  assertCents(costCents, 'costCents')
  if (revenueCents <= 0) throw new RangeError(`revenueCents must be > 0, got ${revenueCents}`)
  return Math.round(((revenueCents - costCents) / revenueCents) * 10_000)
}
