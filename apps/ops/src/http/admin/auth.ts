import { createHash, randomBytes } from 'node:crypto'
import { adminSessions, auditLog, type createDb } from '@doge-buddy/db'
import { and, count, eq, gt, sql } from 'drizzle-orm'

type Db = ReturnType<typeof createDb>['db']

export const LOGIN_TOKEN_TTL_MS = 15 * 60_000
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000
export const LOGIN_SENDS_HOURLY_CAP = 5
export const SESSION_COOKIE = 'db_admin'

/**
 * Login and session tokens are domain-separated by prefix before hashing — mirrors
 * proposals/tokens.ts's `hashActionToken` — so a raw token from one space (e.g. a
 * still-live login token) can never be replayed as a valid hash in the other space.
 */
export function hashLoginToken(token: string): string {
  return createHash('sha256').update(`login:${token}`).digest('hex')
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(`session:${token}`).digest('hex')
}

/**
 * Creates a login row; returns the raw token for the link. Opportunistically purges every
 * expired `admin_sessions` row first (login rows AND session rows share the one table) — the
 * only writer on the wholly-unauthenticated `POST /admin/login` path, so without this the table
 * grows one row per anonymous send request forever. Bounds growth to one 15-minute
 * (`LOGIN_TOKEN_TTL_MS`) window's worth of unconsumed login rows between purges.
 */
export async function createLoginToken(db: Db): Promise<string> {
  await db.delete(adminSessions).where(sql`${adminSessions.expiresAt} < now()`)

  const token = randomBytes(32).toString('base64url')
  await db.insert(adminSessions).values({
    tokenHash: hashLoginToken(token),
    expiresAt: new Date(Date.now() + LOGIN_TOKEN_TTL_MS),
  })
  return token
}

/**
 * Deletes the matching unexpired login row and mints a session; null when invalid/expired.
 * Also opportunistically deletes all expired admin_sessions rows.
 */
export async function consumeLoginToken(db: Db, token: string): Promise<{ sessionToken: string } | null> {
  await db.delete(adminSessions).where(sql`${adminSessions.expiresAt} < now()`)

  const deleted = await db.delete(adminSessions)
    .where(and(eq(adminSessions.tokenHash, hashLoginToken(token)), gt(adminSessions.expiresAt, new Date())))
    .returning()
  if (deleted.length === 0) return null

  const sessionToken = randomBytes(32).toString('base64url')
  await db.insert(adminSessions).values({
    tokenHash: hashSessionToken(sessionToken),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  })
  return { sessionToken }
}

/**
 * True when the cookie's session hash matches an unexpired session row. The absent-token
 * check runs FIRST, before the opportunistic purge below — every unauthenticated request (no
 * cookie at all) hits this on every `onRequest` gate check, and without the early return each of
 * those probes would perform a real DB write (the purge DELETE) for no reason.
 */
export async function validateSession(db: Db, sessionToken: string | undefined): Promise<boolean> {
  if (!sessionToken) return false

  await db.delete(adminSessions).where(sql`${adminSessions.expiresAt} < now()`)

  const [row] = await db.select().from(adminSessions)
    .where(and(eq(adminSessions.tokenHash, hashSessionToken(sessionToken)), gt(adminSessions.expiresAt, new Date())))
  return row !== undefined
}

/** Counts audit rows admin.login_link_sent in the last hour. */
export async function loginSendsLastHour(db: Db): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(auditLog)
    .where(
      and(eq(auditLog.action, 'admin.login_link_sent'), gt(auditLog.createdAt, sql`now() - interval '1 hour'`)),
    )
  return row?.n ?? 0
}

export function serializeSessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=2592000`
}

/** Clears the session cookie client-side (Max-Age=0) — paired with deleting the matching
 * `admin_sessions` row server-side on `POST /admin/logout`. */
export function serializeLogoutCookie(): string {
  return `${SESSION_COOKIE}=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
}

export function parseCookieHeader(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  const prefix = `${name}=`
  for (const part of header.split('; ')) {
    if (part.startsWith(prefix)) return part.slice(prefix.length)
  }
  return undefined
}
