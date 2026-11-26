import assert from "node:assert/strict"
import test from "node:test"
import { preserveUsageForSettlement, settleBudgetUsage } from "../lib/server/usage-settlement"

test("audit failure usage increases the reservation settlement values", () => {
  const error = Object.assign(new Error("audit unavailable"), {
    usage: { costUsd: 0.012, promptTokens: 240, completionTokens: 60 },
  })
  assert.deepEqual(preserveUsageForSettlement({ costUsd: 0, tokens: 0 }, error), { costUsd: 0.012, tokens: 300 })
})

test("partial or malformed audit failure usage never releases already observed usage", () => {
  const observed = { costUsd: 0.02, tokens: 500 }
  assert.deepEqual(preserveUsageForSettlement(observed, new Error("audit unavailable")), observed)
  assert.deepEqual(
    preserveUsageForSettlement(observed, Object.assign(new Error("bad usage"), {
      usage: { costUsd: Number.NaN, promptTokens: 10, completionTokens: undefined },
    })),
    observed,
  )
})

test("settlement forwards preserved cost and token totals to budget persistence", async () => {
  const error = Object.assign(new Error("audit unavailable"), {
    usage: { costUsd: 0.008, promptTokens: 120, completionTokens: 30 },
  })
  const usage = preserveUsageForSettlement({ costUsd: 0, tokens: 0 }, error)
  let persisted: [string, number, number] | undefined

  await settleBudgetUsage("reservation-id", usage, async (...values) => {
    persisted = values
  })

  assert.deepEqual(persisted, ["reservation-id", 0.008, 150])
})
