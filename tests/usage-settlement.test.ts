import assert from "node:assert/strict"
import test from "node:test"
import { preserveUsageForSettlement, settleBudgetUsage } from "../lib/server/usage-settlement"

test("audit failure usage increases the reservation settlement values", () => {
  const error = Object.assign(new Error("audit unavailable"), {
    usage: { costUsd: 0.012, promptTokens: 240, completionTokens: 60 },
  })
  assert.deepEqual(preserveUsageForSettlement({ costUsd: 0, tokens: 0, usageKnown: false }, error), { costUsd: 0.012, tokens: 300, usageKnown: true })
})

test("partial or malformed audit failure usage never releases already observed usage", () => {
  const observed = { costUsd: 0.02, tokens: 500, usageKnown: true }
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
  const usage = preserveUsageForSettlement({ costUsd: 0, tokens: 0, usageKnown: false }, error)
  let persisted: [string, number, number, boolean?] | undefined

  await settleBudgetUsage("reservation-id", usage, async (...values) => {
    persisted = values
  })

  assert.deepEqual(persisted, ["reservation-id", 0.008, 150, true])
})

test("negative, incomplete, and unknown snapshots do not become zero-cost settlements", () => {
  const negative = Object.assign(new Error("negative usage"), {
    usage: { costUsd: -1, promptTokens: -20, completionTokens: undefined },
  })
  assert.deepEqual(
    preserveUsageForSettlement({ costUsd: 0.03, tokens: 400, usageKnown: true }, negative),
    { costUsd: 0.03, tokens: 400, usageKnown: true },
  )

  assert.deepEqual(
    preserveUsageForSettlement({ costUsd: 0, tokens: 0, usageKnown: false }, new Error("provider did not return usage")),
    { costUsd: 0, tokens: 0, usageKnown: false },
  )

  const partial = Object.assign(new Error("partial usage"), {
    usage: { costUsd: 0.001, promptTokens: 80, completionTokens: undefined },
  })
  assert.deepEqual(
    preserveUsageForSettlement({ costUsd: 0, tokens: 0, usageKnown: false }, partial),
    { costUsd: 0.001, tokens: 80, usageKnown: false },
  )
  assert.deepEqual(
    preserveUsageForSettlement({ costUsd: -2, tokens: -5, usageKnown: true }, new Error("invalid current")),
    { costUsd: 0, tokens: 0, usageKnown: false },
  )
  assert.deepEqual(
    preserveUsageForSettlement({ costUsd: 0.02, tokens: 500, usageKnown: true },
      Object.assign(new Error("partial"), { usage: { promptTokens: 600 } })),
    { costUsd: 0.02, tokens: 600, usageKnown: false },
  )
})

test("unknown usage keeps the budget reservation instead of settling as free", async () => {
  let args: [string, number, number, boolean?] | undefined
  await settleBudgetUsage(
    "reservation-id",
    { costUsd: 0, tokens: 0, usageKnown: false },
    async (...values) => { args = values },
  )
  assert.deepEqual(args, ["reservation-id", 0, 0, false])
})
