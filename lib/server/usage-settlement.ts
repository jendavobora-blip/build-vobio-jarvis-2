export interface SettledUsage {
  costUsd: number
  tokens: number
  usageKnown: boolean
}

export type BudgetSettler = (reservationId: string, costUsd: number, tokens: number, usageKnown?: boolean) => Promise<void>

interface UsageLike {
  costUsd?: unknown
  promptTokens?: unknown
  completionTokens?: unknown
}

export function preserveUsageForSettlement(current: SettledUsage, error: unknown): SettledUsage {
  const valid = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
  const normalized: SettledUsage = {
    costUsd: valid(current.costUsd) ? current.costUsd : 0,
    tokens: valid(current.tokens) ? Math.trunc(current.tokens) : 0,
    usageKnown: current.usageKnown && valid(current.costUsd) && valid(current.tokens),
  }
  const candidate =
    typeof error === "object" && error !== null && "usage" in error
      ? (error as { usage?: UsageLike }).usage
      : undefined
  if (!candidate || typeof candidate !== "object") return normalized

  const costValid = valid(candidate.costUsd)
  const promptValid = valid(candidate.promptTokens)
  const completionValid = valid(candidate.completionTokens)
  const candidateTokens = promptValid && completionValid
    ? Math.trunc((candidate.promptTokens as number) + (candidate.completionTokens as number))
    : promptValid || completionValid
      ? Math.trunc((promptValid ? candidate.promptTokens as number : 0) + (completionValid ? candidate.completionTokens as number : 0))
      : normalized.tokens

  return {
    costUsd: Math.max(normalized.costUsd, costValid ? candidate.costUsd as number : 0),
    tokens: Math.max(normalized.tokens, candidateTokens),
    usageKnown: costValid && promptValid && completionValid
      ? true
      : normalized.usageKnown && (!costValid || (candidate.costUsd as number) <= normalized.costUsd) &&
        candidateTokens <= normalized.tokens,
  }
}

export async function settleBudgetUsage(
  reservationId: string,
  usage: SettledUsage,
  settle: BudgetSettler,
): Promise<void> {
  await settle(reservationId, usage.costUsd, usage.tokens, usage.usageKnown)
}
