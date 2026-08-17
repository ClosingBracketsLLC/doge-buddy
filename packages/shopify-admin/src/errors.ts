export class ShopifyGraphqlError extends Error {
  readonly errors: unknown[]

  constructor(errors: unknown[], message = 'Shopify GraphQL request returned errors') {
    super(message)
    this.name = 'ShopifyGraphqlError'
    this.errors = errors
  }
}

export interface ShopifyUserErrorEntry {
  field?: string[] | null
  message: string
}

export class ShopifyUserError extends Error {
  readonly userErrors: ShopifyUserErrorEntry[]

  constructor(userErrors: ShopifyUserErrorEntry[], mutationField: string) {
    super(`Shopify mutation ${mutationField} returned userErrors: ${userErrors.map((e) => e.message).join('; ')}`)
    this.name = 'ShopifyUserError'
    this.userErrors = userErrors
  }
}

export class ShopifyHttpError extends Error {
  readonly status: number

  constructor(status: number, message = `Shopify API HTTP error ${status}`) {
    super(message)
    this.name = 'ShopifyHttpError'
    this.status = status
  }
}
