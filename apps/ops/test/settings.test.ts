import { createDb, settings as settingsTable } from '@doge-buddy/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createSettings, SETTINGS_DEFAULTS, type SettingKey } from '../src/settings.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

describe('settings', () => {
  const { db, pool } = createDb(url)

  beforeEach(async () => {
    await db.delete(settingsTable)
  })
  afterAll(() => pool.end())

  it('returns the code default when no row exists', async () => {
    const s = createSettings(db)
    expect(await s.get('fulfillment.spend_cap_per_order_cents')).toBe(7500)
    expect(await s.get('killswitch.global')).toBe(false)
  })

  it('set() upserts and get() returns the stored value', async () => {
    const s = createSettings(db)
    await s.set('killswitch.global', true)
    expect(await s.get('killswitch.global')).toBe(true)
    await s.set('killswitch.global', false)
    expect(await s.get('killswitch.global')).toBe(false)
  })

  it('returns the code default for every defined settings key when no row exists', async () => {
    const s = createSettings(db)
    for (const key of Object.keys(SETTINGS_DEFAULTS) as SettingKey[]) {
      expect(await s.get(key)).toBe(SETTINGS_DEFAULTS[key])
    }
  })

  it('set() on a numeric key upserts without creating duplicate rows', async () => {
    const s = createSettings(db)
    await s.set('fulfillment.wallet_alert_threshold_cents', 5000)
    await s.set('fulfillment.wallet_alert_threshold_cents', 3000)
    expect(await s.get('fulfillment.wallet_alert_threshold_cents')).toBe(3000)

    const rows = await db.select().from(settingsTable)
    expect(rows).toHaveLength(1)
  })

  it('defaults every workflow mode to manual and refund.auto_max_cents to 2500', async () => {
    const s = createSettings(db)
    expect(await s.get('workflow.sourcing.mode')).toBe('manual')
    expect(await s.get('workflow.support_reply.mode')).toBe('manual')
    expect(await s.get('workflow.refund.mode')).toBe('manual')
    expect(await s.get('workflow.deprecation.mode')).toBe('manual')
    expect(await s.get('refund.auto_max_cents')).toBe(2500)
  })

  it('defaults workflow.support.enabled to true', async () => {
    const s = createSettings(db)
    expect(await s.get('workflow.support.enabled')).toBe(true)
  })

  it('round-trips a mode value as a typed string', async () => {
    const s = createSettings(db)
    await s.set('workflow.sourcing.mode', 'auto')
    expect(await s.get('workflow.sourcing.mode')).toBe('auto')
    await s.set('workflow.sourcing.mode', 'manual') // restore for rerun safety
  })
})
