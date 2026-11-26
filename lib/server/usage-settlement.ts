export interface SettledUsage {
  costUsd: number
  tokens: number
}

export type BudgetSettler = (reservationId: string, costUsd: number, tokens: number) => Promise<void>

interface UsageLike {
  costUsd?: unknown
  promptTokens?: unknown
  completionTokens?: unknown
}

export function preserveUsageForSettlement(current: SettledUsage, error: unknown): SettledUsage {
  const candidate =
    typeof error === "object" && error !== null && "usage" in error
      ? (error as { usage?: UsageLike }).usage
      : undefined
  if (!candidate) return current

  const costUsd =
    typeof candidate.costUsd === "number" && Number.isFinite(candidate.costUsd) && candidate.costUsd >= 0
      ? candidate.costUsd
      : current.costUsd
  const tokens =
    typeof candidate.promptTokens === "number" &&
    Number.isFinite(candidate.promptTokens) &&
    candidate.promptTokens >= 0 &&
    typeof candidate.completionTokens === "number" &&
    Number.isFinite(candidate.completionTokens) &&
    candidate.completionTokens >= 0
      ? Math.trunc(candidate.promptTokens + candidate.completionTokens)
      : current.tokens

  return {
    costUsd: Math.max(current.costUsd, costUsd),
    tokens: Math.max(current.tokens, tokens),
  }
}

export async function settleBudgetUsage(
  reservationId: string,
  usage: SettledUsage,
  settle: BudgetSettler,
): Promise<void> {
  await settle(reservationId, usage.costUsd, usage.tokens)
}
