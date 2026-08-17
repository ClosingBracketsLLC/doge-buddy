export class CjApiError extends Error {
  readonly code: number
  readonly requestId?: string

  constructor(code: number, message: string, requestId?: string) {
    super(message)
    this.name = 'CjApiError'
    this.code = code
    this.requestId = requestId
  }
}

export class CjPointsBudgetExceededError extends Error {
  constructor(message = 'CJ daily points budget exceeded') {
    super(message)
    this.name = 'CjPointsBudgetExceededError'
  }
}
