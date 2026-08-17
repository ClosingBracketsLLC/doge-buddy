import { cjAuth, type createDb } from '@doge-buddy/db'
import type { CjTokenStore, StoredCjTokens } from '@doge-buddy/supplier'
import { eq } from 'drizzle-orm'

type Db = ReturnType<typeof createDb>['db']

/**
 * CjTokenStore backed by the single-row `cj_auth` table (id = 1). Persists CJ's access/refresh
 * tokens across restarts, unlike @doge-buddy/supplier's InMemoryCjTokenStore.
 */
export class DrizzleCjTokenStore implements CjTokenStore {
  constructor(private readonly db: Db) {}

  async load(): Promise<StoredCjTokens | null> {
    const [row] = await this.db.select().from(cjAuth).where(eq(cjAuth.id, 1))
    if (!row || !row.accessToken || !row.accessExpiresAt || !row.refreshToken || !row.refreshExpiresAt) {
      return null
    }
    return {
      accessToken: row.accessToken,
      accessExpiresAt: row.accessExpiresAt.toISOString(),
      refreshToken: row.refreshToken,
      refreshExpiresAt: row.refreshExpiresAt.toISOString(),
    }
  }

  async save(tokens: StoredCjTokens): Promise<void> {
    const values = {
      accessToken: tokens.accessToken,
      accessExpiresAt: new Date(tokens.accessExpiresAt),
      refreshToken: tokens.refreshToken,
      refreshExpiresAt: new Date(tokens.refreshExpiresAt),
    }

    await this.db
      .insert(cjAuth)
      .values({ id: 1, ...values })
      .onConflictDoUpdate({ target: cjAuth.id, set: values })
  }
}
