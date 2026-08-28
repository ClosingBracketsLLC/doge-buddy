import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { agentSessionEntries, type createDb } from '@doge-buddy/db'
import { and, asc, eq, ne, sql } from 'drizzle-orm'

type Db = ReturnType<typeof createDb>['db']

export const SUPPORT_PROJECT_KEY = 'doge-buddy-support'

const REPLACEMENT_CHAR = '�'

// Built via String.fromCharCode rather than string-literal escapes, both to keep this source file
// free of an actual NUL byte and to avoid embedding literal lone-surrogate code units directly in a
// UTF-8 file (which isn't representable as valid UTF-8 at all).
const NUL_CHAR = String.fromCharCode(0x0000)
const HIGH_SURROGATE_START = String.fromCharCode(0xd800)
const HIGH_SURROGATE_END = String.fromCharCode(0xdbff)
const LOW_SURROGATE_START = String.fromCharCode(0xdc00)
const LOW_SURROGATE_END = String.fromCharCode(0xdfff)

// Postgres's jsonb input parser rejects two kinds of otherwise-valid JSON: a literal NUL-byte
// escape (SQLSTATE 22P05, "unsupported Unicode escape sequence") and an unpaired UTF-16 surrogate
// escape (SQLSTATE 22P02, "Unicode low/high surrogate must follow/be followed by ..."). Both are
// completely ordinary, legal JS string content -- a raw NUL character, or a lone high/low surrogate
// left over from e.g. a tool output truncated mid-emoji or read with the wrong encoding -- and
// JSON.stringify passes them through as valid escape sequences without complaint.
//
// This scrub therefore runs at the *value* level, before JSON.stringify ever sees the entry, rather
// than pattern-matching the serialized JSON text afterward. Working on the serialized text is
// fragile: JSON.stringify doubles any backslash already present in the string content, so a scrub
// regex would have to correctly count the length of the backslash run immediately preceding a
// "u0000"-shaped substring to tell a genuine escape (odd-length run) from an escaped backslash
// followed by ordinary "u0000" text (even-length run) -- getting that wrong either lets a genuine
// NUL escape survive (when a content backslash sits right before it, e.g. a Windows path like
// "C:\" + NUL + "temp") or corrupts legitimate text that merely resembles an escape. Scrubbing the
// raw string values sidesteps the whole question: there is no backslash-counting to get wrong when
// you're looking at the actual character, not its escaped rendering.
const BAD_CHAR_RE = new RegExp(
  `${NUL_CHAR}` +
    `|[${HIGH_SURROGATE_START}-${HIGH_SURROGATE_END}](?![${LOW_SURROGATE_START}-${LOW_SURROGATE_END}])` +
    `|(?<![${HIGH_SURROGATE_START}-${HIGH_SURROGATE_END}])[${LOW_SURROGATE_START}-${LOW_SURROGATE_END}]`,
  'g',
)

function scrubString(value: string): string {
  return value.replace(BAD_CHAR_RE, REPLACEMENT_CHAR)
}

// Recursively rebuilds `value`, scrubbing every string it finds (both object keys and values) and
// leaving every other type (numbers, booleans, null, undefined) untouched. Entries are documented as
// "JSON-safe POJOs" by the SDK, so a structural walk over plain objects/arrays/primitives is all
// that's needed -- no Date/Map/Set/etc. handling.
function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubString(value)
  if (Array.isArray(value)) return value.map(scrubValue)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[scrubString(k)] = scrubValue(v)
    }
    return out
  }
  return value
}

function nulScrub(entry: SessionStoreEntry): SessionStoreEntry {
  return scrubValue(entry) as SessionStoreEntry
}

function toSubpath(subpath: string | undefined): string {
  return subpath ?? ''
}

/**
 * Postgres-backed adapter for the Claude Agent SDK's `SessionStore` (@alpha). Mirrors transcript
 * entries into `agent_session_entries` (Task 3's schema): one row per JSONL line, `uuid`-carrying
 * entries deduped via the table's partial unique index on `(session_id, subpath, uuid)` so batch
 * replays and `importSessionToStore()` retries never create duplicate rows.
 */
export function createPgSessionStore(db: Db): SessionStore {
  return {
    async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
      const projectKey = key.projectKey
      const sessionId = key.sessionId
      const subpath = toSubpath(key.subpath)

      // Sequential, not parallel: bigserial `seq` only assigns monotonically in call order when
      // inserts aren't racing each other, and `load()` relies on `seq` order to preserve the
      // entries array order this batch (and prior batches) were appended in.
      for (const entry of entries) {
        // Scrub FIRST, then read `uuid` off the scrubbed copy -- not the original `entry` -- so the
        // dedup key always matches what's actually stored in `entry` (jsonb). A NUL in the raw
        // `entry.uuid` would otherwise reach the `uuid` text column unscrubbed (SQLSTATE 22021) and
        // disagree with the sanitized copy sitting in the jsonb column next to it.
        const scrubbed = nulScrub(entry)
        const uuid = typeof scrubbed.uuid === 'string' ? scrubbed.uuid : null
        const insert = db.insert(agentSessionEntries).values({
          projectKey,
          sessionId,
          subpath,
          uuid,
          entry: scrubbed,
        })
        if (uuid !== null) {
          // NOTE: the arbiter index is (session_id, subpath, uuid) -- it does not include
          // project_key. Two different projectKeys sharing a sessionId would cross-dedupe against
          // each other. SUPPORT_PROJECT_KEY is the only writer today, so this is a deliberately
          // deferred gap, not an oversight -- do not "fix" it with a migration without confirming
          // multi-project usage is actually coming.
          await insert.onConflictDoNothing({
            target: [agentSessionEntries.sessionId, agentSessionEntries.subpath, agentSessionEntries.uuid],
            where: sql`${agentSessionEntries.uuid} IS NOT NULL`,
          })
        } else {
          await insert
        }
      }
    },

    async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
      const rows = await db
        .select({ entry: agentSessionEntries.entry })
        .from(agentSessionEntries)
        .where(
          and(
            eq(agentSessionEntries.projectKey, key.projectKey),
            eq(agentSessionEntries.sessionId, key.sessionId),
            eq(agentSessionEntries.subpath, toSubpath(key.subpath)),
          ),
        )
        .orderBy(asc(agentSessionEntries.seq))

      if (rows.length === 0) return null
      return rows.map((row) => row.entry as SessionStoreEntry)
    },

    async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
      const rows = await db
        .selectDistinct({ subpath: agentSessionEntries.subpath })
        .from(agentSessionEntries)
        .where(
          and(
            eq(agentSessionEntries.projectKey, key.projectKey),
            eq(agentSessionEntries.sessionId, key.sessionId),
            ne(agentSessionEntries.subpath, ''),
          ),
        )
      return rows.map((row) => row.subpath)
    },
  }
}
