import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { agentSessionEntries, type createDb } from '@doge-buddy/db'
import { and, asc, eq, ne, sql } from 'drizzle-orm'

type Db = ReturnType<typeof createDb>['db']

export const SUPPORT_PROJECT_KEY = 'doge-buddy-support'

const REPLACEMENT_CHAR = '�'
// Built via String.fromCharCode rather than a string-literal escape so this source file never has
// to carry an actual NUL byte.
const RAW_NUL = String.fromCharCode(0)

// A NUL byte (U+0000) can never survive JSON.stringify as a raw byte in the output — it is always
// rendered as a Unicode escape (backslash, then "u0000"), which Postgres's jsonb input parser
// refuses ("unsupported Unicode escape sequence") because jsonb's text-backed storage can't
// represent an embedded NUL. So the scrub has to operate on the *serialized* JSON text, replacing
// that escape with a safe placeholder before the value ever reaches the driver. (The .replaceAll
// below for a raw NUL character is therefore purely defensive/vestigial against that fact, kept for
// belt-and-suspenders safety — the escape-sequence regex pass is the one doing real work.)
//
// A pre-existing single backslash in the *original* string is a different case: JSON.stringify
// always doubles a literal backslash character on serialization, so text that arrives already
// "pre-escaped" from some upstream layer (i.e. its actual content is a single backslash directly
// followed by "u0000", not a raw NUL byte) turns into a *doubled* backslash followed by "u0000" once
// serialized here — which is ordinary, harmless text to a JSON/jsonb parser, not an escape sequence.
// The negative lookbehind below excludes that doubled-backslash case so legitimate text merely
// resembling an escaped NUL is never misinterpreted (and corrupted).
const NUL_ESCAPE_RE = /(?<!\\)\\u0000/g

function nulScrub(entry: SessionStoreEntry): SessionStoreEntry {
  const json = JSON.stringify(entry)
    .replaceAll(RAW_NUL, REPLACEMENT_CHAR)
    .replace(NUL_ESCAPE_RE, REPLACEMENT_CHAR)
  return JSON.parse(json) as SessionStoreEntry
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
        const scrubbed = nulScrub(entry)
        const uuid = typeof entry.uuid === 'string' ? entry.uuid : null
        const insert = db.insert(agentSessionEntries).values({
          projectKey,
          sessionId,
          subpath,
          uuid,
          entry: scrubbed,
        })
        if (uuid !== null) {
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
