import type { SendOpts } from '../fulfillment/types.ts'

/**
 * `inventory.sync` — the queue that pushes CJ's per-variant US stock into Shopify's inventory
 * levels for one local product.
 *
 * STUB (Task 4). Only the queue name and the send options live here for now, because the listing
 * worker (`apply-new-listing.ts`) is the queue's first producer and has to name it *before* the
 * consumer exists: a listing is born inventory-tracked with whatever stock CJ reported at apply
 * time, and that snapshot starts going stale immediately. Task 5 fills in the handler (and the
 * pure US-stock sum the worker currently keeps locally) behind these same two exports, so nothing
 * about the producer changes when it lands.
 */
export const INVENTORY_SYNC_QUEUE = 'inventory.sync'

/**
 * Send options for every `inventory.sync` job.
 *
 * `singletonKey` is the local product id: two syncs for the same product would race to write the
 * same inventory levels, and the later one is always the one worth keeping — collapsing them is
 * both cheaper and more correct. The retry triplet (3 attempts, 30s, backing off) matches the rest
 * of the CJ-facing jobs: a stock read that fails is nearly always a transient supplier hiccup.
 * `expireInSeconds: 600` bounds a job that somehow wedges mid-run.
 */
export const inventorySyncSendOpts = (key: string): SendOpts => ({
  singletonKey: key,
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 600,
})
