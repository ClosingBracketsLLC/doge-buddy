import { loadDotEnv } from '../src/load-env.ts'

/**
 * Read-only probe of Zendrop's MCP surface — the FIRST step of the second-supplier evaluation
 * (research memo `docs/supplier-trend-research-2026-09-02.md` §1: "a token-in-hand probe of the
 * MCP's actual tool surface against our 19-method SupplierAdapter — BEFORE any spec").
 *
 * This asks the server what it has (`tools/list`, a standard MCP JSON-RPC method) and prints the
 * gap against our adapter interface. It ASSUMES NOTHING about Zendrop's wire shapes — that is the
 * whole point: the house rule is that fixtures/live responses are authoritative and an adapter is
 * never written against undocumented guesses.
 *
 * Setup: a Zendrop Pro account ($49/mo — the tier that gates US-warehouse products), then an
 * access token from Zendrop's developer/API settings with at least `catalog:read` and
 * `orders:read`. Put it in apps/ops/.env as ZENDROP_ACCESS_TOKEN (never paste it into chat).
 *
 *   pnpm --filter @doge-buddy/ops probe-zendrop
 *
 * Nothing here mutates anything: `tools/list` is a description call, and no tool is invoked.
 */

if (loadDotEnv(import.meta.url)) {
  console.log('probe-zendrop: loaded apps/ops/.env (existing environment variables take precedence)')
}

const token = process.env.ZENDROP_ACCESS_TOKEN
const endpoint = process.env.ZENDROP_MCP_URL ?? 'https://app.zendrop.com/mcp/v1'

if (!token) {
  console.error(
    'probe-zendrop: ZENDROP_ACCESS_TOKEN is not set.\n' +
      '  1. Zendrop account on the Pro tier (US-warehouse products are gated to it)\n' +
      '  2. Generate an access token (scopes: catalog:read, orders:read at minimum)\n' +
      '  3. Add ZENDROP_ACCESS_TOKEN=<token> to apps/ops/.env, then re-run',
  )
  process.exit(2)
}

/** What a second supplier must eventually cover — our SupplierAdapter surface, grouped by how
 *  load-bearing each method is for THIS store's automation. */
const ADAPTER_SURFACE = {
  'catalog (must have)': ['searchProducts', 'getProduct', 'getVariantStock'],
  'pricing/shipping (must have)': ['quoteShipping'],
  'ordering (must have)': ['placeOrder', 'confirmOrder', 'payOrder', 'getOrderStatus', 'getTracking'],
  'money (must have)': ['getBalance'],
  'aftercare (needed before real orders)': ['getDisputeOptions', 'openDispute', 'getDispute'],
  'freshness (degradable — polling can substitute)': [
    'getProductReviews',
    'verifyWebhook',
    'parseWebhook',
    'subscribeProductWebhook',
    'unsubscribeProductWebhook',
  ],
} as const

interface McpTool {
  name?: string
  description?: string
  inputSchema?: unknown
}

async function rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} — ${text.slice(0, 300)}`)
  }
  // MCP servers may answer JSON or an SSE frame; accept both rather than assuming.
  const jsonText = text.startsWith('data:') ? text.slice(text.indexOf('{')) : text
  return JSON.parse(jsonText) as unknown
}

try {
  console.log(`probe-zendrop: POST ${endpoint} → tools/list\n`)
  const body = (await rpc('tools/list')) as { result?: { tools?: McpTool[] }; error?: unknown }
  if (body.error) {
    console.error('probe-zendrop: server returned an error —', JSON.stringify(body.error).slice(0, 400))
    process.exit(1)
  }
  const tools = body.result?.tools ?? []
  console.log(`=== ${tools.length} tool(s) exposed ===`)
  for (const t of tools) {
    console.log(`  ${t.name ?? '(unnamed)'} — ${(t.description ?? '').slice(0, 110)}`)
  }

  const names = tools.map((t) => (t.name ?? '').toLowerCase())
  console.log(`\n=== Gap vs our SupplierAdapter (heuristic name/description match — read the list above yourself too) ===`)
  for (const [group, methods] of Object.entries(ADAPTER_SURFACE)) {
    console.log(`\n${group}`)
    for (const method of methods) {
      // crude token overlap: 'getVariantStock' -> ['variant','stock']
      const parts = method
        .replace(/^get|^open|^place|^confirm|^pay|^quote|^search|^verify|^parse|^subscribe|^unsubscribe/, '')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(' ')
        .filter(Boolean)
      const hit = tools.find((t) => {
        const hay = `${t.name ?? ''} ${t.description ?? ''}`.toLowerCase()
        return parts.every((p) => hay.includes(p))
      })
      console.log(`  ${hit ? '✓' : '✗'} ${method}${hit ? ` → ${hit.name}` : ''}`)
    }
  }
  void names

  // --deep: CALL a handful of strictly READ-ONLY tools to answer the three questions the tool
  // list alone can't (2026-09-03 analysis): (1) does catalog search filter/report US warehouses,
  // (2) does catalog detail carry per-variant stock BEFORE a product is linked — our Stage 6 gate
  // needs verified US stock before listing — and (3) what shape does the shipping estimate take
  // (price only, or price + day range, which our delivery-window gate needs). Also lists connected
  // stores, because Zendrop pulling orders from a store we ALSO fulfil via CJ is the one integration
  // risk that could double-ship a real customer order.
  if (!process.argv.includes('--deep')) {
    console.log(
      `\nprobe-zendrop: done. Re-run with --deep to call the read-only catalog/store tools and\n` +
        `capture their response shapes (nothing is imported, ordered, or charged).`,
    )
  } else {
    const preview = (label: string, value: unknown): void => {
      const text = JSON.stringify(value, null, 1) ?? 'undefined'
      console.log(`\n--- ${label} ---\n${text.slice(0, 2600)}${text.length > 2600 ? '\n…(truncated)' : ''}`)
    }
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      const body = (await rpc('tools/call', { name, arguments: args })) as {
        result?: { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown; isError?: boolean }
        error?: unknown
      }
      if (body.error) return { ERROR: body.error }
      if (body.result?.structuredContent) return body.result.structuredContent
      const text = body.result?.content?.find((c) => c.type === 'text')?.text
      if (!text) return body.result
      try {
        return JSON.parse(text) as unknown
      } catch {
        return text
      }
    }

    console.log('\n\n================ DEEP PROBE (read-only) ================')

    const stores = await call('get_stores', {})
    preview('get_stores — which stores Zendrop can pull orders from (double-fulfilment risk check)', stores)

    const search = await call('get_catalog_products', { keyword: 'dog harness', limit: 3 })
    preview('get_catalog_products keyword="dog harness" — does a result carry warehouse / ship-from / stock?', search)

    // Pull an id out of whatever shape the search returned, without assuming the field name.
    const idMatch = JSON.stringify(search).match(/"(?:id|product_id|productId)"\s*:\s*"?([\w-]{4,})"?/)
    const productId = idMatch?.[1]
    if (productId) {
      const detail = await call('get_catalog_product', { product_id: productId, id: productId })
      preview(`get_catalog_product id=${productId} — per-variant stock + warehouse country BEFORE linking?`, detail)

      const ship = await call('get_catalog_shipping_estimate', {
        product_id: productId,
        id: productId,
        country: 'US',
        destination_country: 'US',
      })
      preview('get_catalog_shipping_estimate → US — price only, or price + delivery days?', ship)
    } else {
      console.log('\n(no product id found in the search response — paste the search output and I will adapt)')
    }

    const trending = await call('get_catalog_trending_products', { limit: 3 })
    preview('get_catalog_trending_products — supplier-native demand signal for the keyword system', trending)

    console.log(
      `\nprobe-zendrop: deep probe done. Paste everything above — these shapes decide the adapter\n` +
        `spec (and become its test fixtures, per the house "fixtures are authoritative" rule).`,
    )
  }
} catch (err) {
  console.error('probe-zendrop: FAILED —', err instanceof Error ? err.message.slice(0, 400) : String(err))
  process.exit(1)
}
