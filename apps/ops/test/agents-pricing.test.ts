import { describe, it, expect } from 'vitest'
import { MODEL_PRICING_USD_PER_MTOK, createUsageAccumulator } from '../src/agents/pricing.js'

describe('agents/pricing', () => {
  describe('MODEL_PRICING_USD_PER_MTOK', () => {
    it('has claude-sonnet-5 pricing', () => {
      expect(MODEL_PRICING_USD_PER_MTOK['claude-sonnet-5']).toEqual({
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 3.75,
      })
    })
  })

  describe('createUsageAccumulator', () => {
    it('sums tokens from multiple messages for the same model', () => {
      const acc = createUsageAccumulator()

      // Two messages for claude-sonnet-5
      acc.add({
        message: {
          model: 'claude-sonnet-5',
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_input_tokens: 2000,
            cache_creation_input_tokens: 0,
          },
        },
      })

      acc.add({
        message: {
          model: 'claude-sonnet-5',
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_input_tokens: 2000,
            cache_creation_input_tokens: 0,
          },
        },
      })

      const tally = acc.tally()

      // Verify tokens are summed
      expect(tally.perModel['claude-sonnet-5']).toEqual({
        inputTokens: 2000,
        outputTokens: 1000,
        cacheReadTokens: 4000,
        cacheWriteTokens: 0,
      })

      // Verify cost calculation: 2 × (1000×3 + 500×15 + 2000×0.3) / 1e6
      // = 2 × (3000 + 7500 + 600) / 1e6
      // = 2 × 11100 / 1e6
      // = 22200 / 1e6
      // = 0.0222
      expect(tally.estimatedCostUsd).toBeCloseTo(0.0222, 6)
    })

    it('handles message with no usage as a no-op', () => {
      const acc = createUsageAccumulator()

      acc.add({
        message: {
          model: 'claude-sonnet-5',
          usage: undefined,
        },
      })

      const tally = acc.tally()

      expect(tally.perModel['claude-sonnet-5']).toBeUndefined()
      expect(tally.estimatedCostUsd).toBe(0)
    })

    it('tallies unknown models under their own key at sonnet rates', () => {
      const acc = createUsageAccumulator()

      acc.add({
        message: {
          model: 'claude-opus-5',
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      })

      const tally = acc.tally()

      // Unknown model should tally under its own key
      expect(tally.perModel['claude-opus-5']).toEqual({
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      })

      // Cost should be at sonnet rates
      // (1000×3 + 500×15 + 0×0.3 + 0×3.75) / 1e6
      // = (3000 + 7500) / 1e6
      // = 10500 / 1e6
      // = 0.0105
      expect(tally.estimatedCostUsd).toBeCloseTo(0.0105, 6)
    })

    it('handles cache write tokens', () => {
      const acc = createUsageAccumulator()

      acc.add({
        message: {
          model: 'claude-sonnet-5',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 1000,
          },
        },
      })

      const tally = acc.tally()

      expect(tally.perModel['claude-sonnet-5']).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 1000,
      })

      // (0×3 + 0×15 + 0×0.3 + 1000×3.75) / 1e6
      // = 3750 / 1e6
      // = 0.00375
      expect(tally.estimatedCostUsd).toBeCloseTo(0.00375, 6)
    })

    it('mixes known and unknown models in cost calculation', () => {
      const acc = createUsageAccumulator()

      // Known model
      acc.add({
        message: {
          model: 'claude-sonnet-5',
          usage: {
            input_tokens: 1000,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      })

      // Unknown model
      acc.add({
        message: {
          model: 'claude-opus-5',
          usage: {
            input_tokens: 1000,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      })

      const tally = acc.tally()

      expect(tally.perModel['claude-sonnet-5']).toEqual({
        inputTokens: 1000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      })

      expect(tally.perModel['claude-opus-5']).toEqual({
        inputTokens: 1000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      })

      // Total: (1000×3 + 1000×3) / 1e6 = 6000 / 1e6 = 0.006
      expect(tally.estimatedCostUsd).toBeCloseTo(0.006, 6)
    })
  })
})
