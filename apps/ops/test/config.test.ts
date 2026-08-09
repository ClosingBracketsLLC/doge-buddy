import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

describe('loadConfig', () => {
  it('parses a valid environment with defaults', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d' })
    expect(c).toEqual({ databaseUrl: 'postgres://u:p@h:5432/d', port: 3001, host: '0.0.0.0' })
  })
  it('honors PORT override', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d', PORT: '8080' }).port).toBe(8080)
  })
  it('throws a readable error when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/)
  })
})
