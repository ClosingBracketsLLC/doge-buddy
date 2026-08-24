import { createHash, randomBytes } from 'node:crypto'

/**
 * One-click action token: 32 random bytes, base64url. Only the DOMAIN-SEPARATED sha256
 * (`'action:' + token`) is ever stored — Plan B's login/session tokens hash under 'login:' /
 * 'session:' so the three kinds can never satisfy each other's lookups.
 */
export function hashActionToken(token: string): string {
  return createHash('sha256').update(`action:${token}`).digest('hex')
}

export function generateActionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashActionToken(token) }
}
