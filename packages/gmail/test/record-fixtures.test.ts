import { describe, expect, it } from 'vitest'
import { assertScrubbed, RECORDED_FIXTURE_NAMES } from '../scripts/record-fixtures.ts'

// Unit coverage for the scrub-assertion the recorder runs on every captured fixture right before
// writing it to disk. This is defense-in-depth on top of the recorder's structural scrub (fixture
// files never carry a headers field, so Authorization is excluded by construction) — it exists to
// catch anything unexpected: a response body that happens to echo a header, or a raw string
// leaking a bearer token or private key material from somewhere the structural exclusion can't
// see. Binding contract (6A): no fixture file may ever contain "Bearer " or "PRIVATE KEY".
describe('assertScrubbed', () => {
  it('passes clean fixtures through without throwing', () => {
    expect(() =>
      assertScrubbed([
        {
          name: 'profile.json',
          fixture: {
            request: { method: 'GET', path: '/gmail/v1/users/me/profile' },
            response: { status: 200, body: { emailAddress: 'admin@dogebuddy.com', historyId: '3025' } },
          },
        },
      ]),
    ).not.toThrow()
  })

  it('throws listing the offending file when a fixture nests an Authorization: Bearer header anywhere', () => {
    expect(() =>
      assertScrubbed([
        {
          name: 'leaky.json',
          fixture: {
            request: { method: 'GET', path: '/x', headers: { Authorization: 'Bearer abc123' } },
            response: { status: 200, body: {} },
          },
        },
      ]),
    ).toThrow(/leaky\.json/)
  })

  it('throws when a fixture value contains a bare "Bearer " substring even without an Authorization key', () => {
    expect(() =>
      assertScrubbed([{ name: 'echo.json', fixture: { response: { status: 200, body: { note: 'send as Bearer xyz' } } } }]),
    ).toThrow(/echo\.json/)
  })

  it('throws when a fixture value contains PRIVATE KEY material', () => {
    expect(() =>
      assertScrubbed([
        { name: 'key-leak.json', fixture: { response: { status: 200, body: { note: '-----BEGIN PRIVATE KEY-----' } } } },
      ]),
    ).toThrow(/key-leak\.json/)
  })

  it('lists every offending file, not just the first, when multiple fixtures leak', () => {
    expect(() =>
      assertScrubbed([
        { name: 'a.json', fixture: { body: 'Bearer nope' } },
        { name: 'b.json', fixture: { body: 'clean' } },
        { name: 'c.json', fixture: { body: '-----BEGIN PRIVATE KEY-----' } },
      ]),
    ).toThrow(/a\.json[\s\S]*c\.json|c\.json[\s\S]*a\.json/)
  })
})

// FR9: the two new-in-6B normalized fields (authenticationResults, the proposal marker) were backed
// only by hand-authored fixtures, so a live re-record could never validate them against real Gmail.
// The recorder now records a metadata fetch of a message carrying Authentication-Results (the money
// gate's input). The proposal marker stays hand-authored on purpose — it only rides OUR sends, which
// the recorder never performs — so it is verified live via the OWNER-CHECKLIST Tier-2 walk instead.
describe('recorded fixture list (FR9)', () => {
  it('includes the Authentication-Results metadata case (the refund money-gate input)', () => {
    expect(RECORDED_FIXTURE_NAMES).toContain('message-metadata-auth-results.json')
  })

  it('does NOT record the proposal-marker fixture (marker rides only our own sends)', () => {
    expect(RECORDED_FIXTURE_NAMES).not.toContain('message-metadata-proposal-marker.json')
  })

  it('records the two real shapes the first live run exposed: the empty history page and an attachment-only message', () => {
    expect(RECORDED_FIXTURE_NAMES).toContain('history-empty.json')
    expect(RECORDED_FIXTURE_NAMES).toContain('message-full-attachment-only.json')
  })

  it('leaves the hand-authored pagination pair alone (a real mailbox cannot be made to paginate on demand)', () => {
    expect(RECORDED_FIXTURE_NAMES).not.toContain('history-paged-1.json')
    expect(RECORDED_FIXTURE_NAMES).not.toContain('history-paged-2.json')
  })

  it('the recorded-name list still passes the scrub contract shape (no forbidden material in names)', () => {
    expect(() =>
      assertScrubbed(RECORDED_FIXTURE_NAMES.map((name) => ({ name, fixture: { response: { status: 200, body: {} } } }))),
    ).not.toThrow()
  })
})
