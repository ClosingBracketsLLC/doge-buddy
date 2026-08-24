import { adminSessions, createDb } from '@doge-buddy/db'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import {
  consumeLoginToken, createLoginToken, hashLoginToken, hashSessionToken,
  parseCookieHeader, serializeSessionCookie, validateSession,
} from '../src/http/admin/auth.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

describe('admin auth core', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  it('login and session hashes are domain-separated — one token never satisfies the other space', async () => {
    const token = 'shared-raw-token'
    expect(hashLoginToken(token)).not.toBe(hashSessionToken(token))
    expect(hashLoginToken(token)).toMatch(/^[a-f0-9]{64}$/)
  })

  it('createLoginToken -> consumeLoginToken round-trip mints a session and burns the login row', async () => {
    const token = await createLoginToken(db)
    const result = await consumeLoginToken(db, token)
    expect(result).not.toBeNull()
    expect(await validateSession(db, result!.sessionToken)).toBe(true)
    // burned: second consume fails
    expect(await consumeLoginToken(db, token)).toBeNull()
  })

  it('an unconsumed login token is NOT a valid session cookie', async () => {
    const token = await createLoginToken(db)
    expect(await validateSession(db, token)).toBe(false)
  })

  it('expired login rows do not consume; expired session rows do not validate and are purged on check', async () => {
    const token = await createLoginToken(db)
    await db.update(adminSessions).set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(adminSessions.tokenHash, hashLoginToken(token)))
    expect(await consumeLoginToken(db, token)).toBeNull()

    const live = await createLoginToken(db)
    const { sessionToken } = (await consumeLoginToken(db, live))!
    await db.update(adminSessions).set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(adminSessions.tokenHash, hashSessionToken(sessionToken)))
    expect(await validateSession(db, sessionToken)).toBe(false)
    const [gone] = await db.select().from(adminSessions)
      .where(eq(adminSessions.tokenHash, hashSessionToken(sessionToken)))
    expect(gone).toBeUndefined() // opportunistic purge
  })

  it('cookie round-trip: serialize carries the flags; parse extracts among other cookies', () => {
    const c = serializeSessionCookie('tok123')
    expect(c).toBe('db_admin=tok123; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=2592000')
    expect(parseCookieHeader('a=1; db_admin=tok123; b=2', 'db_admin')).toBe('tok123')
    expect(parseCookieHeader(undefined, 'db_admin')).toBeUndefined()
    expect(parseCookieHeader('a=1', 'db_admin')).toBeUndefined()
  })
})
