import { describe, expect, it } from 'vitest'
import { POLICY_COPY, policiesAsText } from '@doge-buddy/core'

const HANDLES = ['privacy', 'returns', 'shipping', 'terms']

describe('POLICY_COPY', () => {
  it('has the 4 expected policy handles', () => {
    expect(POLICY_COPY.map((p) => p.handle).sort()).toEqual(HANDLES)
  })

  it('returns policy text contains the delivery and refund windows verbatim', () => {
    const returns = POLICY_COPY.find((p) => p.handle === 'returns')
    expect(returns).toBeDefined()
    const text = returns!.sections.flatMap((s) => s.paragraphs).join(' ')
    expect(text).toContain('30 days of delivery')
    expect(text).toContain('5–10 business days')
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
