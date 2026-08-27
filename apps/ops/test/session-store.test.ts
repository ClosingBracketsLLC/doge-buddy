import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { agentSessionEntries, createDb } from '@doge-buddy/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPgSessionStore, SUPPORT_PROJECT_KEY } from '../src/agents/session-store.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

// Built via String.fromCharCode rather than string-literal escapes so the source file never has to
// carry an actual NUL byte, nor a hand-typed backslash-escape look-alike that tooling could mangle.
const NUL = String.fromCharCode(0)
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd)
const BACKSLASH = String.fromCharCode(0x5c)

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
})
