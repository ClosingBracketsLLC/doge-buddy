import { type createDb, settings } from '@doge-buddy/db'
import { eq } from 'drizzle-orm'

export type WorkflowMode = 'manual' | 'auto'

/**
 * Code defaults for every known setting, keyed exactly as stored in the `settings` table.
 * `createSettings(db).get()` falls back to these when no row is present, so the system
 * behaves correctly even before an operator has ever touched a setting.
 */
export const SETTINGS_DEFAULTS = {
  'killswitch.global': false,
  'workflow.fulfillment.enabled': true,
  'fulfillment.paused_for_funds': false,
  'fulfillment.spend_cap_per_order_cents': 7500,
  'fulfillment.wallet_alert_threshold_cents': 2000,
  'fulfillment.margin_floor_bps': 6000,
  'fulfillment.promised_max_days': 7,
  'workflow.sourcing.mode': 'manual',
  'workflow.support_reply.mode': 'manual',
  'workflow.refund.mode': 'manual',
  'workflow.deprecation.mode': 'manual',
  'refund.auto_max_cents': 2500,
}
// Deliberately no `as const`/`satisfies` here: either narrows the boolean properties down
// to their literal default (e.g. `false` instead of `boolean`), which would make `set()`
// reject the other value of that same boolean. The keys below are the source of truth for
// which settings are booleans; modes are `WorkflowMode` strings; everything else is a number (cents/bps/days).

export type SettingKey = keyof typeof SETTINGS_DEFAULTS
type BooleanSettingKey = 'killswitch.global' | 'workflow.fulfillment.enabled' | 'fulfillment.paused_for_funds'
type ModeSettingKey =
  | 'workflow.sourcing.mode'
  | 'workflow.support_reply.mode'
  | 'workflow.refund.mode'
  | 'workflow.deprecation.mode'
export type SettingValue<K extends SettingKey> = K extends BooleanSettingKey
  ? boolean
  : K extends ModeSettingKey
    ? WorkflowMode
    : number

type Db = ReturnType<typeof createDb>['db']

export interface Settings {
  /** Returns the stored value for `key`, or the code default when no row exists yet. */
  get<K extends SettingKey>(key: K): Promise<SettingValue<K>>
  /** Upserts `value` for `key`. */
  set<K extends SettingKey>(key: K, value: SettingValue<K>): Promise<void>
}

/** Typed accessor over the `settings` table. Reads fresh from the DB every call — no caching. */
export function createSettings(db: Db): Settings {
  return {
    async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
      const [row] = await db.select().from(settings).where(eq(settings.key, key))
      if (!row) return SETTINGS_DEFAULTS[key] as unknown as SettingValue<K>
      return row.value as unknown as SettingValue<K>
    },
    async set<K extends SettingKey>(key: K, value: SettingValue<K>): Promise<void> {
      await db
        .insert(settings)
        .values({ key, value })
        .onConflictDoUpdate({ target: settings.key, set: { value } })
    },
  }
}
