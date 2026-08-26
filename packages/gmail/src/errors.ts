export class GmailApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public reason: string | null,
  ) {
    super(message)
    this.name = 'GmailApiError'
  }
}

export class HistoryExpiredError extends Error {
  constructor(message: string = 'History ID is no longer valid') {
    super(message)
    this.name = 'HistoryExpiredError'
  }
}

export class MessageGoneError extends Error {
  constructor(message: string = 'Message no longer exists') {
    super(message)
    this.name = 'MessageGoneError'
  }
}

export class GmailRateLimitError extends Error {
  constructor(message: string = 'Rate limit exceeded') {
    super(message)
    this.name = 'GmailRateLimitError'
  }
}

export function isHistoryExpired(e: unknown): e is HistoryExpiredError {
  return e instanceof HistoryExpiredError
}

export function isMessageGone(e: unknown): e is MessageGoneError {
  return e instanceof MessageGoneError
}
