/** Minimal shape of a Gmail API MIME part — enough to walk the tree. */
interface MimePart {
  mimeType?: string
  body?: { data?: string; attachmentId?: string; size?: number }
  parts?: MimePart[]
}

function isMimePart(value: unknown): value is MimePart {
  return typeof value === 'object' && value !== null
}

/**
 * Depth-first search for the first leaf part whose mimeType matches and whose
 * body carries inline `data`. A part carrying only an `attachmentId` (no
 * `data`) is never a match — attachments are skipped entirely, not just
 * de-prioritized.
 */
function findFirstLeaf(node: MimePart, mimeType: string): MimePart | null {
  if (Array.isArray(node.parts) && node.parts.length > 0) {
    for (const child of node.parts) {
      if (!isMimePart(child)) continue
      const found = findFirstLeaf(child, mimeType)
      if (found) return found
    }
    return null
  }

  // Leaf node (no sub-parts).
  if (node.body?.attachmentId && !node.body.data) return null // attachment-only — skip
  if (node.mimeType === mimeType && typeof node.body?.data === 'string' && node.body.data.length > 0) {
    return node
  }
  return null
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8')
}

function decodeEntities(text: string): string {
  // &amp; MUST be decoded last so an already-escaped "&amp;lt;" (literal
  // text "&lt;") doesn't get double-unescaped into "<".
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

function stripHtml(html: string): string {
  const withoutStyle = html.replace(/<style[\s\S]*?<\/style>/gi, '')
  const withoutTags = withoutStyle.replace(/<[^>]+>/g, ' ')
  const collapsed = withoutTags.replace(/\s+/g, ' ').trim()
  return decodeEntities(collapsed)
}

/**
 * Extract the best available plain-text body from a Gmail API message
 * `payload`, per the priority order:
 *   1. first `text/plain` leaf with `body.data` (depth-first)
 *   2. else first `text/html` leaf with `body.data`, tag-stripped
 *   3. else the top-level `payload.body.data` (single-part messages)
 *   4. else null
 * Parts carrying only an `attachmentId` are ignored at every level.
 */
export function extractBodyText(payload: unknown): string | null {
  if (!isMimePart(payload)) return null

  const plainLeaf = findFirstLeaf(payload, 'text/plain')
  if (plainLeaf?.body?.data) return decodeBase64Url(plainLeaf.body.data)

  const htmlLeaf = findFirstLeaf(payload, 'text/html')
  if (htmlLeaf?.body?.data) return stripHtml(decodeBase64Url(htmlLeaf.body.data))

  if (typeof payload.body?.data === 'string' && payload.body.data.length > 0) {
    return decodeBase64Url(payload.body.data)
  }

  return null
}
