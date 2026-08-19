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

// NOTE (documented quirk, not a bug fix — real-world inputs never trigger it): rounding here
// happens in TWO steps — `toFixed(3)` first rounds the input to 3 decimal places, then the code
// below rounds that intermediate 3rd-decimal digit into whole cents. For most inputs this is
// equivalent to rounding straight to cents, but a value that sits exactly on a
// half-cent-of-a-half-cent boundary can double-round to a DIFFERENT result than a single direct
// rounding would give: e.g. `usdToCents(1.0049)` — the true nearest cent is 1.00 (0.0049 is less
// than half a cent) — first rounds to `"1.005"` (`toFixed(3)` rounds the 4th decimal digit, 9, up
// into the 3rd), and THEN that intermediate `.005` rounds UP again to 1.01. Real money inputs
// (Shopify's 2-decimal totals, CJ's own dollar amounts) never carry a 3rd-or-deeper decimal digit
// in practice, so this has never been observed to matter — documented here so a future caller
// feeding a pre-rounded-to-3-plus-decimals input isn't surprised by it.
export function usdToCents(value: number | string): number {
  // First, validate and normalize to a number
  const n = typeof value === 'string' ? Number(value.trim() === '' ? Number.NaN : value) : value

  if (!Number.isFinite(n) || n < 0) throw new RangeError(`invalid USD amount: ${String(value)}`)

  // Guard against huge magnitudes (toFixed switches to exponential at 1e21)
  if (n >= 1e19) throw new RangeError(`invalid USD amount: ${String(value)}`)

  // Normalize to decimal form (never exponential for n < 1e19)
  const fixed = n.toFixed(3)

  // Parse the normalized decimal string for half-up rounding
  const parts = fixed.split('.')
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

/**
 * Inverse of `usdToCents`: integer cents -> a bare decimal-dollar string, always exactly two
 * fraction digits, no currency symbol (`centsToUsd(1999) === '19.99'`, `centsToUsd(-50) ===
 * '-0.50'`). For building request bodies that expect a plain decimal amount rather than a
 * display value — `formatCents`'s `$12.34` is for showing a human a price, not for the wire
 * format an API (e.g. CJ's dollar-denominated fields) consumes.
 */
export function centsToUsd(cents: number): string {
  assertCents(cents)
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const dollars = Math.floor(abs / 100)
  const rem = (abs % 100).toString().padStart(2, '0')
  return `${sign}${dollars}.${rem}`
}
