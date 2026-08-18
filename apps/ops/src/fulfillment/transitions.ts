import { type createDb, supplierOrders } from '@doge-buddy/db'
import { and, eq } from 'drizzle-orm'

type Db = ReturnType<typeof createDb>['db']

export type SupplierOrderStatusDb =
  | 'pending'
  | 'created'
  | 'confirmed'
  | 'paid'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'failed'
  | 'needs_attention'
  | 'awaiting_funds'

/** Thrown by `applyTransition` when `to` is not reachable from `from` per the legal matrix. */
export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: SupplierOrderStatusDb,
    public readonly to: SupplierOrderStatusDb,
  ) {
    super(`Illegal supplier-order transition: ${from} -> ${to}`)
    this.name = 'IllegalTransitionError'
  }
}

/**
 * Thrown by `applyTransition` when the guarded `UPDATE ... WHERE id = ? AND status = from`
 * matches 0 rows — i.e. another writer already moved the row off `from` (optimistic concurrency).
 */
export class StaleStatusError extends Error {
  constructor(
    public readonly from: SupplierOrderStatusDb,
    public readonly to: SupplierOrderStatusDb,
  ) {
    super(`Stale supplier-order status: row was not in status '${from}' when transitioning to '${to}'`)
    this.name = 'StaleStatusError'
  }
}

/**
 * Exhaustive legal-transition matrix for `supplier_orders.status`. Every status change on
 * supplier_orders across the money path must flow through `applyTransition` below — no job may
 * write `status` directly — so this table is the single source of truth for what's legal.
 *
 * Self-transitions (from === to) are always illegal and are never listed here.
 */
const LEGAL_TRANSITIONS: Record<SupplierOrderStatusDb, SupplierOrderStatusDb[]> = {
  pending: ['created', 'needs_attention', 'failed'],
  created: ['confirmed', 'needs_attention', 'failed'],
  confirmed: ['paid', 'awaiting_funds', 'needs_attention', 'failed'],
  awaiting_funds: ['paid', 'needs_attention', 'failed'],
  paid: ['shipped', 'needs_attention'],
  shipped: ['delivered', 'needs_attention'],
  needs_attention: ['pending', 'created', 'confirmed', 'paid', 'cancelled'],
  delivered: [],
  cancelled: [],
  failed: [],
}

/** Pure lookup: is `to` a legal next status from `from`? */
export function canTransition(from: SupplierOrderStatusDb, to: SupplierOrderStatusDb): boolean {
  return LEGAL_TRANSITIONS[from].includes(to)
}

export type SupplierOrderPatch = Partial<{
  supplierOrderId: string
  shipmentOrderId: string
  logisticName: string
  productAmountCents: number
  postageAmountCents: number
  totalAmountCents: number
  trackingNumber: string
  lastError: string
  paidAt: Date
}>

/**
 * Moves a supplier_orders row from `from` to `to`, persisting `patch` in the same UPDATE.
 *
 * Illegality is checked against the pure matrix *before* any DB call, so an illegal pair never
 * reaches the database. The UPDATE itself is guarded on `WHERE id = ? AND status = from`
 * (optimistic concurrency): if another writer already moved the row off `from`, 0 rows match and
 * this throws `StaleStatusError` instead of silently clobbering that other writer's change.
 */
export async function applyTransition(
  db: Db,
  supplierOrderRowId: string,
  from: SupplierOrderStatusDb,
  to: SupplierOrderStatusDb,
  patch?: SupplierOrderPatch,
): Promise<void> {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to)
  }

  const [updated] = await db
    .update(supplierOrders)
    .set({ ...patch, status: to })
    .where(and(eq(supplierOrders.id, supplierOrderRowId), eq(supplierOrders.status, from)))
    .returning({ id: supplierOrders.id })

  if (!updated) {
    throw new StaleStatusError(from, to)
  }
}
