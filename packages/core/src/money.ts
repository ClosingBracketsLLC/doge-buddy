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

export function usdToCents(value: number | string): number {
  const str = typeof value === 'string' ? value.trim() : String(value)

  if (str === '') throw new RangeError(`invalid USD amount: ${String(value)}`)

  const n = Number(str)
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`invalid USD amount: ${String(value)}`)

  const parts = str.split('.')
  let cents = parseInt(parts[0] || '0', 10) * 100

  if (parts[1]) {
    const centsStr = parts[1].slice(0, 2).padEnd(2, '0')
    const thirdDecimal = parts[1][2] || '0'
    cents += parseInt(centsStr, 10)
    if (parseInt(thirdDecimal, 10) >= 5) {
      cents += 1
    }
  }

  assertCents(cents, 'usdToCents result')
  return cents
}
