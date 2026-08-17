import { listWebhookSubscriptions, webhookSubscriptionCreate, type ShopifyAdminClient } from '@doge-buddy/shopify-admin'

/** Topics the ops service must always have a webhook subscription for. */
const REQUIRED_TOPICS = ['ORDERS_PAID', 'ORDERS_CANCELLED', 'REFUNDS_CREATE'] as const

export interface ShopifyWebhookAuditDeps {
  client: ShopifyAdminClient
  adminBaseUrl: string
}

/**
 * Reconciles the shop's webhook subscriptions against REQUIRED_TOPICS: any required topic with
 * no subscription pointing at `${adminBaseUrl}/webhooks/shopify` gets (re)created. Intended to
 * run daily via cron so a manually-deleted or misconfigured subscription self-heals.
 */
export async function shopifyWebhookAudit(deps: ShopifyWebhookAuditDeps): Promise<{ created: string[] }> {
  const callbackUrl = `${deps.adminBaseUrl}/webhooks/shopify`
  const existing = await listWebhookSubscriptions(deps.client)

  const created: string[] = []
  for (const topic of REQUIRED_TOPICS) {
    const hasCorrectSubscription = existing.some((sub) => sub.topic === topic && sub.callbackUrl === callbackUrl)
    if (hasCorrectSubscription) continue

    await webhookSubscriptionCreate(deps.client, topic, callbackUrl)
    created.push(topic)
  }

  return { created }
}
