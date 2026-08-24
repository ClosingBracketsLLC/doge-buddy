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

/** Case-insensitive substring match over the given text fields. Returns the matched term or null. */
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

/** Allowlist validator per spec §Stage 4.3. Returns null when valid, else a human-readable reason. */
export function validateDescriptionHtml(html: string): string | null {
  // Check for javascript: or data: anywhere (case-insensitive)
  if (/javascript:|data:/i.test(html)) {
    return 'HTML contains javascript: or data: URLs'
  }

  // Allowed tags
  const allowedTags = new Set(['p', 'br', 'ul', 'ol', 'li', 'strong', 'em', 'h2', 'h3'])

  // Regex to find all tags: group 1 = tag name, group 2 = attributes
  const tagRegex = /<\s*\/?\s*([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g
  let match

  while ((match = tagRegex.exec(html)) !== null) {
    const tagName = match[1].toLowerCase()
    const attributes = match[2]

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

  return null
}
