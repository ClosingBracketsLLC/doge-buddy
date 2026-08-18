import { auditLog, type createDb } from '@doge-buddy/db'
import {
  listWebhookSubscriptions,
  webhookSubscriptionCreate,
  webhookSubscriptionDelete,
  type ShopifyAdminClient,
} from '@doge-buddy/shopify-admin'

type Db = ReturnType<typeof createDb>['db']

/** Topics the ops service must always have a webhook subscription for. */
const REQUIRED_TOPICS = ['ORDERS_PAID', 'ORDERS_CANCELLED', 'REFUNDS_CREATE'] as const
const REQUIRED_TOPIC_SET: ReadonlySet<string> = new Set(REQUIRED_TOPICS)

export interface ShopifyWebhookAuditDeps {
  client: ShopifyAdminClient
  adminBaseUrl: string
  db: Db
}

export interface PrunedSubscription {
  id: string
  topic: string
  callbackUrl?: string
}

export interface PruneFailure {
  id: string
  topic: string
  callbackUrl?: string
  error: string
}

/**
 * Reconciles the shop's webhook subscriptions against REQUIRED_TOPICS: any required topic with
 * no subscription pointing at `${adminBaseUrl}/webhooks/shopify` gets (re)created. Intended to
 * run daily via cron so a manually-deleted or misconfigured subscription self-heals.
 *
 * After ensuring every required topic has a correctly-pointed subscription, also prunes stale
 * subscriptions on the topics this system manages (pre-work #5, Task 16):
 *   - a managed-topic subscription pointing at any URL other than the configured callback URL is
 *     always deleted — it's a leftover pointing at an old/misconfigured endpoint, and leaving it
 *     around means Shopify keeps firing webhooks at a dead target;
 *   - a managed-topic subscription pointing at the CORRECT url is normally left alone, unless
 *     another subscription for the same topic+url already appears earlier in Shopify's list — in
 *     that duplicate case only the first is kept and the rest are deleted (dedupe), deterministic
 *     by list order.
 * Subscriptions for topics this system doesn't manage are never inspected or touched, regardless
 * of their URL or how many exist. Every deletion is audit-logged (`webhook.subscription_pruned`)
 * before moving on to the next candidate, so pruning is traceable even though it's a destructive,
 * unattended (cron-triggered) action.
 *
 * Each candidate's delete + success-audit is isolated in its own try/catch (same shape as
 * `cj-wallet-monitor.ts`'s per-row enqueue isolation and `run-reconcile.ts`'s per-row sweeps): a
 * `webhookSubscriptionDelete` throw (not-found race, permissions, rate limit — all realistic
 * against a live Shopify API) is caught, audit-logged as `webhook.subscription_prune_failed`
 * (with the error message), and recorded in the returned `pruneFailures` list — the loop moves on
 * to the next candidate rather than aborting the whole cron run over one bad subscription.
 */
export async function shopifyWebhookAudit(
  deps: ShopifyWebhookAuditDeps,
): Promise<{ created: string[]; pruned: PrunedSubscription[]; pruneFailures: PruneFailure[] }> {
  const callbackUrl = `${deps.adminBaseUrl}/webhooks/shopify`
  const existing = await listWebhookSubscriptions(deps.client)

  const created: string[] = []
  for (const topic of REQUIRED_TOPICS) {
    const hasCorrectSubscription = existing.some((sub) => sub.topic === topic && sub.callbackUrl === callbackUrl)
    if (hasCorrectSubscription) continue

    await webhookSubscriptionCreate(deps.client, topic, callbackUrl)
    created.push(topic)
  }

  const pruned: PrunedSubscription[] = []
  const pruneFailures: PruneFailure[] = []
  const keptCorrectTopics = new Set<string>()
  for (const sub of existing) {
    if (!REQUIRED_TOPIC_SET.has(sub.topic)) continue // topic we don't manage: never touched

    if (sub.callbackUrl === callbackUrl) {
      if (!keptCorrectTopics.has(sub.topic)) {
        keptCorrectTopics.add(sub.topic)
        continue // first correctly-pointed sub for this topic: keep it
      }
      // else: falls through — a later duplicate of an already-kept correct-URL sub, prune it
    }

    try {
      await webhookSubscriptionDelete(deps.client, sub.id)
      await deps.db.insert(auditLog).values({
        actor: 'system',
        action: 'webhook.subscription_pruned',
        entityType: 'webhook_subscription',
        entityId: sub.id,
        detail: { topic: sub.topic, callbackUrl: sub.callbackUrl, id: sub.id },
      })
      pruned.push({ id: sub.id, topic: sub.topic, callbackUrl: sub.callbackUrl })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await deps.db.insert(auditLog).values({
        actor: 'system',
        action: 'webhook.subscription_prune_failed',
        entityType: 'webhook_subscription',
        entityId: sub.id,
        detail: { topic: sub.topic, callbackUrl: sub.callbackUrl, id: sub.id, error: message },
      })
      pruneFailures.push({ id: sub.id, topic: sub.topic, callbackUrl: sub.callbackUrl, error: message })
    }
  }

  return { created, pruned, pruneFailures }
}
