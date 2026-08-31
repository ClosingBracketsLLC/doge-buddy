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
  /** Extra header lines appended after the standard set. Name validated `/^[A-Za-z0-9-]+$/`
   * (throws on an invalid name); value sanitized like every other field (CR/LF stripped) to
   * prevent header injection. */
  extraHeaders?: Record<string, string>
}

/**
 * Sanitizes a header field value by removing/collapsing line breaks.
 * Strips \r and \n characters (header injection prevention).
 */
function sanitizeHeaderField(value: string): string {
  // Replace all CR and LF with spaces
  return value.replace(/[\r\n]/g, ' ')
}

const EXTRA_HEADER_NAME_RE = /^[A-Za-z0-9-]+$/

/** Validates an extra header's field name — anything outside token chars could otherwise be used
 * to smuggle a colon/line-break-adjacent header name. Shared by BOTH builders, so the message is
 * builder-neutral (`rfc2822:`) rather than naming `buildReplyRaw` at a `buildNewRaw` call site. */
function validateExtraHeaderName(name: string): void {
  if (!EXTRA_HEADER_NAME_RE.test(name)) {
    throw new Error(`rfc2822: invalid extra header name "${name}"`)
  }
}

const RFC2047_PREFIX = '=?UTF-8?B?'
const RFC2047_SUFFIX = '?='
const RFC2047_MAX_WORD_LEN = 75
/** Base64 output length is always a multiple of 4. The largest multiple of 4 that fits within the
 * remaining budget (75 - prefix - suffix = 63) is 60, and 60/4*3 = 45 bytes encodes to exactly 60
 * base64 chars with no padding ambiguity — comfortably under the 63-char ceiling. */
const RFC2047_MAX_BYTES_PER_CHUNK = 45

/**
 * Splits `text` into chunks, each holding at most `maxBytesPerChunk` UTF-8 bytes, without ever
 * splitting a Unicode code point across chunks (iterates by code point via `for...of`, which is
 * surrogate-pair aware).
 */
function chunkUtf8ByCodepoints(text: string, maxBytesPerChunk: number): string[] {
  const chunks: string[] = []
  let current = ''
  let currentBytes = 0

  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, 'utf8')
    if (current.length > 0 && currentBytes + chBytes > maxBytesPerChunk) {
      chunks.push(current)
      current = ''
      currentBytes = 0
    }
    current += ch
    currentBytes += chBytes
  }
  if (current.length > 0) chunks.push(current)

  return chunks
}

/**
 * Encodes a string as RFC 2047 (MIME encoded-word) if it contains non-ASCII characters.
 * Otherwise returns the string as-is. Long non-ASCII subjects fold into multiple encoded-words,
 * each independently decodable (max RFC2047_MAX_WORD_LEN chars including the =?UTF-8?B?...?=
 * wrapper), joined by CRLF + a single space per RFC 2822 header-folding syntax.
 */
function encodeSubjectIfNeeded(subject: string): string {
  // Check if subject contains only ASCII characters (after sanitization)
  const isAscii = /^[\x00-\x7F]*$/.test(subject)
  if (isAscii) {
    return subject
  }

  const chunks = chunkUtf8ByCodepoints(subject, RFC2047_MAX_BYTES_PER_CHUNK)
  const words = chunks.map((chunk) => {
    const base64 = Buffer.from(chunk, 'utf-8').toString('base64')
    const word = `${RFC2047_PREFIX}${base64}${RFC2047_SUFFIX}`
    // Sanity check — should be unreachable given RFC2047_MAX_BYTES_PER_CHUNK's math above.
    if (word.length > RFC2047_MAX_WORD_LEN) {
      throw new Error(`rfc2822: encoded-word exceeded ${RFC2047_MAX_WORD_LEN} chars`)
    }
    return word
  })

  return words.join('\r\n ')
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

const QP_LINE_LIMIT = 76

/** Encodes a single byte for quoted-printable output. Space/tab are left literal by default —
 * the caller re-escapes them when they're the trailing byte of a line, since trailing whitespace
 * can be stripped in transit. */
function qpEncodeByte(byte: number): string {
  if (byte === 0x09 || byte === 0x20) return String.fromCharCode(byte)
  if (byte === 0x3d || byte < 0x20 || byte > 0x7e) {
    return `=${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return String.fromCharCode(byte)
}

/** Encodes one Unicode code point's UTF-8 bytes as a run of quoted-printable tokens (each token
 * is either a single literal ASCII char or a 3-char "=XX" escape) — never split mid-token, so a
 * multi-byte character's escapes always land together (though a soft break may still fall between
 * two of a character's own byte-escapes; a QP decoder resolves soft breaks before hex escapes, so
 * that's harmless). */
function qpTokensForChar(ch: string): string[] {
  return [...Buffer.from(ch, 'utf8')].map(qpEncodeByte)
}

/**
 * RFC 2045 §6.7 quoted-printable encoder. Encodes non-ASCII/non-printable bytes (and a literal
 * '=') as =XX uppercase hex, escapes a trailing space/tab at a line's end (hard break or end of
 * body) so it survives transport, and soft-wraps any encoded line at QP_LINE_LIMIT chars with a
 * `=\r\n` break. Existing \r\n / \n line breaks in the source pass through unchanged as hard
 * breaks — encoding fully-ASCII text with no long lines round-trips byte-for-byte.
 */
function encodeQuotedPrintable(text: string): string {
  // Alternating [content, terminator, content, terminator, ..., content] — terminator is
  // undefined for the final segment (may or may not end in a line break).
  const segments = text.split(/(\r\n|\n)/)

  let out = ''
  let lineLen = 0

  const emit = (token: string): void => {
    if (lineLen + token.length > QP_LINE_LIMIT - 1) {
      out += '=\r\n'
      lineLen = 0
    }
    out += token
    lineLen += token.length
  }

  for (let i = 0; i < segments.length; i += 2) {
    const content = segments[i] ?? ''
    const terminator = segments[i + 1]

    const chars = Array.from(content)
    const tokens = chars.map(qpTokensForChar)

    // Trailing space/tab must be escaped so it survives transport, whether the line ends in a
    // hard break or at the very end of the body.
    const lastCh = chars[chars.length - 1]
    if (lastCh === ' ' || lastCh === '\t') {
      tokens[tokens.length - 1] = [lastCh === ' ' ? '=20' : '=09']
    }

    for (const charTokens of tokens) {
      for (const token of charTokens) emit(token)
    }

    if (terminator !== undefined) {
      out += terminator
      lineLen = 0
    }
  }

  return out
}

/**
 * Builds a base64url-encoded RFC 2822 message for replying.
 * Headers use CRLF line endings; body preserves caller's line endings (quoted-printable soft
 * breaks aside). All header fields are sanitized to prevent header injection.
 */
export function buildReplyRaw(input: BuildReplyRawInput): string {
  const { from, to, subject, inReplyTo, references, bodyText, extraHeaders } = input

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
  const headerLines = [
    `From: ${cleanFrom}`,
    `To: ${cleanTo}`,
    `Subject: ${encodedSubject}`,
    `In-Reply-To: ${cleanInReplyTo}`,
    `References: ${cleanReferences}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: quoted-printable',
  ]

  if (extraHeaders) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      validateExtraHeaderName(name)
      headerLines.push(`${name}: ${sanitizeHeaderField(value)}`)
    }
  }

  return assembleRaw(headerLines, bodyText)
}

export interface BuildNewRawInput {
  from: string
  to: string
  subject: string
  /** RFC 5322 `<local@domain>` — supplied by the caller so a retried send can be FOUND
   * (`rfc822msgid:` search) instead of duplicated. */
  messageId: string
  bodyText: string
  extraHeaders?: Record<string, string>
}

const MESSAGE_ID_RE = /^<[^<>\s@]+@[^<>\s@]+>$/

/** Shared tail of both builders: CRLF headers + blank line + quoted-printable body → base64url. */
function assembleRaw(headerLines: string[], bodyText: string): string {
  const headers = headerLines.join('\r\n')
  const fullMessage = `${headers}\r\n\r\n${encodeQuotedPrintable(bodyText)}`
  const base64 = Buffer.from(fullMessage, 'utf-8').toString('base64')
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/**
 * A NEW-thread message (no In-Reply-To/References, no `Re:`) with an explicit Message-ID — the
 * contact-form acknowledgement. Same sanitizing/encoding as `buildReplyRaw`.
 */
export function buildNewRaw(input: BuildNewRawInput): string {
  const { from, to, subject, messageId, bodyText, extraHeaders } = input
  if (!MESSAGE_ID_RE.test(messageId)) {
    throw new Error(`buildNewRaw: Message-ID must be <local@domain>, got "${messageId}"`)
  }
  const headerLines = [
    `From: ${sanitizeHeaderField(from)}`,
    `To: ${sanitizeHeaderField(to)}`,
    `Subject: ${encodeSubjectIfNeeded(sanitizeHeaderField(subject))}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: quoted-printable',
  ]
  if (extraHeaders) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      validateExtraHeaderName(name)
      headerLines.push(`${name}: ${sanitizeHeaderField(value)}`)
    }
  }
  return assembleRaw(headerLines, bodyText)
}
