import type { ModelId, Usage } from "./types"

/** USD per 1M tokens, peak rates from api-docs.deepseek.com (checked 2026-11). */
const PEAK_PRICES: Record<ModelId, { hit: number; miss: number; output: number }> = {
  "deepseek-flash": { hit: 0.006, miss: 0.3, output: 1.2 },
  "deepseek-v4-pro": { hit: 0.044, miss: 1.32, output: 3.96 },
}

export const MODEL_LABELS: Record<ModelId, string> = {
  "deepseek-flash": "DeepSeek Flash (výchozí, levný)",
  "deepseek-v4-pro": "DeepSeek V4 Pro (pokročilé uvažování)",
}

/** Peak hours: 01–04 and 06–10 UTC, Monday–Friday. Off-peak is half price. */
export function isPeak(date = new Date()): boolean {
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return false
  const h = date.getUTCHours()
  return (h >= 1 && h < 4) || (h >= 6 && h < 10)
}

export function estimateCost(
  model: ModelId,
  promptTokens: number,
  completionTokens: number,
  cacheHitTokens = 0,
  date = new Date(),
): number {
  const p = PEAK_PRICES[model]
  const factor = isPeak(date) ? 1 : 0.5
  const miss = Math.max(0, promptTokens - cacheHitTokens)
  return ((cacheHitTokens * p.hit + miss * p.miss + completionTokens * p.output) / 1_000_000) * factor
}

/** Conservative upper bound used before a call is made, always at peak rates. */
export function worstCaseCost(model: ModelId, promptTokens: number, maxCompletion: number): number {
  const p = PEAK_PRICES[model]
  return (promptTokens * p.miss + maxCompletion * p.output) / 1_000_000
}

export function emptyUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 }
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cacheHitTokens: a.cacheHitTokens + b.cacheHitTokens,
    costUsd: a.costUsd + b.costUsd,
  }
}

export function formatUsd(value: number): string {
  if (value === 0) return "$0"
  if (value < 0.01) return `$${value.toFixed(5)}`
  return `$${value.toFixed(3)}`
}
