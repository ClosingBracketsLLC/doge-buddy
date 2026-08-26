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
 * Encodes a string as RFC 2047 (MIME encoded-word) if it contains non-ASCII characters.
 * Otherwise returns the string as-is.
 */
function encodeSubjectIfNeeded(subject: string): string {
  // Check if subject contains only ASCII characters
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
 */
export function buildReplyRaw(input: BuildReplyRawInput): string {
  const { from, to, subject, inReplyTo, references, bodyText } = input

  // Process subject: add Re: prefix if needed, then RFC 2047 encode if non-ASCII
  const prefixedSubject = addRePrefix(subject)
  const encodedSubject = encodeSubjectIfNeeded(prefixedSubject)

  // Build headers with CRLF line endings
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${references}`,
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
