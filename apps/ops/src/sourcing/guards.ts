export const EXCLUDED_CATEGORY_TERMS = [
  'supplement', 'vitamin', 'cbd', 'hemp', 'flea', 'tick', 'dewormer', 'medicated',
  'medicine', 'antibiotic', 'pharmaceutical', 'treat', 'treats', 'food', 'edible',
  'chew', 'consumable', 'calming', 'anxiety', 'probiotic', 'oil drops',
] as const

export const CLAIM_TERMS = [
  'cures', 'cure ', 'treats ', 'treatment', 'heals', 'therapeutic', 'anxiety relief',
  'vet approved', 'vet recommended', 'fda', 'clinically proven', 'medical grade',
  'pain relief', 'antibacterial', 'antimicrobial', 'hypoallergenic',
] as const

/**
 * Case-insensitive substring match over the given text fields. Returns the matched term or null.
 * Returns the first matched term in EXCLUDED_CATEGORY_TERMS array order on overlaps (e.g., text 'treats' reports 'treat' if 'treat' comes first).
 */
export function matchExcludedCategory(...texts: (string | null | undefined)[]): string | null {
  const combinedText = texts
    .filter((t) => t != null)
    .join(' ')
    .toLowerCase()

  for (const term of EXCLUDED_CATEGORY_TERMS) {
    if (combinedText.includes(term)) {
      return term
    }
  }

  return null
}

/** Case-insensitive scan for disallowed claim phrases. Returns every matched term (empty = clean). */
export function findClaimViolations(...texts: (string | null | undefined)[]): string[] {
  const combinedText = texts
    .filter((t) => t != null)
    .join(' ')
    .toLowerCase()

  const violations: string[] = []
  for (const term of CLAIM_TERMS) {
    if (combinedText.includes(term)) {
      violations.push(term)
    }
  }

  return violations
}

/** Strips tags/entities to plain text for guard scans (no sanitizing — scanning only). */
export function htmlToText(html: string): string {
  // Strip all tags
  let text = html.replace(/<[^>]*>/g, ' ')

  // Decode the 6 entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')

  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim()

  return text
}

/** Normalize HTML for scheme detection: decode entities (single-pass, matching browser semantics). */
function normalizeForSchemeDetection(html: string): string {
  let normalized = html

  // Decode numeric entities (decimal) — single-pass by design, so &amp;#106; stays inert as text
  normalized = normalized.replace(/&#(\d+);/g, (_, d) => {
    const codePoint = Number(d)
    // Regex \d+ guarantees parseable input; codepoint validation guards against huge values
    if (codePoint < 0 || codePoint > 0x10ffff) {
      return ''
    }
    return String.fromCharCode(codePoint)
  })

  // Decode numeric entities (hex) — single-pass by design
  normalized = normalized.replace(/&#x([0-9a-f]+);/gi, (_, h) => {
    const codePoint = parseInt(h, 16)
    if (codePoint < 0 || codePoint > 0x10ffff) {
      return ''
    }
    return String.fromCharCode(codePoint)
  })

  // Decode the 6 named entities — single-pass by design
  normalized = normalized
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')

  // Strip Unicode format characters (defense-in-depth: defeats zero-width spaces like U+200B)
  // This only touches the throwaway normalized string used for scheme detection
  normalized = normalized.replace(/\p{Cf}/gu, '')

  return normalized
}

/** Allowlist validator per spec §Stage 4.3. Returns null when valid, else a human-readable reason. */
export function validateDescriptionHtml(html: string): string | null {
  // Check for javascript: or data: anywhere (case-insensitive, literal, with word boundaries)
  // \b prevents compound words like "metadata:" from matching "data:"
  if (/\bjavascript:|\bdata:/i.test(html)) {
    return 'HTML contains javascript: or data: URLs'
  }

  // Check for javascript: or data: via encoded entities, with targeted whitespace tolerance
  const normalized = normalizeForSchemeDetection(html)
  // javascript with whitespace tolerance between letters (catches java\nscript:, &#106;avascript:, etc)
  // This letter sequence is never innocent in dog-product copy
  // Word boundary prevents compound words like "javascript" substring in other contexts
  if (/\bj\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/i.test(normalized)) {
    return 'HTML contains encoded or whitespace-obfuscated javascript: URLs'
  }
  // data contiguous only — a space before the colon means it's prose ("data : verified"), not a scheme
  // Word boundary prevents compound words like "metadata:" or "userdata:" from matching
  if (/\bdata:/i.test(normalized)) {
    return 'HTML contains encoded or whitespace-obfuscated data: URLs'
  }

  // Allowed tags
  const allowedTags = new Set(['p', 'br', 'ul', 'ol', 'li', 'strong', 'em', 'h2', 'h3'])

  // Regex to find all tags: group 1 = tag name, group 2 = attributes
  const tagRegex = /<\s*\/?\s*([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g
  let match

  while ((match = tagRegex.exec(html)) !== null) {
    const tagName = (match[1] ?? '').toLowerCase()
    const attributes = match[2] ?? ''

    // Check if tag is in allowlist
    if (!allowedTags.has(tagName)) {
      return `Tag <${tagName}> is not allowed`
    }

    // Check if there are any attributes (after trimming trailing slash)
    const trimmedAttrs = attributes.replace(/\/$/, '').trim()
    if (trimmedAttrs !== '') {
      return `Tag <${tagName}> has attributes which are not allowed`
    }
  }

  // Check for unclosed/malformed tags in residue (after removing all well-formed tags)
  const residue = html.replace(tagRegex, '')
  // Reject any < in residue that is NOT followed by whitespace, digit, or another <
  // Also reject bare < at end of string
  if (/<(?=[^\s\d<]|$)/.test(residue)) {
    return 'Malformed or unclosed markup'
  }

  return null
}
