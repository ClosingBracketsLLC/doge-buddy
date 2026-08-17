import { describe, it } from 'vitest'
import { CJSupplierAdapter, CjHttpClient, InMemoryCjTokenStore, runAdapterContractTests } from '@doge-buddy/supplier'

const enabled = process.env.CJ_CONTRACT === '1' && !!process.env.CJ_API_KEY
if (!enabled) {
  describe('SupplierAdapter contract: cj-sandbox', () => {
    it.skip('set CJ_CONTRACT=1 and CJ_API_KEY to run the live sandbox contract', () => {})
  })
} else {
  const client = new CjHttpClient({ apiKey: process.env.CJ_API_KEY!, tokenStore: new InMemoryCjTokenStore() })
  const adapter = new CJSupplierAdapter({ client, openId: process.env.CJ_OPEN_ID, sandbox: true })
  runAdapterContractTests('cj-sandbox', async () => ({
    adapter,
    knownVariantId: process.env.CJ_CONTRACT_VID ?? '',
    searchKeyword: 'dog toy',
    address: { name: 'DB Sandbox', line1: '1 Test St', city: 'Atlanta', state: 'GA', zip: '30301', country: 'US' },
    advanceToShipped: async (orderId) => {
      for (const s of [400, 500, 600]) await client.sandboxUpdateStatus(orderId, s)
      await client.sandboxUpdateTrackNumber(orderId, `SANDBOX-${orderId}`)
    },
  }))
}
