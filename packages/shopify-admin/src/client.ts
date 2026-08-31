import type { FetchLike, ShopifyTokenManager } from './token.ts'
import { ShopifyGraphqlError, ShopifyHttpError, ShopifyUserError, type ShopifyUserErrorEntry } from './errors.ts'

export interface ShopifyAdminClientOptions {
  shopDomain: string
  tokenManager: ShopifyTokenManager
  apiVersion?: string
  fetchImpl?: FetchLike
  sleep?: (ms: number) => Promise<void>
}

interface GraphqlErrorEntry {
  message?: string
  extensions?: { code?: string }
}

interface GraphqlResponseBody<T> {
  data?: T
  errors?: GraphqlErrorEntry[]
}

const DEFAULT_API_VERSION = '2026-07'
const MAX_THROTTLE_ATTEMPTS = 3
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
// Matches the operation header (leading whitespace, operation type, and everything up to —
// but not including — the opening `{` of the operation body) so the directive can be spliced
// in right before that brace.
const OPERATION_HEADER_PATTERN = /^(\s*)(query|mutation|subscription)([^{]*)\{/
/** `fieldName` or `fieldName(args…)` — the root selection right after the operation header (whose match already consumed the opening brace). */
const ROOT_FIELD_PATTERN = /^\s*[A-Za-z_]\w*(?:\s*\([^)]*\))?/

/**
 * Thin GraphQL client for the Shopify Admin API. Handles token attachment (via
 * ShopifyTokenManager), 401-triggered token invalidation + single retry, and THROTTLED-error
 * backoff/retry. Non-throttle GraphQL `errors` and non-2xx/non-401 HTTP responses fail fast.
 */
export class ShopifyAdminClient {
  private readonly shopDomain: string
  private readonly tokenManager: ShopifyTokenManager
  private readonly apiVersion: string
  private readonly fetchImpl: FetchLike
  private readonly sleep: (ms: number) => Promise<void>

  constructor(opts: ShopifyAdminClientOptions) {
    this.shopDomain = opts.shopDomain
    this.tokenManager = opts.tokenManager
    this.apiVersion = opts.apiVersion ?? DEFAULT_API_VERSION
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init))
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  async graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const url = `https://${this.shopDomain}/admin/api/${this.apiVersion}/graphql.json`
    let retriedAfter401 = false
    let throttleAttempt = 0

    for (;;) {
      const token = await this.tokenManager.getToken()
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token,
        },
        body: JSON.stringify({ query, variables }),
      })

      if (response.status === 401) {
        if (retriedAfter401) {
          throw new ShopifyHttpError(401)
        }
        retriedAfter401 = true
        this.tokenManager.invalidate()
        continue
      }

      if (!response.ok) {
        throw new ShopifyHttpError(response.status)
      }

      const json = (await response.json()) as GraphqlResponseBody<T>

      if (json.errors && json.errors.length > 0) {
        const allThrottled = json.errors.every((e) => e.extensions?.code === 'THROTTLED')
        if (allThrottled && throttleAttempt < MAX_THROTTLE_ATTEMPTS - 1) {
          await this.sleep(500 * 2 ** throttleAttempt)
          throttleAttempt += 1
          continue
        }
        throw new ShopifyGraphqlError(json.errors)
      }

      return json.data as T
    }
  }
}

/**
 * Throws ShopifyUserError when `payload[mutationField].userErrors` is a non-empty array.
 * A missing payload, missing mutation field, or missing/empty userErrors array is treated as
 * "no errors" rather than an assertion failure — callers only need to guard the happy path.
 */
export function assertNoUserErrors(payload: unknown, mutationField: string): void {
  if (payload === null || typeof payload !== 'object') return
  const field = (payload as Record<string, unknown>)[mutationField]
  if (field === null || typeof field !== 'object') return
  const userErrors = (field as Record<string, unknown>).userErrors
  if (!Array.isArray(userErrors) || userErrors.length === 0) return
  throw new ShopifyUserError(userErrors as ShopifyUserErrorEntry[], mutationField)
}

/**
 * Inserts an `@idempotent(key: "...")` directive on the ROOT MUTATION FIELD of a GraphQL document
 * (`mutation X($v: T) { field(args) @idempotent(key: "…") { … } }`). This is the ONLY place the
 * directive syntax lives.
 *
 * Placement is load-bearing and was settled against the LIVE 2026-07 Admin API (2026-08-30): on
 * the operation header Shopify answers `'@idempotent' can't be applied to mutations (allowed:
 * fields)`, and without it at all `The @idempotent directive is required for this mutation but was
 * not provided` — so every idempotent mutation (refundCreate, inventorySetQuantities) failed
 * validation until the directive moved onto the field. Mocked tests could not see this.
 */
export function withIdempotencyKey(document: string, key: string): string {
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new RangeError(`Invalid Shopify idempotency key: ${JSON.stringify(key)}`)
  }

  const header = OPERATION_HEADER_PATTERN.exec(document)
  if (!header) {
    throw new Error('withIdempotencyKey: could not locate an operation header in the given GraphQL document')
  }
  // The first field selection after the operation's opening brace: a name, optionally followed by
  // an argument list. Variable-only arguments never nest parentheses, so `\([^)]*\)` is exact here.
  const afterHeader = document.slice(header[0].length)
  const field = ROOT_FIELD_PATTERN.exec(afterHeader)
  if (!field) {
    throw new Error('withIdempotencyKey: could not locate the root mutation field in the given GraphQL document')
  }
  const fieldEnd = field.index + field[0].length
  return (
    document.slice(0, header[0].length) +
    afterHeader.slice(0, fieldEnd) +
    ` @idempotent(key: "${key}")` +
    afterHeader.slice(fieldEnd)
  )
}
