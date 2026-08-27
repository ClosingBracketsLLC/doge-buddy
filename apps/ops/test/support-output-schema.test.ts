import { describe, expect, it } from 'vitest'
import { SUPPORT_OUTPUT_JSON_SCHEMA, SupportOutputSchema } from '../src/agents/support-output-schema.ts'

describe('SupportOutputSchema', () => {
  it('round-trips a propose outcome with reply + refund + rationale', () => {
    const value = {
      outcome: 'propose',
      reply: { body: 'We are sorry for the trouble — your refund is being processed.' },
      refund: { amountCents: 1500, reason: 'damaged in transit', openCjDispute: false },
      rationale: 'Customer sent photos of a damaged item; refund is warranted.',
    }
    const result = SupportOutputSchema.safeParse(value)
    expect(result.success).toBe(true)
    expect(result.success && result.data).toEqual(value)
  })

  it('round-trips a propose outcome with reply only (no refund)', () => {
    const value = {
      outcome: 'propose',
      reply: { body: 'Here is the tracking info you asked for.' },
      rationale: 'Simple tracking question, no refund needed.',
    }
    const result = SupportOutputSchema.safeParse(value)
    expect(result.success).toBe(true)
    expect(result.success && result.data).toEqual(value)
  })

  it('round-trips an escalate outcome', () => {
    const value = {
      outcome: 'escalate',
      escalationReason: 'Customer is threatening legal action.',
      rationale: 'Legal threats are always escalated to a human per policy.',
    }
    const result = SupportOutputSchema.safeParse(value)
    expect(result.success).toBe(true)
    expect(result.success && result.data).toEqual(value)
  })

  it('round-trips a no_action outcome', () => {
    const value = {
      outcome: 'no_action',
      rationale: 'Thread was already resolved by an earlier message; nothing further to do.',
    }
    const result = SupportOutputSchema.safeParse(value)
    expect(result.success).toBe(true)
    expect(result.success && result.data).toEqual(value)
  })

  it('rejects a propose object missing reply, even when refund is present (refund only lives inside propose which requires reply)', () => {
    const value = {
      outcome: 'propose',
      refund: { amountCents: 1500, reason: 'damaged in transit', openCjDispute: false },
      rationale: 'Refund is warranted.',
      // no `reply` key at all
    }
    const result = SupportOutputSchema.safeParse(value)
    expect(result.success).toBe(false)
  })

  it('rejects an empty reply body', () => {
    const result = SupportOutputSchema.safeParse({
      outcome: 'propose',
      reply: { body: '' },
      rationale: 'x',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a reply body over 4000 chars', () => {
    const result = SupportOutputSchema.safeParse({
      outcome: 'propose',
      reply: { body: 'a'.repeat(4001) },
      rationale: 'x',
    })
    expect(result.success).toBe(false)
  })

  it('rejects an escalate outcome missing escalationReason', () => {
    const result = SupportOutputSchema.safeParse({
      outcome: 'escalate',
      rationale: 'x',
    })
    expect(result.success).toBe(false)
  })

  it('rejects an unknown outcome literal', () => {
    const result = SupportOutputSchema.safeParse({
      outcome: 'delete_everything',
      rationale: 'x',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a refund with a non-integer amountCents', () => {
    const result = SupportOutputSchema.safeParse({
      outcome: 'propose',
      reply: { body: 'ok' },
      refund: { amountCents: 15.5, reason: 'x', openCjDispute: false },
      rationale: 'x',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a refund with a non-positive amountCents', () => {
    const result = SupportOutputSchema.safeParse({
      outcome: 'propose',
      reply: { body: 'ok' },
      refund: { amountCents: 0, reason: 'x', openCjDispute: false },
      rationale: 'x',
    })
    expect(result.success).toBe(false)
  })

  it('accepts openCjDispute:true with cjDisputeReasonId present', () => {
    const result = SupportOutputSchema.safeParse({
      outcome: 'propose',
      reply: { body: 'ok' },
      refund: { amountCents: 500, reason: 'x', openCjDispute: true, cjDisputeReasonId: 'reason-1' },
      rationale: 'x',
    })
    expect(result.success).toBe(true)
  })

  it('rejects openCjDispute:true with no cjDisputeReasonId at the schema level', () => {
    const result = SupportOutputSchema.safeParse({
      outcome: 'propose',
      reply: { body: 'ok' },
      refund: { amountCents: 500, reason: 'x', openCjDispute: true },
      rationale: 'x',
    })
    expect(result.success).toBe(false)
  })
})

describe('SUPPORT_OUTPUT_JSON_SCHEMA', () => {
  const asString = JSON.stringify(SUPPORT_OUTPUT_JSON_SCHEMA)

  it('has no $ref anywhere (fully inlined, no $defs indirection)', () => {
    expect(asString).not.toContain('$ref')
  })

  it('does not declare the 2020-12 meta-schema', () => {
    const schemaField = (SUPPORT_OUTPUT_JSON_SCHEMA as { $schema?: string }).$schema
    expect(schemaField).not.toContain('2020-12')
  })

  it('is a draft-07 schema', () => {
    const schemaField = (SUPPORT_OUTPUT_JSON_SCHEMA as { $schema?: string }).$schema
    expect(schemaField).toContain('draft-07')
  })
})
