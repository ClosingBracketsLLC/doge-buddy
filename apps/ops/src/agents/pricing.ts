export const MODEL_PRICING_USD_PER_MTOK: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
}

export interface UsageTally {
  perModel: Record<
    string,
    {
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
    }
  >
  estimatedCostUsd: number
}

export function createUsageAccumulator(): {
  /** Feed every SDK assistant message; unknown models tally tokens at claude-sonnet-5 rates (conservative). */
  add(message: {
    message: {
      model?: string
      usage?: {
        input_tokens?: number
        output_tokens?: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
      }
    }
  }): void
  tally(): UsageTally
} {
  const perModel: Record<
    string,
    {
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
    }
  > = {}

  return {
    add(message) {
      const model = message.message.model ?? 'unknown'
      const usage = message.message.usage

      // No-op if no usage
      if (!usage) {
        return
      }

      const inputTokens = usage.input_tokens ?? 0
      const outputTokens = usage.output_tokens ?? 0
      const cacheReadTokens = usage.cache_read_input_tokens ?? 0
      const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0

      if (!perModel[model]) {
        perModel[model] = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }
      }

      perModel[model].inputTokens += inputTokens
      perModel[model].outputTokens += outputTokens
      perModel[model].cacheReadTokens += cacheReadTokens
      perModel[model].cacheWriteTokens += cacheWriteTokens
    },

    tally(): UsageTally {
      let estimatedCostUsd = 0

      for (const [model, tokens] of Object.entries(perModel)) {
        // Get pricing for the model, default to claude-sonnet-5 rates for unknown models
        const pricing = MODEL_PRICING_USD_PER_MTOK[model]
        const modelPricing =
          pricing || MODEL_PRICING_USD_PER_MTOK['claude-sonnet-5']

        if (!modelPricing) {
          // Should never happen since claude-sonnet-5 is always defined, but be explicit
          continue
        }

        const modelCost =
          (tokens.inputTokens * modelPricing.input +
            tokens.outputTokens * modelPricing.output +
            tokens.cacheReadTokens * modelPricing.cacheRead +
            tokens.cacheWriteTokens * modelPricing.cacheWrite) /
          1_000_000

        estimatedCostUsd += modelCost
      }

      return {
        perModel,
        estimatedCostUsd,
      }
    },
  }
}
