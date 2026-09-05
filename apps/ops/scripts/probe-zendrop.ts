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
  console.log(
    `\nprobe-zendrop: done. Paste this whole output to Claude — the ✗ rows in "must have" groups\n` +
      `decide whether an adapter is viable, or whether Zendrop stays a catalog-only lane.`,
  )
  void names
} catch (err) {
  console.error('probe-zendrop: FAILED —', err instanceof Error ? err.message.slice(0, 400) : String(err))
  process.exit(1)
}
