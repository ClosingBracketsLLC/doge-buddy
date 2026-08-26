/**
 * RFC 2822 reply message builder with From-stamping support.
 */

export interface BuildReplyRawInput {
  from: string
  to: string
  subject: string
  inReplyTo: string
  references: string
  bodyText: string
}

/**
 * Sanitizes a header field value by removing/collapsing line breaks.
 * Strips \r and \n characters (header injection prevention).
 */
function sanitizeHeaderField(value: string): string {
  // Replace all CR and LF with spaces
  return value.replace(/[\r\n]/g, ' ')
}

/**
 * Encodes a string as RFC 2047 (MIME encoded-word) if it contains non-ASCII characters.
 * Otherwise returns the string as-is.
 */
function encodeSubjectIfNeeded(subject: string): string {
  // Check if subject contains only ASCII characters (after sanitization)
  const isAscii = /^[\x00-\x7F]*$/.test(subject)
  if (isAscii) {
    return subject
  }

  // Encode as =?UTF-8?B?<base64>?=
  const utf8Bytes = Buffer.from(subject, 'utf-8')
  const base64 = utf8Bytes.toString('base64')
  return `=?UTF-8?B?${base64}?=`
}

/**
 * Adds "Re: " prefix to subject if not already present (case-insensitive check).
 */
function addRePrefix(subject: string): string {
  if (subject.toLowerCase().startsWith('re:')) {
    return subject
  }
  return `Re: ${subject}`
}

/**
 * Builds a base64url-encoded RFC 2822 message for replying.
 * Headers use CRLF line endings; body preserves caller's line endings.
 * All header fields are sanitized to prevent header injection.
 */
export function buildReplyRaw(input: BuildReplyRawInput): string {
  const { from, to, subject, inReplyTo, references, bodyText } = input

  // Sanitize all header fields to prevent injection (strip CR/LF)
  const cleanFrom = sanitizeHeaderField(from)
  const cleanTo = sanitizeHeaderField(to)
  const cleanInReplyTo = sanitizeHeaderField(inReplyTo)
  const cleanReferences = sanitizeHeaderField(references)
  let cleanSubject = sanitizeHeaderField(subject)

  // Process subject: add Re: prefix if needed, then RFC 2047 encode if non-ASCII
  const prefixedSubject = addRePrefix(cleanSubject)
  const encodedSubject = encodeSubjectIfNeeded(prefixedSubject)

  // Build headers with CRLF line endings
  const headers = [
    `From: ${cleanFrom}`,
    `To: ${cleanTo}`,
    `Subject: ${encodedSubject}`,
    `In-Reply-To: ${cleanInReplyTo}`,
    `References: ${cleanReferences}`,
    'Content-Type: text/plain; charset="UTF-8"',
  ].join('\r\n')

  // Full message: headers + blank line separator + body
  // Blank line separator is CRLF\r\n (two CRLFs)
  const fullMessage = `${headers}\r\n\r\n${bodyText}`

  // Encode to base64url (no padding, using - and _ instead of + and /)
  const base64 = Buffer.from(fullMessage, 'utf-8').toString('base64')
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

  return base64url
}
