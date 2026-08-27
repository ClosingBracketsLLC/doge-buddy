import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { agentSessionEntries, createDb } from '@doge-buddy/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPgSessionStore, SUPPORT_PROJECT_KEY } from '../src/agents/session-store.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

// Built via String.fromCharCode rather than string-literal escapes so the source file never has to
// carry an actual NUL byte, nor a hand-typed backslash-escape look-alike that tooling could mangle,
// nor a literal lone-surrogate code unit (which isn't representable as valid UTF-8 in a source file).
const NUL = String.fromCharCode(0)
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd)
const BACKSLASH = String.fromCharCode(0x5c)
const LONE_HIGH_SURROGATE = String.fromCharCode(0xd800)
const LONE_LOW_SURROGATE = String.fromCharCode(0xdc00)
// A valid surrogate pair (an emoji, U+1F600) -- used as a regression check that the scrub never
// touches a properly paired surrogate.
const EMOJI = String.fromCharCode(0xd83d) + String.fromCharCode(0xde00)

describe('session-store', () => {
  const { db, pool } = createDb(url)

  beforeEach(async () => {
    await db.delete(agentSessionEntries)
  })
  afterAll(() => pool.end())

  const key = { projectKey: SUPPORT_PROJECT_KEY, sessionId: 'sess-1' }

  it('round-trips a batch of entries through append/load with deep equality (JSONB key reordering tolerated)', async () => {
    const store = createPgSessionStore(db)
    const entries: SessionStoreEntry[] = [
      { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', uuid: 'u2', message: { nested: { b: 2, a: 1 } } },
    ]
    await store.append(key, entries)
    const loaded = await store.load(key)
    expect(loaded).toEqual(entries)
  })

  it('replaying the same uuid-carrying batch twice yields no duplicate rows', async () => {
    const store = createPgSessionStore(db)
    const entries: SessionStoreEntry[] = [
      { type: 'user', uuid: 'dup-1', text: 'hello' },
      { type: 'assistant', uuid: 'dup-2', text: 'world' },
    ]
    await store.append(key, entries)
    await store.append(key, entries)
    const loaded = await store.load(key)
    expect(loaded).toHaveLength(2)
    expect(loaded).toEqual(entries)
  })

  it('entries without uuid append twice results in two rows each', async () => {
    const store = createPgSessionStore(db)
    const entries: SessionStoreEntry[] = [{ type: 'title', text: 'my session' }]
    await store.append(key, entries)
    await store.append(key, entries)
    const loaded = await store.load(key)
    expect(loaded).toHaveLength(2)
    expect(loaded).toEqual([entries[0], entries[0]])
  })

  it('load of a never-written key returns null, not []', async () => {
    const store = createPgSessionStore(db)
    const loaded = await store.load({ projectKey: SUPPORT_PROJECT_KEY, sessionId: 'never-written' })
    expect(loaded).toBeNull()
  })

  it('isolates entries by subpath and listSubkeys returns only non-empty subpaths', async () => {
    const store = createPgSessionStore(db)
    await store.append({ ...key, subpath: undefined }, [{ type: 'user', uuid: 'main-1', text: 'main' }])
    await store.append({ ...key, subpath: 'subagents/x' }, [{ type: 'user', uuid: 'sub-1', text: 'sub' }])

    const main = await store.load(key)
    const sub = await store.load({ ...key, subpath: 'subagents/x' })
    expect(main).toEqual([{ type: 'user', uuid: 'main-1', text: 'main' }])
    expect(sub).toEqual([{ type: 'user', uuid: 'sub-1', text: 'sub' }])

    const subkeys = await store.listSubkeys!({ projectKey: key.projectKey, sessionId: key.sessionId })
    expect(subkeys).toEqual(['subagents/x'])
  })

  it('preserves append call order across a single batch when loaded back', async () => {
    const store = createPgSessionStore(db)
    const entries: SessionStoreEntry[] = [
      { type: 'user', uuid: 'o1', n: 1 },
      { type: 'user', uuid: 'o2', n: 2 },
      { type: 'user', uuid: 'o3', n: 3 },
    ]
    await store.append(key, entries)
    const loaded = await store.load(key)
    expect(loaded!.map((e) => e.n)).toEqual([1, 2, 3])
  })

  it('scrubs a raw NUL byte in entry text so the insert succeeds and loads with the replacement char', async () => {
    const store = createPgSessionStore(db)
    const entries: SessionStoreEntry[] = [{ type: 'user', uuid: 'nul-1', text: `a${NUL}b` }]
    await store.append(key, entries)
    const loaded = await store.load(key)
    expect(loaded).toHaveLength(1)
    expect(loaded![0]!.text).toBe(`a${REPLACEMENT_CHAR}b`)
  })

  it('inserts an entry whose text already contains a pre-escaped NUL sequence (backslash + u0000 as literal text, not a raw NUL byte) without corrupting it', async () => {
    const store = createPgSessionStore(db)
    // Simulates an upstream layer that already turned a NUL into escape text instead of leaving it
    // as a raw control character. This is legitimate literal text once properly JSON-escaped (the
    // backslash gets doubled by JSON.stringify), so it must round-trip unchanged rather than crash
    // or get corrupted.
    const preEscaped = `a${BACKSLASH}u0000b`
    const entries: SessionStoreEntry[] = [{ type: 'user', uuid: 'nul-2', text: preEscaped }]
    await store.append(key, entries)
    const loaded = await store.load(key)
    expect(loaded).toHaveLength(1)
    expect(loaded![0]!.text).toBe(preEscaped)
  })

  // Fix round 1 (CRITICAL 1): JSON.stringify doubles a content backslash, so a naive
  // "scrub the serialized JSON text" regex has to correctly count the length of the backslash run
  // immediately before a NUL's escape to tell a genuine escape from an escaped backslash followed by
  // ordinary text. Value-level scrubbing must get this right regardless of how many backslashes
  // happen to sit right before the NUL in the original string.
  it.each([1, 2, 3])('scrubs a NUL preceded by a run of %i backslash(es) in a string value', async (count) => {
    const store = createPgSessionStore(db)
    const run = BACKSLASH.repeat(count)
    const text = `C:${run}${NUL}temp`
    const entries: SessionStoreEntry[] = [{ type: 'user', uuid: `bs-run-${count}`, text }]
    await store.append(key, entries)
    const loaded = await store.load(key)
    expect(loaded).toHaveLength(1)
    expect(loaded![0]!.text).toBe(`C:${run}${REPLACEMENT_CHAR}temp`)
  })

  it('scrubs every NUL in a UTF-16LE-shaped string (alternating char + NUL, including one after a backslash)', async () => {
    const store = createPgSessionStore(db)
    // Simulates what you get from reading a UTF-16LE-encoded file (e.g. a Windows path) as if it
    // were single-byte text: every ASCII character is followed by a zero byte.
    const source = `C:${BACKSLASH}tmp`
    const utf16leShaped = [...source].map((ch) => `${ch}${NUL}`).join('')
    const entries: SessionStoreEntry[] = [{ type: 'user', uuid: 'utf16le-1', text: utf16leShaped }]
    await store.append(key, entries)
    const loaded = await store.load(key)
    expect(loaded).toHaveLength(1)
    const expected = [...source].map((ch) => `${ch}${REPLACEMENT_CHAR}`).join('')
    expect(loaded![0]!.text).toBe(expected)
  })

  it('scrubs a lone (unpaired) high surrogate', async () => {
    const store = createPgSessionStore(db)
    const entries: SessionStoreEntry[] = [{ type: 'user', uuid: 'surrogate-high', text: `a${LONE_HIGH_SURROGATE}b` }]
    await store.append(key, entries)
    const loaded = await store.load(key)
    expect(loaded).toHaveLength(1)
    expect(loaded![0]!.text).toBe(`a${REPLACEMENT_CHAR}b`)
  })

  it('scrubs a lone (unpaired) low surrogate', async () => {
    const store = createPgSessionStore(db)
    const entries: SessionStoreEntry[] = [{ type: 'user', uuid: 'surrogate-low', text: `a${LONE_LOW_SURROGATE}b` }]
    await store.append(key, entries)
    const loaded = await store.load(key)
    expect(loaded).toHaveLength(1)
    expect(loaded![0]!.text).toBe(`a${REPLACEMENT_CHAR}b`)
  })

  it('does not touch a properly paired surrogate (a real emoji)', async () => {
    const store = createPgSessionStore(db)
    const entries: SessionStoreEntry[] = [{ type: 'user', uuid: 'surrogate-pair', text: `a${EMOJI}b` }]
    await store.append(key, entries)
    const loaded = await store.load(key)
    expect(loaded).toHaveLength(1)
    expect(loaded![0]!.text).toBe(`a${EMOJI}b`)
  })

  // Fix round 1 (IMPORTANT 3): uuid must be read off the *scrubbed* entry, not the raw one, so the
  // dedup key always matches what's actually stored in the jsonb `entry` column.
  it('scrubs a NUL inside entry.uuid so the insert succeeds and the stored uuid column matches the scrubbed jsonb copy', async () => {
    const store = createPgSessionStore(db)
    const dirtyUuid = `id-${NUL}-1`
    const entries: SessionStoreEntry[] = [{ type: 'user', uuid: dirtyUuid, text: 'hello' }]
    await store.append(key, entries)

    const rows = await db
      .select({ uuid: agentSessionEntries.uuid, entry: agentSessionEntries.entry })
      .from(agentSessionEntries)
      .where(eq(agentSessionEntries.sessionId, key.sessionId))
    expect(rows).toHaveLength(1)

    const expectedUuid = `id-${REPLACEMENT_CHAR}-1`
    expect(rows[0]!.uuid).toBe(expectedUuid)
    expect((rows[0]!.entry as SessionStoreEntry).uuid).toBe(expectedUuid)
  })
})
