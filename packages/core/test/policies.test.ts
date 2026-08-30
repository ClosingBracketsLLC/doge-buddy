import { describe, expect, it } from 'vitest'
import { POLICY_COPY, policiesAsText } from '@doge-buddy/core'

const HANDLES = ['privacy', 'returns', 'shipping', 'terms']

describe('POLICY_COPY', () => {
  it('has the 4 expected policy handles', () => {
    expect(POLICY_COPY.map((p) => p.handle).sort()).toEqual(HANDLES)
  })

  it('returns policy states all-sales-final and the damage-claim window verbatim', () => {
    const returns = POLICY_COPY.find((p) => p.handle === 'returns')
    expect(returns).toBeDefined()
    const text = returns!.sections.flatMap((s) => s.paragraphs).join(' ')
    // Load-bearing: a no-refund policy is only enforceable in the US when conspicuously posted
    // (e.g. CA Civ. Code §1723, NY GBL §218-a) — the storefront renders this exact text.
    expect(text).toContain('All sales are final')
    expect(text).toContain('14 days of delivery')
    expect(text).not.toContain('prepaid return label')
  })

  it('every policy has a non-empty title and at least one section with paragraphs', () => {
    for (const policy of POLICY_COPY) {
      expect(policy.title.length).toBeGreaterThan(0)
      expect(policy.sections.length).toBeGreaterThan(0)
      for (const section of policy.sections) {
        expect(section.paragraphs.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('policiesAsText', () => {
  it('contains every paragraph of every policy exactly once', () => {
    const text = policiesAsText()
    for (const policy of POLICY_COPY) {
      for (const section of policy.sections) {
        for (const paragraph of section.paragraphs) {
          const occurrences = text.split(paragraph).length - 1
          expect(occurrences).toBe(1)
        }
      }
    }
  })
})
