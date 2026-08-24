/** Per-run ceiling on CJ "points" (CJ's API rate-limit currency) the sourcing agent may spend.
 * Keeps a single sourcing run from starving fulfillment's shared daily CJ points budget. */
export const SOURCING_POINTS_ALLOWANCE = 25_000

export class PointsAllowanceExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PointsAllowanceExceededError'
  }
}

/** Tracks CJ points spent within a single sourcing run against a fixed total. Not thread-safe
 * across concurrent runs by design — each run gets its own instance. */
export class PointsAllowance {
  private readonly total: number
  private spentPoints = 0

  constructor(total: number = SOURCING_POINTS_ALLOWANCE) {
    this.total = total
  }

  /** Throws PointsAllowanceExceededError when spend would cross the total. A rejected spend does
   * NOT consume any of the allowance. */
  spend(points: number, what: string): void {
    if (this.spentPoints + points > this.total) {
      throw new PointsAllowanceExceededError(
        `CJ points allowance exhausted: spending ${points} for "${what}" would exceed the ${this.total}-point run allowance (${this.spentPoints} already spent, ${this.remaining()} remaining).`,
      )
    }
    this.spentPoints += points
  }

  spent(): number {
    return this.spentPoints
  }

  remaining(): number {
    return this.total - this.spentPoints
  }
}
